import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { chunkFile, chunkCsv, googleSheetCsvUrl, ExtractError } from './extract.ts';
import { chunkLines, chunkQa, chunkText } from './chunk.ts';
import { assertPublicHost, crawlSite, isPrivateAddress, readPage } from './crawl.ts';

test('chunks Bangla and English text within the size limit', () => {
  const bangla = 'আমরা সারা দেশে ডেলিভারি করি। ঢাকার ভেতরে ডেলিভারি চার্জ ৬০ টাকা। '.repeat(60);
  const english = 'We deliver all over Bangladesh. Returns are accepted within 7 days. '.repeat(60);
  for (const text of [bangla, english, `${bangla}\n\n${english}`]) {
    const chunks = chunkText(text, { maxChars: 500 });
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((c) => c.length <= 500), `max ${Math.max(...chunks.map((c) => c.length))}`);
  }
  // Bangla is split at the danda, not mid-sentence.
  assert.ok(chunkText(bangla, { maxChars: 500, overlap: 0 }).every((c) => c.endsWith('।')));
});

test('keeps short text as one chunk and drops empty input', () => {
  assert.deepEqual(chunkText('  Hello\n\n\nworld  '), ['Hello\n\nworld']);
  assert.deepEqual(chunkText('   '), []);
});

test('Q&A pairs stay whole; table rows are never split', () => {
  assert.deepEqual(chunkQa([{ question: 'COD?', answer: 'Yes' }, { question: '', answer: 'x' }]), ['Q: COD?\nA: Yes']);
  const rows = Array.from({ length: 50 }, (_, i) => `Code: SH-${i}; Price: ${800 + i}`);
  const chunks = chunkLines(rows, 300);
  assert.ok(chunks.every((c) => c.length <= 300));
  assert.equal(chunks.join('\n').split('\n').length, 50);
});

test('CSV and TXT files', async () => {
  const csv = '﻿Name,Code,Price\nCotton Shirt,SH-01,850\n,, \nPanjabi,PJ-02,1450\n';
  assert.deepEqual(chunkCsv(csv), ['Name: Cotton Shirt; Code: SH-01; Price: 850\nName: Panjabi; Code: PJ-02; Price: 1450']);
  const txt = await chunkFile(new TextEncoder().encode('ফেরত নীতি: ৭ দিনের মধ্যে।'), 'policy.TXT');
  assert.deepEqual(txt, ['ফেরত নীতি: ৭ দিনের মধ্যে।']);
});

test('XLSX files, with sheet names when there are several', async () => {
  const book = new ExcelJS.Workbook();
  const shirts = book.addWorksheet('Shirts');
  shirts.addRow(['Name', 'Price']);
  shirts.addRow(['Cotton Shirt', 850]);
  const faq = book.addWorksheet('FAQ');
  faq.addRow(['Question', 'Answer']);
  faq.addRow(['Delivery time?', '2-3 days']);
  const bytes = new Uint8Array(await book.xlsx.writeBuffer());
  assert.deepEqual(await chunkFile(bytes, 'catalog.xlsx'), [
    'Shirts: Name: Cotton Shirt; Price: 850\nFAQ: Question: Delivery time?; Answer: 2-3 days',
  ]);
});

test('PDF files', async () => {
  const pdf = minimalPdf('Agently return policy: seven days.');
  const chunks = await chunkFile(pdf, 'policy.pdf');
  assert.match(chunks.join(' '), /Agently return policy: seven days\./);
  await assert.rejects(chunkFile(new TextEncoder().encode('not a pdf'), 'x.pdf'), ExtractError);
});

test('rejects unsupported files and bad sheet links', async () => {
  await assert.rejects(chunkFile(new Uint8Array(), 'photo.jpg'), /Unsupported file type/);
  assert.equal(
    googleSheetCsvUrl('https://docs.google.com/spreadsheets/d/abc_123/edit#gid=42'),
    'https://docs.google.com/spreadsheets/d/abc_123/export?format=csv&gid=42',
  );
  assert.throws(() => googleSheetCsvUrl('https://example.com/sheet'), ExtractError);
});

test('reads page text without navigation or scripts', () => {
  const page = readPage(
    '<html><head><title>Shop</title><script>x()</script></head><body><nav>Menu</nav><main><h1>About</h1><p>We sell shirts.</p></main><footer>©</footer></body></html>',
    'https://shop.example',
  );
  assert.equal(page.title, 'Shop');
  assert.equal(page.text, 'About\nWe sell shirts.');
});

test('crawls one site only, follows same-site redirects, stops at the page limit', async () => {
  const body = (links: string[], words: string) =>
    `<html><head><title>T</title></head><body><main><p>${words.repeat(10)}</p>${links.map((l) => `<a href="${l}">x</a>`).join('')}</main></body></html>`;
  const site: Record<string, Response | (() => Response)> = {
    'https://shop.example': () => html(body(['/about', '/old', 'https://evil.example/x', '/logo.png', '/about?utm_source=fb#top'], 'Home page. ')),
    'https://shop.example/about': () => html(body(['/contact'], 'About us. ')),
    'https://shop.example/old': () => new Response(null, { status: 301, headers: { location: '/delivery' } }),
    'https://shop.example/delivery': () => html(body([], 'Delivery info. ')),
    'https://shop.example/contact': () => html(body([], 'Contact us. ')),
  };
  const fetched: string[] = [];
  const fakeFetch = (async (url: string) => {
    fetched.push(url);
    const r = site[url];
    return r ? (typeof r === 'function' ? r() : r) : new Response('nope', { status: 404 });
  }) as typeof fetch;

  const opts = { fetch: fakeFetch, checkHost: async () => {} };
  const pages = await crawlSite('https://shop.example/', { maxPages: 10, ...opts });
  assert.deepEqual(pages.map((p) => p.url), [
    'https://shop.example',
    'https://shop.example/about',
    'https://shop.example/contact',
    'https://shop.example/delivery',
  ]);
  // The tracking-parameter copy of /about was not fetched again.
  assert.equal(fetched.filter((u) => u.includes('/about')).length, 1);
  assert.ok(!fetched.some((u) => u.includes('evil') || u.endsWith('.png')));

  assert.equal((await crawlSite('https://shop.example/', { maxPages: 2, ...opts })).length, 2);
});

test('refuses private and local addresses', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  assert.equal(isPrivateAddress('104.16.1.1'), false);
  await assert.rejects(assertPublicHost('127.0.0.1'), /not a public/);
  await assert.rejects(assertPublicHost('localhost'), /not a public/);
});

function html(text: string): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

/** A one-page PDF with a line of text, built by hand so the test needs no fixture file. */
function minimalPdf(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(out);
}
