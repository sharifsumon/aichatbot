/** Product search against a real database. Needs DATABASE_URL. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, productVariants, products, workspaces, type Db } from '@agently/db';
import { searchProducts } from './retrieval.ts';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL not set';
let db: Db;
let close: () => Promise<void>;

before(() => {
  if (!skip) ({ db, close } = createDb(url!, { max: 2 }));
});
after(async () => {
  if (!skip) await close();
});

test('finds products by colour, size and description, best match first', { skip }, async () => {
  const [ws] = await db.insert(workspaces).values({ name: 'Search shop', status: 'active' }).returning();
  const add = async (title: string, code: string, description: string, cells: [string, string, number][], status: 'active' | 'draft' = 'active') => {
    const [p] = await db.insert(products).values({ workspaceId: ws!.id, title, code, description, price: '500', status }).returning();
    await db.insert(productVariants).values(cells.map(([color, size, stock]) => ({ workspaceId: ws!.id, productId: p!.id, color, size, stock })));
    return p!;
  };
  const tee = await add('Cotton T-shirt', 'TS-01', 'Soft cotton', [['Black', 'XL', 2], ['White', 'M', 0]]);
  const panjabi = await add('Eid Panjabi', 'PJ-07', 'Silk blend, maroon embroidery', [['Maroon', 'L', 4]]);
  await add('Hidden', 'HD-01', 'Black XL draft', [['Black', 'XL', 9]], 'draft');
  for (let i = 0; i < 9; i++) await add(`Filler ${i}`, `FL-0${i}`, 'plain', [['Grey', 'S', 1]]);

  const titles = async (q: string) => (await searchProducts(db, ws!.id, q)).map((p) => p.title);

  // Colour and size alone find the product, even with more than 8 products in the shop.
  assert.equal((await titles('XL black ache?'))[0], 'Cotton T-shirt');
  assert.equal((await titles('maroon ta koto?'))[0], 'Eid Panjabi');
  // Description words count too.
  assert.equal((await titles('embroidery'))[0], 'Eid Panjabi');
  // Name still wins.
  assert.deepEqual((await titles('panjabi'))[0], 'Eid Panjabi');
  // Drafts are never offered.
  assert.ok(!(await titles('black xl')).includes('Hidden'));
  // Sizes match whole, so "l" inside other words doesn't count; nothing matching falls back to the newest products.
  const fallback = await searchProducts(db, ws!.id, 'ki ki ache');
  assert.equal(fallback.length, 8);
  // Stock per colour and size comes back for the model to quote.
  const [found] = await searchProducts(db, ws!.id, 'TS-01');
  assert.deepEqual(found!.variants.map((v) => [v.color, v.size, v.stock]).sort(), [['Black', 'XL', 2], ['White', 'M', 0]]);
  assert.ok([tee.id, panjabi.id].includes(found!.id));
  // A comment on a post about the T-shirt: "price?" lists the T-shirt first, among the fallback.
  const pinned = await searchProducts(db, ws!.id, 'price koto?', 8, tee.id);
  assert.equal(pinned[0]!.id, tee.id);
  assert.equal(pinned.length, 8);
  assert.equal(new Set(pinned.map((p) => p.id)).size, 8);
});
