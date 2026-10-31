import type { FastifyReply } from 'fastify';
import type { z } from 'zod';

/** Parses a request body; on failure replies 400 with the first problem and returns undefined. */
export async function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown, reply: FastifyReply): Promise<z.infer<S> | undefined> {
  const result = schema.safeParse(body ?? {});
  if (result.success) return result.data;
  const issue = result.error.issues[0]!;
  await reply.code(400).send({ error: `${issue.path.join('.') || 'body'}: ${issue.message}`, issues: result.error.issues });
  return undefined;
}

/** Postgres 23505; drizzle wraps the driver error in `cause`. */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code === '23505' || e.cause?.code === '23505';
}
