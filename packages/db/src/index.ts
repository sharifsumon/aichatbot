import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.ts';

export * from './schema/index.ts';
export { schema };

export function createDb(url: string, options: { max?: number } = {}) {
  const client = postgres(url, { max: options.max ?? 10 });
  return { db: drizzle(client, { schema, casing: 'snake_case' }), close: () => client.end() };
}

export type Db = ReturnType<typeof createDb>['db'];
