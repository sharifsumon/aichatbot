import { randomUUID } from 'node:crypto';
import { and, desc, eq, ilike, inArray, lt, notInArray, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { activities, productVariants, products, type Db } from '@agently/db';
import { workspaceKey, type ObjectStore } from '@agently/storage';
import { ALL_ROLES, MANAGERS, isUuid, makeCursor, pageLimit, parseCursor, requireRole } from './guard.ts';
import { isUniqueViolation, parseBody } from './validate.ts';

const money = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^\d{1,10}(\.\d{1,2})?$/.test(v), 'must be an amount like 850 or 850.50');

const variant = z.object({
  color: z.string().trim().max(40).default(''),
  size: z.string().trim().max(40).default(''),
  stock: z.number().int().min(0).max(1_000_000),
  price: money.nullish(),
});

const productBody = z.object({
  title: z.string().trim().min(1).max(200),
  code: z.string().trim().min(1).max(60),
  description: z.string().trim().max(5000).default(''),
  price: money,
  imageUrl: z.string().url().refine((u) => u.startsWith('https://') || u.startsWith('http://'), 'must be a web link').nullish(),
  status: z.enum(['active', 'draft', 'archived']).default('active'),
  /** The colour × size grid. A product with no options has one cell with both empty. */
  variants: z
    .array(variant)
    .min(1)
    .max(500)
    .refine((vs) => new Set(vs.map((v) => `${v.color.toLowerCase()}|${v.size.toLowerCase()}`)).size === vs.length, 'each colour and size pair can appear only once'),
});

type Params = { workspaceId: string; productId: string };

