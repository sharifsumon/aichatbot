import { and, eq, ne } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { channels, products, type Db } from '@agently/db';
import { isUuid } from './guard.ts';

export interface ShareDeps {
  db: Db;
  urls: { api: string };
}

/** Link-preview crawlers read the page; everyone else is sent on at once. */
const CRAWLER = /facebookexternalhit|facebot|facebookcatalog|meta-externalagent|twitterbot|whatsapp|telegrambot|slackbot|linkedinbot/i;

/**
 * Public product page for Facebook posts with a real button. Facebook only
 * puts a button on a post that links to a web page, and shows that page's
 * picture. This page gives Facebook the catalog photo, name and price, and
 * sends people who open it to the product on the shop's website, or to
 * Messenger when the product has no website page.
 */
export const shareRoutes: FastifyPluginAsync<ShareDeps> = async (app, { db, urls }) => {
  app.get<{ Params: { productId: string }; Querystring: { photo?: string } }>('/share/products/:productId', async (req, reply) => {
    const { productId } = req.params;
    if (!isUuid(productId)) return reply.code(404).type('text/plain').send('Not found');
    const product = await db.query.products.findFirst({ where: and(eq(products.id, productId), ne(products.status, 'archived')) });
    if (!product) return reply.code(404).type('text/plain').send('Not found');

    const page = await db.query.channels.findFirst({
      where: and(eq(channels.workspaceId, product.workspaceId), eq(channels.type, 'facebook_page'), eq(channels.status, 'connected')),
    });
    const target = product.websiteUrl ?? (page ? shareMessengerLink(page.externalId, product.id) : null);

    if (target && !CRAWLER.test(req.headers['user-agent'] ?? '')) return reply.code(302).header('location', target).send();
    // No meta refresh here: Facebook's crawler follows it and would show the
    // target's preview (e.g. the Messenger greeting card) instead of this product.

    const index = Number.parseInt(req.query.photo ?? '0', 10);
    const image = product.images[Number.isInteger(index) && index >= 0 ? index : 0]?.url ?? product.imageUrl;
    const self = `${urls.api.replace(/\/$/, '')}/share/products/${product.id}${req.query.photo ? `?photo=${encodeURIComponent(req.query.photo)}` : ''}`;
    const title = `${product.title} · ৳${Number(product.price).toLocaleString('en')}`;
    const description = product.description.slice(0, 300);
    const meta = [
      ['og:type', 'product'],
      ['og:title', title],
      ['og:description', description],
      ['og:url', self],
      ...(image ? [['og:image', image]] : []),
    ];
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
${meta.map(([k, v]) => `<meta property="${k}" content="${esc(v!)}">`).join('\n')}
</head><body style="font-family:system-ui,sans-serif;max-width:480px;margin:40px auto;padding:0 16px">
${image ? `<img src="${esc(image)}" alt="" style="width:100%;border-radius:12px">` : ''}
<h1 style="font-size:20px">${esc(title)}</h1><p>${esc(description)}</p>
${target ? `<p><a href="${esc(target)}">Order now</a></p>` : ''}
</body></html>`;
    return reply.header('cache-control', 'public, max-age=300').type('text/html; charset=utf-8').send(html);
  });
};

const shareMessengerLink = (pageId: string, productId: string) => `https://m.me/${encodeURIComponent(pageId)}?ref=product_${productId}`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The share page's address for a post, showing the product's photo at `photo` (an index into its photos). */
export const shareUrl = (apiUrl: string, productId: string, photo = 0) =>
  `${apiUrl.replace(/\/$/, '')}/share/products/${productId}${photo ? `?photo=${photo}` : ''}`;
