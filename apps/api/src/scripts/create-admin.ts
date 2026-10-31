/**
 * Creates an Agently team member for the super admin panel, or resets their
 * password. Run once to make the first super admin:
 *
 *   ADMIN_EMAIL=you@example.com ADMIN_NAME="Your Name" pnpm admin:create
 *
 * ADMIN_ROLE is super_admin unless given (support, finance). A one-time
 * password is printed; two-factor setup happens at the first sign-in.
 */
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createDb, platformSessions, platformUsers } from '@agently/db';
import { hashPassword, loadEnv } from '@agently/shared';

const env = loadEnv('database');
const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const name = process.env.ADMIN_NAME?.trim() || email?.split('@')[0];
const role = (process.env.ADMIN_ROLE ?? 'super_admin') as 'super_admin' | 'support' | 'finance';
if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error('Set ADMIN_EMAIL');
if (!['super_admin', 'support', 'finance'].includes(role)) throw new Error('ADMIN_ROLE must be super_admin, support or finance');

const { db, close } = createDb(env.DATABASE_URL, { max: 1 });
const password = randomBytes(18).toString('base64url');
const passwordHash = await hashPassword(password);
const existing = await db.query.platformUsers.findFirst({ where: eq(platformUsers.email, email) });
if (existing) {
  await db.update(platformUsers).set({ passwordHash, failedLogins: 0, lockedUntil: null, disabledAt: null }).where(eq(platformUsers.id, existing.id));
  await db.delete(platformSessions).where(eq(platformSessions.platformUserId, existing.id));
  console.log(`Password reset for ${email} (${existing.role}).`);
} else {
  await db.insert(platformUsers).values({ email, name: name!, role, passwordHash });
  console.log(`Created ${role} ${email}.`);
}
console.log(`One-time password: ${password}\nSign in to the admin panel, add the authenticator code, then change this password.`);
await close();
