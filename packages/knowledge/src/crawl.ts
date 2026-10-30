import * as cheerio from 'cheerio';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { chunkText } from './chunk.ts';
import { ExtractError } from './extract.ts';

export interface CrawlOptions {
  maxPages: number;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Checks a host before fetching. Defaults to refusing private and local addresses. */
  checkHost?: (hostname: string) => Promise<void>;
}

export interface CrawledPage {
  url: string;
  title: string;
  text: string;
}

const SKIP_EXT = /\.(jpe?g|png|gif|webp|svg|ico|pdf|zip|rar|mp4|mp3|css|js|json|xml)$/i;

/**
 * Breadth-first crawl of one site, same origin only, up to maxPages HTML
 * pages. Pages that fail are skipped; the crawl fails only if none succeed.
 */
export async function crawlSite(startUrl: string, options: CrawlOptions): Promise<CrawledPage[]> {
  const fetchImpl = options.fetch ?? fetch;
  const start = new URL(startUrl);
  if (start.protocol !== 'https:' && start.protocol !== 'http:') throw new ExtractError('The website address must start with http or https.');
  // Shops type this URL, so never let it reach our own network (Redis, Postgres, cloud metadata).
  await (options.checkHost ?? assertPublicHost)(start.hostname);

  const queue = [normaliseUrl(start)];
  const seen = new Set(queue);
  const pages: CrawledPage[] = [];
  let lastError = '';

  while (queue.length && pages.length < options.maxPages) {
    const url = queue.shift()!;
    try {
      const res = await fetchImpl(url, {
        headers: { 'user-agent': 'AgentlyBot/1.0 (+knowledge base crawler)', accept: 'text/html' },
        // Redirects are queued like links, so they get the same origin check.
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      const page = location
        ? { links: [location] }
        : res.ok && (res.headers.get('content-type') ?? '').includes('text/html')
          ? readPage(await res.text(), url)
          : null;
      if (!page) continue;
      if ('text' in page && page.text.length >= 50) pages.push({ url: page.url, title: page.title, text: page.text });

      for (const link of page.links) {
        let next: URL;
        try {
          next = new URL(link, url);
        } catch {
          continue;
        }
        if (next.origin !== start.origin || SKIP_EXT.test(next.pathname)) continue;
        const key = normaliseUrl(next);
        if (!seen.has(key)) {
          seen.add(key);
          queue.push(key);
        }
      }
    } catch (err) {
      lastError = (err as Error).message;
    }
  }

  if (pages.length === 0) throw new ExtractError(`Could not read any pages from ${start.origin}${lastError ? `: ${lastError}` : ''}`);
  return pages;
}

/** Page text with navigation, scripts and footers removed, plus its links. */
export function readPage(html: string, url: string): CrawledPage & { links: string[] } {
  const $ = cheerio.load(html);
  const links = $('a[href]')
    .map((_, a) => $(a).attr('href') ?? '')
    .get()
    .filter((h) => h && !h.startsWith('#') && !h.startsWith('mailto:') && !h.startsWith('tel:'));
  $('script, style, noscript, svg, iframe, nav, header, footer, form, [aria-hidden="true"]').remove();
  const title = $('title').first().text().trim();
  const root = $('main').length ? $('main') : $('body');
  // Put block elements on their own lines so paragraphs survive .text().
  root.find('p, div, li, h1, h2, h3, h4, h5, h6, br, tr, section, article').each((_, el) => {
    $(el).append('\n');
  });
  const text = root
    .text()
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return { url, title, text, links };
}

/** Throws unless every address the host resolves to is public. */
export async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new ExtractError(`${hostname} is not a public website address.`);
  }
}

export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

/** Pages as chunks, each starting with its title so a chunk says where it came from. */
export function chunkPages(pages: CrawledPage[]): string[] {
  return pages.flatMap((p) => chunkText(p.text).map((c) => (p.title ? `${p.title}\n${c}` : c)));
}

function normaliseUrl(u: URL): string {
  const copy = new URL(u.href);
  copy.hash = '';
  // Tracking parameters create endless duplicate pages.
  for (const key of [...copy.searchParams.keys()]) {
    if (key.startsWith('utm_') || key === 'fbclid') copy.searchParams.delete(key);
  }
  return copy.href.replace(/\/$/, '');
}
