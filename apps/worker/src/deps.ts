import type { AIProvider, Pricing } from '@agently/ai';
import type { Db } from '@agently/db';
import type { GraphClient } from '@agently/meta';
import type { ReplyJob } from '@agently/shared';
import type { Logger } from 'pino';

export interface WorkerDeps {
  db: Db;
  ai: AIProvider;
  graph: Pick<GraphClient, 'sendText' | 'replyToComment' | 'privateReply'>;
  pricing: Pricing;
  encryptionKey: string;
  log: Logger;
  enqueueReply(job: ReplyJob): Promise<void>;
}
