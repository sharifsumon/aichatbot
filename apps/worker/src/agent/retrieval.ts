import { and, cosineDistance, desc, eq, ilike, or } from 'drizzle-orm';
import { knowledgeChunks, products, type Db } from '@agently/db';
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
 * Exact-ish catalog search on title and code. When nothing matches (the
 * customer wrote in Bangla, or just said "this one"), falls back to the
 * newest products so the model can still ask which one they mean.
 */
export async function searchProducts(db: Db, workspaceId: string, query: string, limit = 8): Promise<ProductFact[]> {
  const terms = (query.match(/[\p{L}\p{N}-]{2,}/gu) ?? []).slice(0, 12);
  const active = and(eq(products.workspaceId, workspaceId), eq(products.status, 'active'));
  const like = (t: string) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

  const find = (where: ReturnType<typeof and>) =>
    db.query.products.findMany({
      where,
      with: { variants: true },
      orderBy: desc(products.updatedAt),
      limit,
    });

  let rows = terms.length
    ? await find(and(active, or(...terms.flatMap((t) => [ilike(products.title, like(t)), ilike(products.code, like(t))]))))
    : [];
  if (rows.length === 0) rows = await find(active);

  return rows.map((p) => ({
    id: p.id,
    title: p.title,
    code: p.code,
    description: p.description,
    price: p.price,
    variants: p.variants.map((v) => ({ color: v.color, size: v.size, stock: v.stock, price: v.price })),
  }));
}

