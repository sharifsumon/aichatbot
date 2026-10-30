import type { AIProvider, Pricing } from '@agently/ai';
import type { Db } from '@agently/db';
import type { GraphClient } from '@agently/meta';
import type { KnowledgeJob, ReplyJob } from '@agently/shared';
import type { ObjectStore } from '@agently/storage';
import type { Logger } from 'pino';

export interface WorkerDeps {
  db: Db;
  ai: AIProvider;
  graph: Pick<GraphClient, 'sendText' | 'replyToComment' | 'privateReply'>;
  pricing: Pricing;
  encryptionKey: string;
  log: Logger;
  enqueueReply(job: ReplyJob): Promise<void>;
  enqueueKnowledge(job: KnowledgeJob): Promise<void>;
  /** Uploaded files. Optional until storage is configured. */
  storage?: ObjectStore;
  /** Overrides for tests: the crawler's fetch and its public-address check. */
  http?: { fetch?: typeof fetch; checkHost?: (hostname: string) => Promise<void> };
}