export interface CatalogDeps {
  db: Db;
  /** Product images. Both are needed: the store to write to and the public URL it is served from. */
  storage?: ObjectStore;
  publicFileUrl?: (key: string) => string;
}

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** Product Catalog: products with a colour × size stock grid. Staff read; owners and admins edit. */
export const catalogRoutes: FastifyPluginAsync<CatalogDeps> = async (app, deps) => {
  const { db } = deps;

  /**
   * Upload a product photo (multipart/form-data, one `file`). Returns the URL
   * to save as the product's imageUrl; Messenger shows it to customers.
   */
  app.post<{ Params: { workspaceId: string } }>('/workspaces/:workspaceId/uploads/images', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    if (!deps.storage || !deps.publicFileUrl) return reply.code(503).send({ error: 'Image uploads are not set up yet' });
    if (!req.isMultipart()) return reply.code(415).send({ error: 'Send the image as multipart/form-data' });
    const file = await req.file({ limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } });
    if (!file) return reply.code(400).send({ error: 'No image was sent' });
    const ext = IMAGE_TYPES[file.mimetype];
    if (!ext) {
      file.file.resume();
      return reply.code(415).send({ error: 'Upload a JPEG, PNG or WebP image' });
    }
    const bytes = await file.toBuffer().catch((err: { code?: string }) => {
      if (err.code === 'FST_REQ_FILE_TOO_LARGE') return undefined;
      throw err;
    });
    if (!bytes || file.file.truncated) return reply.code(413).send({ error: 'Images can be at most 5 MB' });
    if (!looksLike(ext, bytes)) return reply.code(415).send({ error: 'That file is not a JPEG, PNG or WebP image' });

    const key = workspaceKey(req.params.workspaceId, 'images', `${randomUUID()}.${ext}`);
    await deps.storage.put(key, bytes, file.mimetype);
    return reply.code(201).send({ url: deps.publicFileUrl(key) });
  });

  app.get<{ Params: { workspaceId: string }; Querystring: { status?: string; q?: string; cursor?: string; limit?: string } }>(
    '/workspaces/:workspaceId/products',
    async (req, reply) => {
      if (!(await requireRole(db, req, reply, ALL_ROLES))) return reply;
      const limit = pageLimit(req.query.limit);
      const cursor = parseCursor(req.query.cursor);
      const status = ['active', 'draft', 'archived'].includes(req.query.status ?? '') ? (req.query.status as 'active') : undefined;
      const q = req.query.q?.trim();
      const rows = await db
        .select()
        .from(products)
        .where(
          and(
            eq(products.workspaceId, req.params.workspaceId),
            // Archived products stay out of the list unless asked for.
            status ? eq(products.status, status) : sql`${products.status} <> 'archived'`,
            q ? or(ilike(products.title, `%${escapeLike(q)}%`), ilike(products.code, `%${escapeLike(q)}%`)) : undefined,
            cursor ? or(lt(products.createdAt, cursor.at), and(eq(products.createdAt, cursor.at), lt(products.id, cursor.id))) : undefined,
          ),
        )
        .orderBy(desc(products.createdAt), desc(products.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const variants = page.length
        ? await db.select().from(productVariants).where(inArray(productVariants.productId, page.map((p) => p.id)))
        : [];
      const last = page.at(-1);
      return {
        products: page.map((p) => withGrid(p, variants.filter((v) => v.productId === p.id))),
        nextCursor: rows.length > limit && last ? makeCursor(last.createdAt, last.id) : null,
      };
    },
  );

  app.get<{ Params: Params }>('/workspaces/:workspaceId/products/:productId', async (req, reply) => {
    if (!(await requireRole(db, req, reply, ALL_ROLES))) return reply;
    const product = await findProduct(db, req.params);
    if (!product) return reply.code(404).send({ error: 'Product not found' });
    return { product: withGrid(product, product.variants) };
  });

  app.post<{ Params: { workspaceId: string } }>('/workspaces/:workspaceId/products', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    const body = await parseBody(productBody, req.body, reply);
    if (!body) return reply;
    try {
      const product = await db.transaction(async (tx) => {
        const { variants, ...fields } = body;
        const [p] = await tx.insert(products).values({ ...fields, workspaceId: req.params.workspaceId }).returning();
        const vs = await tx
          .insert(productVariants)
          .values(variants.map((v) => ({ ...v, price: v.price ?? null, workspaceId: p!.workspaceId, productId: p!.id })))
          .returning();
        await tx.insert(activities).values({
          workspaceId: p!.workspaceId,
          type: 'product.created',
          text: `Product ${p!.title} added`,
          actorUserId: req.user.id,
          data: { productId: p!.id },
        });
        return withGrid(p!, vs);
      });
      return reply.code(201).send({ product });
    } catch (err) {
      if (isUniqueViolation(err)) return reply.code(409).send({ error: `Another product already uses the code ${body.code}` });
      throw err;
    }
  });

  /**
   * Replaces the product and its whole stock grid. Cells are matched by colour
   * and size, so an edited cell keeps its id and past orders keep pointing at it.
   */
  app.put<{ Params: Params }>('/workspaces/:workspaceId/products/:productId', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    const existing = await findProduct(db, req.params);
    if (!existing) return reply.code(404).send({ error: 'Product not found' });
    const body = await parseBody(productBody, req.body, reply);
    if (!body) return reply;

    try {
      const product = await db.transaction(async (tx) => {
        const { variants, ...fields } = body;
        const [p] = await tx.update(products).set(fields).where(eq(products.id, existing.id)).returning();
        const keep: string[] = [];
        for (const v of variants) {
          const match = existing.variants.find(
            (e) => e.color.toLowerCase() === v.color.toLowerCase() && e.size.toLowerCase() === v.size.toLowerCase(),
          );
          if (match) {
            await tx.update(productVariants).set({ color: v.color, size: v.size, stock: v.stock, price: v.price ?? null }).where(eq(productVariants.id, match.id));
            keep.push(match.id);
          } else {
            const [created] = await tx
              .insert(productVariants)
              .values({ ...v, price: v.price ?? null, workspaceId: p!.workspaceId, productId: p!.id })
              .returning({ id: productVariants.id });
            keep.push(created!.id);
          }
        }
        await tx.delete(productVariants).where(and(eq(productVariants.productId, p!.id), notInArray(productVariants.id, keep)));
        const vs = await tx.select().from(productVariants).where(eq(productVariants.productId, p!.id));
        return withGrid(p!, vs);
      });
      return { product };
    } catch (err) {
      if (isUniqueViolation(err)) return reply.code(409).send({ error: `Another product already uses the code ${body.code}` });
      throw err;
    }
  });

  /** Archives rather than deletes, so past orders still show what was bought. */
  app.delete<{ Params: Params }>('/workspaces/:workspaceId/products/:productId', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    const existing = await findProduct(db, req.params);
    if (!existing) return reply.code(404).send({ error: 'Product not found' });
    await db.update(products).set({ status: 'archived' }).where(eq(products.id, existing.id));
    return reply.code(204).send();
  });
};

async function findProduct(db: Db, p: Params) {
  if (!isUuid(p.productId)) return undefined;
  return db.query.products.findFirst({
    where: and(eq(products.id, p.productId), eq(products.workspaceId, p.workspaceId)),
    with: { variants: true },
  });
}

/** Adds the total stock (the sum of the grid) and the colours and sizes in use. */
function withGrid<P extends object>(product: P, variants: (typeof productVariants.$inferSelect)[]) {
  const sorted = [...variants].sort((a, b) => a.color.localeCompare(b.color) || a.size.localeCompare(b.size));
  return {
    ...product,
    variants: sorted.map(({ id, color, size, stock, price }) => ({ id, color, size, stock, price })),
    colors: [...new Set(sorted.map((v) => v.color).filter(Boolean))],
    sizes: [...new Set(sorted.map((v) => v.size).filter(Boolean))],
    totalStock: sorted.reduce((n, v) => n + v.stock, 0),
  };
}

/** Checks the file's first bytes, so a renamed file can't be served as an image. */
function looksLike(ext: string, b: Uint8Array): boolean {
  if (ext === 'jpg') return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (ext === 'png') return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  return Buffer.from(b.subarray(0, 4)).toString('latin1') === 'RIFF' && Buffer.from(b.subarray(8, 12)).toString('latin1') === 'WEBP';
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
