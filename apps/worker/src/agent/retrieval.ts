import { and, cosineDistance, desc, eq, sql, type SQL } from 'drizzle-orm';
import { knowledgeChunks, productVariants, products, type Db } from '@agently/db';
import type { AIProvider } from '@agently/ai';

export interface KnowledgeHit {
  id: string;
  content: string;
  score: number;
}

export interface ProductFact {
  id: string;
  title: string;
  code: string;
  description: string;
  price: string;
  variants: { color: string; size: string; stock: number; price: string | null }[];
  /** Whether the product has a photo, and the colours that have their own. */
  photos: { main: boolean; colors: string[] };
}

/** Closest knowledge chunks by cosine similarity, from this workspace only. */
export async function searchKnowledge(
  db: Db,
  ai: AIProvider,
  workspaceId: string,
  query: string,
  limit = 5,
): Promise<KnowledgeHit[]> {
  if (!query.trim()) return [];
  const [vector] = await ai.embed([query]);
  if (!vector) return [];
  const distance = cosineDistance(knowledgeChunks.embedding, vector);
  const rows = await db
    .select({ id: knowledgeChunks.id, content: knowledgeChunks.content, distance })
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.workspaceId, workspaceId))
    .orderBy(distance)
    .limit(limit);
  return rows
    .map((r) => ({ id: r.id, content: r.content, score: 1 - Number(r.distance) }))
    .filter((r) => r.score >= 0.3);
}

/**
 * Catalog search over title, code, colour, size and description, best match
 * first: a customer may ask "XL black ache?" without naming the product.
 * When nothing matches (Bangla words, or just "this one"), falls back to the
 * newest products so the model can still ask which one they mean.
 */
export async function searchProducts(
  db: Db,
  workspaceId: string,
  query: string,
  limit = 8,
  /** Listed first whatever the query says: the product of the post a comment is on. */
  pinProductId?: string,
): Promise<ProductFact[]> {
  const terms = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}-]{2,}/gu) ?? []))].slice(0, 12);
  const active = and(eq(products.workspaceId, workspaceId), eq(products.status, 'active'));
  const like = (t: string) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

  const find = (where: SQL | undefined, order: SQL[]) =>
    db.query.products.findMany({ where, with: { variants: true }, orderBy: order, limit });

  let rows: Awaited<ReturnType<typeof find>> = [];
  if (terms.length) {
    // Name and code count most, then a colour or size the product comes in, then its description.
    const score = sql.join(
      terms.map(
        (t) => sql`(
          (case when ${products.title} ilike ${like(t)} then 3 else 0 end) +
          (case when ${products.code} ilike ${like(t)} then 3 else 0 end) +
          (case when exists (select 1 from ${productVariants} v where v.product_id = ${products.id} and (v.color ilike ${like(t)} or lower(v.size) = ${t})) then 2 else 0 end) +
          (case when ${products.description} ilike ${like(t)} then 1 else 0 end)
        )`,
      ),
      sql` + `,
    );
    rows = await find(and(active, sql`(${score}) > 0`), [desc(sql`(${score})`), desc(products.updatedAt)]);
  }
  if (rows.length === 0) rows = await find(active, [desc(products.updatedAt)]);
  if (pinProductId) {
    const pinned = await db.query.products.findFirst({ where: and(active, eq(products.id, pinProductId)), with: { variants: true } });
    if (pinned) rows = [pinned, ...rows.filter((p) => p.id !== pinned.id)].slice(0, limit);
  }

  return rows.map((p) => ({
    id: p.id,
    title: p.title,
    code: p.code,
    description: p.description,
    price: p.price,
    variants: p.variants.map((v) => ({ color: v.color, size: v.size, stock: v.stock, price: v.price })),
    photos: { main: p.images.length > 0, colors: [...new Set(p.images.map((i) => i.color).filter(Boolean))] },
  }));
}

