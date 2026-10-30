import { z } from 'zod';

const base64Key = z
  .string()
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64 encoded');

const schemas = {
  database: z.object({ DATABASE_URL: z.string().url() }),
  redis: z.object({ REDIS_URL: z.string().url() }),
  crypto: z.object({ ENCRYPTION_KEY: base64Key }),
  meta: z.object({
    META_APP_ID: z.string().min(1),
    META_APP_SECRET: z.string().min(1),
    META_VERIFY_TOKEN: z.string().min(1),
    META_GRAPH_VERSION: z.string().default('v23.0'),
  }),
  urls: z.object({
    WEB_URL: z.string().url(),
    API_URL: z.string().url(),
    /** e.g. .example.com, so the session cookie set by api.example.com reaches app.example.com. */
    COOKIE_DOMAIN: z.string().optional(),
  }),
  storage: z.object({
    S3_ENDPOINT: z.string().url(),
    S3_REGION: z.string().default('auto'),
    S3_BUCKET: z.string().min(1),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
  }),
  ai: z.object({
    AI_BASE_URL: z.string().url(),
    AI_API_KEY: z.string().default(''),
    AI_CHAT_MODEL: z.string().min(1),
    AI_EMBEDDING_MODEL: z.string().min(1),
    AI_EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1024),
    AI_INPUT_COST_PER_MTOK: z.coerce.number().nonnegative().default(0),
    AI_OUTPUT_COST_PER_MTOK: z.coerce.number().nonnegative().default(0),
  }),
};

type Schemas = typeof schemas;
type Group = keyof Schemas;
type EnvFor<G extends Group> = z.infer<Schemas[G]>;
type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void
  ? I
  : never;

/**
 * Reads and validates only the env groups a process needs, so the web app
 * does not demand Meta secrets and the worker does not demand web URLs.
 * Fails fast at startup with every missing variable listed.
 */
export function loadEnv<G extends Group>(...groups: G[]): UnionToIntersection<EnvFor<G>> {
  const merged = groups.reduce<z.ZodObject<z.ZodRawShape>>(
    (acc, g) => acc.merge(schemas[g]),
    z.object({}),
  );
  const result = merged.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return result.data as UnionToIntersection<EnvFor<G>>;
}
