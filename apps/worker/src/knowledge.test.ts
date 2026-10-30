/** Needs DATABASE_URL pointing at a migrated database; skipped otherwise. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import { AIProviderError, type AIProvider } from '@agently/ai';
import { EMBEDDING_DIMENSIONS, createDb, knowledgeChunks, knowledgeSources, workspaces, type Db } from '@agently/db';
import type { WorkerDeps } from './deps.ts';
import { searchKnowledge } from './agent/retrieval.ts';
import { handleKnowledge, staleSheetSources } from './knowledge.ts';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL not set';
let db: Db;
let close: () => Promise<void>;

before(() => {
  if (!skip) ({ db, close } = createDb(url!, { max: 4 }));
});
after(async () => {
  if (!skip) await close();
});

/** A fake embedding: one axis per keyword, so "delivery" questions find delivery chunks. */
function embedOf(text: string): number[] {
  const v = Array(EMBEDDING_DIMENSIONS).fill(0);
  const t = text.toLowerCase();
  v[0] = t.includes('delivery') || t.includes('ডেলিভারি') ? 1 : 0;
  v[1] = t.includes('return') ? 1 : 0;
  v[2] = 0.05;
  return v;
}

function deps(overrides: Partial<WorkerDeps> = {}): WorkerDeps {
  const ai: AIProvider = {
    chatModel: 'fake',
    chat: async () => {
      throw new Error('not used');
    },
    embed: async (texts) => texts.map(embedOf),
  };
  return {
    db,
    ai,
    log: pino({ level: 'silent' }),
    encryptionKey: '',
    pricing: { inputPerMTok: 0, outputPerMTok: 0 },
    graph: { sendText: async () => [], replyToComment: async () => '', privateReply: async () => '' },
    enqueueReply: async () => {},
    enqueueKnowledge: async () => {},
    ...overrides,
  };
}

async function source(values: Partial<typeof knowledgeSources.$inferInsert> & Pick<typeof knowledgeSources.$inferInsert, 'type'>) {
  const [ws] = await db.insert(workspaces).values({ name: 'Shop' }).returning();
  const [s] = await db
    .insert(knowledgeSources)
    .values({ workspaceId: ws!.id, name: 'Source', ...values })
    .returning();
  return s!;
}

const statusOf = async (id: string) => (await db.select().from(knowledgeSources).where(eq(knowledgeSources.id, id)))[0]!;
const chunksOf = async (id: string) => db.select().from(knowledgeChunks).where(eq(knowledgeChunks.sourceId, id));

test('text source becomes searchable, and a re-sync replaces old chunks', { skip }, async () => {
  const s = await source({ type: 'text', content: 'Delivery inside Dhaka takes 1-2 days.\n\nReturns are accepted within 7 days.' });
  const job = { workspaceId: s.workspaceId, sourceId: s.id };
  assert.equal(await handleKnowledge(deps(), job, { finalAttempt: false }), 'ready');
  const ready = await statusOf(s.id);
  assert.equal(ready.status, 'ready');
  assert.ok(ready.lastSyncedAt);

  const hits = await searchKnowledge(db, deps().ai, s.workspaceId, 'how long is delivery?');
  assert.match(hits[0]!.content, /Delivery inside Dhaka/);

  await db.update(knowledgeSources).set({ content: 'Delivery is free this week.' }).where(eq(knowledgeSources.id, s.id));
  await handleKnowledge(deps(), job, { finalAttempt: false });
  const chunks = await chunksOf(s.id);
  assert.deepEqual(chunks.map((c) => c.content), ['Delivery is free this week.']);
});

test('Q&A pairs, one chunk each', { skip }, async () => {
  const s = await source({
    type: 'qa',
    content: JSON.stringify([
      { question: 'ডেলিভারি চার্জ কত?', answer: 'ঢাকায় ৬০ টাকা' },
      { question: 'Return?', answer: '7 days' },
    ]),
  });
  await handleKnowledge(deps(), { workspaceId: s.workspaceId, sourceId: s.id }, { finalAttempt: false });
  assert.equal((await chunksOf(s.id)).length, 2);
});

test('a problem with the source fails at once with a message for the owner', { skip }, async () => {
  const noStorage = await source({ type: 'file', name: 'catalog.xlsx', fileKey: 'ws/catalog.xlsx' });
  assert.equal(await handleKnowledge(deps(), { workspaceId: noStorage.workspaceId, sourceId: noStorage.id }, { finalAttempt: false }), 'failed');
  assert.equal((await statusOf(noStorage.id)).error, 'File storage is not set up yet.');

  const privateSheet = await source({ type: 'sheet', url: 'https://docs.google.com/spreadsheets/d/abc/edit' });
  const signIn = (async () => new Response('<html>Sign in</html>', { headers: { 'content-type': 'text/html' } })) as typeof fetch;
  await handleKnowledge(deps({ http: { fetch: signIn } }), { workspaceId: privateSheet.workspaceId, sourceId: privateSheet.id }, { finalAttempt: false });
  assert.match((await statusOf(privateSheet.id)).error!, /Anyone with the link/);
});

test('files come from storage; sheets come as CSV', { skip }, async () => {
  const file = await source({ type: 'file', name: 'faq.txt', fileKey: 'ws/abc' });
  const storage = { get: async () => new TextEncoder().encode('Return within 7 days.'), put: async () => {} };
  assert.equal(await handleKnowledge(deps({ storage }), { workspaceId: file.workspaceId, sourceId: file.id }, { finalAttempt: false }), 'ready');

  const sheet = await source({ type: 'sheet', url: 'https://docs.google.com/spreadsheets/d/abc/edit' });
  const csv = (async () => new Response('Area,Charge\nDhaka,60\n', { headers: { 'content-type': 'text/csv' } })) as typeof fetch;
  await handleKnowledge(deps({ http: { fetch: csv } }), { workspaceId: sheet.workspaceId, sourceId: sheet.id }, { finalAttempt: false });
  assert.deepEqual((await chunksOf(sheet.id)).map((c) => c.content), ['Area: Dhaka; Charge: 60']);

  const stale = await staleSheetSources({ db }, new Date(Date.now() + 1000));
  assert.ok(stale.some((s) => s.sourceId === sheet.id));
  assert.ok(!(await staleSheetSources({ db }, new Date(Date.now() - 3600_000))).some((s) => s.sourceId === sheet.id));
});

test('model outages are retried, and fail only on the last attempt', { skip }, async () => {
  const s = await source({ type: 'text', content: 'Delivery takes 2 days.' });
  const down = deps({
    ai: { chatModel: 'fake', chat: async () => ({}) as never, embed: async () => { throw new AIProviderError('down', 503, true); } },
  });
  const job = { workspaceId: s.workspaceId, sourceId: s.id };
  await assert.rejects(handleKnowledge(down, job, { finalAttempt: false }), AIProviderError);
  assert.equal((await statusOf(s.id)).status, 'processing');
  assert.equal(await handleKnowledge(down, job, { finalAttempt: true }), 'failed');
  assert.match((await statusOf(s.id)).error!, /Try again later/);
});

test("a job naming another shop's source does nothing", { skip }, async () => {
  const s = await source({ type: 'text', content: 'Delivery takes 2 days.' });
  const [other] = await db.insert(workspaces).values({ name: 'Other' }).returning();
  assert.equal(await handleKnowledge(deps(), { workspaceId: other!.id, sourceId: s.id }, { finalAttempt: true }), 'missing');
  assert.equal((await statusOf(s.id)).status, 'queued');
});
