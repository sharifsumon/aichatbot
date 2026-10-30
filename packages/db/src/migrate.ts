import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import { createDb } from './index.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

const { db, close } = createDb(url, { max: 1 });
await migrate(db, { migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)) });
await close();
console.log('Migrations applied');
