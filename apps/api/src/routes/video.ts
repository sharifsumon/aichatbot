import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  DEFAULT_VIDEO_MODEL,
  DEFAULT_WALK_MODEL,
  FalVideo,
  TryOnError,
  VIDEO_EMOTIONS,
  VIDEO_LANGUAGES,
  isBangla,
  VIDEO_STYLES,
  VIDEO_VOICES,
  videoPrompt,
  type VideoEmotion,
  type VideoLanguage,
  type VideoStyle,
  type VideoVoice,
} from '@agently/ai';
import { creditsRemaining, recordUsage } from '@agently/billing';
import { modelCharacters, modelVideos, platformSettings, type Db } from '@agently/db';
import { decryptSecret } from '@agently/shared';
import { workspaceKey, type ObjectStore } from '@agently/storage';
import { ALL_ROLES, MANAGERS, isUuid, requireRole } from './guard.ts';
import { parseBody } from './validate.ts';
import { clipLengths, ffmpegMedia, splitScript, type Media } from '../lib/media.ts';
import { storedTryOnService } from './tryon-service.ts';

export interface VideoDeps {
  db: Db;
  storage?: ObjectStore;
  publicFileUrl?: (key: string) => string;
  encryptionKey: string;
  /** A fal.ai key from the server's .env, used when Platform settings hold none. */
  falApiKey?: string;
  /** For tests: replaces the real fal.ai client. */
  makeVideo?: (opts: { apiKey: string; model?: string; walkModel?: string; voiceModel?: string }) => Pick<FalVideo, 'speak' | 'talk' | 'walk' | 'model' | 'walkModel'>;
  /** For tests: replaces ffmpeg for joining walk-and-talk clips. */
  media?: Media;
}

/** Walk-and-talk lengths the shop can pick; over 10 seconds, clips are made one after another and joined. */
export const WALK_SECONDS = [5, 10, 15, 20, 30, 45, 60] as const;
/** About 60 seconds of speech. */
const MAX_TALK_SCRIPT = 900;

/** Credits one second of video uses when the super admin has not set video.creditsPerSecond. */
export const DEFAULT_VIDEO_CREDITS_PER_SECOND = 15;
/** Seconds a typed script is assumed to last, per character, for the price shown before generating. */
const CHARS_PER_SECOND = 14;
/** What a talking video with an uploaded voice is assumed to last, before it is made. */
const ASSUMED_RECORDING_SEC = 20;
const MAX_RUNNING = 2;
const STALE_MS = 60 * 60_000;
const RUN_TIMEOUT_MS = 55 * 60_000;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const AUDIO_TYPES: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
};

const keys = <T extends object>(o: T) => Object.keys(o) as [string, ...string[]];

const createBody = z
  .object({
    sourceImageUrl: z.string().url(),
    mode: z.enum(['talk', 'walk']).default('talk'),
    /** false: a silent movement video (walk mode only), no script or voice. */
    speak: z.boolean().default(true),
    script: z.string().trim().max(1500).optional(),
    audioUrl: z.string().url().optional(),
    voice: z.enum(keys(VIDEO_VOICES)).default('Wise_Woman'),
    language: z.enum(VIDEO_LANGUAGES as unknown as [string, ...string[]]).default('auto'),
    emotion: z.enum(VIDEO_EMOTIONS as unknown as [string, ...string[]]).default('happy'),
    gesture: z.enum(keys(VIDEO_STYLES.gesture)).optional(),
    camera: z.enum(keys(VIDEO_STYLES.camera)).optional(),
    note: z.string().trim().max(500).optional(),
    seconds: z
      .number()
      .int()
      .refine((n) => (WALK_SECONDS as readonly number[]).includes(n), 'must be 5, 10, 15, 20, 30, 45 or 60')
      .default(10),
  })
  .strict();

async function setting<T>(db: Db, key: string): Promise<T | undefined> {
  const row = await db.query.platformSettings.findFirst({ where: eq(platformSettings.key, key) });
  return row?.value as T | undefined;
}

export async function videoCreditsPerSecond(db: Db): Promise<number> {
  const v = await setting<number>(db, 'video.creditsPerSecond');
  return typeof v === 'number' ? v : DEFAULT_VIDEO_CREDITS_PER_SECOND;
}

/** The fal.ai key: the one saved for try-on under Platform settings when that is fal.ai, else the server's. */
async function falKey(db: Db, deps: VideoDeps): Promise<string | undefined> {
  const s = await storedTryOnService(db);
  if (s?.provider === 'fal' && s.apiKeyEncrypted) {
    try {
      return decryptSecret(s.apiKeyEncrypted, deps.encryptionKey);
    } catch (err) {
      // A key saved under another encryption key can't be read; the server's own key still works.
      if (!deps.falApiKey) throw err;
    }
  }
  return deps.falApiKey || undefined;
}

async function currentVideo(db: Db, deps: VideoDeps) {
  const apiKey = await falKey(db, deps);
  if (!apiKey) return undefined;
  const opts = { apiKey, model: (await setting<string>(db, 'video.talkModel')) || undefined, walkModel: (await setting<string>(db, 'video.walkModel')) || undefined,
    voiceModel: (await setting<string>(db, 'video.voiceModel')) || undefined,
  };
  return deps.makeVideo ? deps.makeVideo(opts) : new FalVideo(opts);
}

/**
 * "Videos with models": the shop turns a model photo into a short product
 * video, either talking from a script (or the shop's own voice recording) or
 * walking and talking with the camera following.
 */
export const videoRoutes: FastifyPluginAsync<VideoDeps> = async (app, deps) => {
  const { db } = deps;

  app.get<{ Params: { workspaceId: string } }>('/workspaces/:workspaceId/videos/setup', async (req, reply) => {
    if (!(await requireRole(db, req, reply, ALL_ROLES))) return reply;
    const video = await currentVideo(db, deps).catch(() => undefined);
    return {
      enabled: !!(video && deps.storage && deps.publicFileUrl),
      creditsPerSecond: await videoCreditsPerSecond(db),
      voices: Object.entries(VIDEO_VOICES).map(([id, label]) => ({ id, label })),
      languages: VIDEO_LANGUAGES,
    };
  });

  app.get<{ Params: { workspaceId: string } }>('/workspaces/:workspaceId/videos', async (req, reply) => {
    if (!(await requireRole(db, req, reply, ALL_ROLES))) return reply;
    await failStale(db, req.params.workspaceId);
    const videos = await db.select().from(modelVideos).where(eq(modelVideos.workspaceId, req.params.workspaceId)).orderBy(desc(modelVideos.createdAt)).limit(30);
    return { videos: videos.map(view) };
  });

  app.get<{ Params: { workspaceId: string; videoId: string } }>('/workspaces/:workspaceId/videos/:videoId', async (req, reply) => {
    if (!(await requireRole(db, req, reply, ALL_ROLES))) return reply;
    if (!isUuid(req.params.videoId)) return reply.code(404).send({ error: 'Video not found' });
    await failStale(db, req.params.workspaceId);
    const v = await db.query.modelVideos.findFirst({ where: and(eq(modelVideos.id, req.params.videoId), eq(modelVideos.workspaceId, req.params.workspaceId)) });
    if (!v) return reply.code(404).send({ error: 'Video not found' });
    return { video: view(v) };
  });

  /** Upload a voice recording (MP3, WAV, M4A, AAC, OGG or WebM, up to 10 MB) for a talking video. */
  app.post<{ Params: { workspaceId: string } }>('/workspaces/:workspaceId/uploads/audio', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    if (!deps.storage || !deps.publicFileUrl) return reply.code(503).send({ error: 'Uploads are not set up yet' });
    if (!req.isMultipart()) return reply.code(415).send({ error: 'Send the recording as multipart/form-data' });
    const file = await req.file({ limits: { fileSize: MAX_AUDIO_BYTES, files: 1 } });
    if (!file) return reply.code(400).send({ error: 'No recording was sent' });
    const ext = AUDIO_TYPES[file.mimetype.split(';')[0]!];
    if (!ext) {
      file.file.resume();
      return reply.code(415).send({ error: 'Upload an MP3, WAV, M4A or OGG recording' });
    }
    const bytes = await file.toBuffer().catch((err: { code?: string }) => {
      if (err.code === 'FST_REQ_FILE_TOO_LARGE') return undefined;
      throw err;
    });
    if (!bytes || file.file.truncated) return reply.code(413).send({ error: 'A recording can be at most 10 MB' });
    const key = workspaceKey(req.params.workspaceId, 'audio', `${randomUUID()}.${ext}`);
    await deps.storage.put(key, bytes, file.mimetype.split(';')[0]!);
    return reply.code(201).send({ url: deps.publicFileUrl(key) });
  });

  /** Starts making a video. Answers at once with a pending video; poll it until it succeeds or fails. */
  app.post<{ Params: { workspaceId: string } }>('/workspaces/:workspaceId/videos', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    const { storage, publicFileUrl } = deps;
    let video: Awaited<ReturnType<typeof currentVideo>>;
    try {
      video = await currentVideo(db, deps);
    } catch (err) {
      req.log.error({ err }, 'Video settings unreadable');
      return reply.code(503).send({ error: 'Videos with models are not set up correctly. Ask Agently support.' });
    }
    if (!video || !storage || !publicFileUrl) return reply.code(503).send({ error: 'Videos with models are not switched on yet' });
    const body = await parseBody(createBody, req.body, reply);
    if (!body) return reply;
    const { workspaceId } = req.params;

    // The photo must be this shop's own (an upload or a generated image) or one of the platform's models.
    const imagesPrefix = publicFileUrl(workspaceKey(workspaceId, 'images', ''));
    const ownImage = body.sourceImageUrl.startsWith(imagesPrefix) && /^[A-Za-z0-9-]+\.(jpg|png|webp)$/.test(body.sourceImageUrl.slice(imagesPrefix.length));
    if (!ownImage) {
      const character = await db.query.modelCharacters.findFirst({ where: and(eq(modelCharacters.imageUrl, body.sourceImageUrl), eq(modelCharacters.active, true), isNull(modelCharacters.workspaceId)) });
      if (!character) return reply.code(400).send({ error: 'Choose one of your images or upload a photo here first' });
    }

    const audioPrefix = publicFileUrl(workspaceKey(workspaceId, 'audio', ''));
    if (body.audioUrl && !(body.audioUrl.startsWith(audioPrefix) && /^[A-Za-z0-9-]+\.\w+$/.test(body.audioUrl.slice(audioPrefix.length)))) {
      return reply.code(400).send({ error: 'Upload the voice recording here first' });
    }
    if (!body.speak) {
      if (body.mode === 'talk') return reply.code(400).send({ error: 'A talking video needs a voice. Choose Walk and talk for a silent video.' });
      body.script = undefined;
    }
    if (body.mode === 'walk' && body.script && isBangla(body.script)) {
      return reply.code(400).send({ error: 'Walk and talk can only speak English. For a Bangla voice choose Talking, or untick "The model speaks".' });
    }
    if (body.mode === 'walk' && body.audioUrl) return reply.code(400).send({ error: 'Walk and talk makes its own voice from the script. Use Talking for a recording.' });
    if (body.mode === 'talk' && !body.script && !body.audioUrl) return reply.code(400).send({ error: 'Write a script or upload a voice recording' });
    if (body.mode === 'talk' && !body.audioUrl && body.script!.length > MAX_TALK_SCRIPT) {
      return reply.code(400).send({ error: `Keep the script under ${MAX_TALK_SCRIPT} characters (about 60 seconds of speech).` });
    }

    const perSecond = await videoCreditsPerSecond(db);
    const estimateSec = body.mode === 'walk' ? body.seconds : body.audioUrl ? ASSUMED_RECORDING_SEC : Math.max(3, Math.ceil(body.script!.length / CHARS_PER_SECOND));
    const estimate = estimateSec * perSecond;
    if (estimate > 0 && (await creditsRemaining(db, workspaceId)) < estimate) {
      return reply.code(402).send({ error: `This video needs about ${estimate} AI credits, and this month's credits are not enough. Top up or upgrade to make more.`, limit: 'credits' });
    }
    await failStale(db, workspaceId);
    const [running] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(modelVideos)
      .where(and(eq(modelVideos.workspaceId, workspaceId), eq(modelVideos.status, 'pending')));
    if ((running?.n ?? 0) >= MAX_RUNNING) return reply.code(429).send({ error: `${MAX_RUNNING} videos are already being made. Wait for one to finish.` });

    const options = { gesture: body.gesture, camera: body.camera, note: body.note, emotion: body.emotion, seconds: body.mode === 'walk' ? body.seconds : undefined, silent: !body.speak };
    const [row] = await db
      .insert(modelVideos)
      .values({
        workspaceId,
        sourceImageUrl: body.sourceImageUrl,
        mode: body.mode,
        script: body.script || null,
        audioUrl: body.audioUrl ?? null,
        voice: body.audioUrl || !body.speak ? null : body.voice,
        language: body.speak ? body.language : null,
        options,
        provider: 'fal',
        model: body.mode === 'walk' ? video.walkModel : video.model,
        createdByUserId: req.user.id,
      })
      .returning();

    // In the background: videos take minutes, far past the proxy's timeout.
    void runVideo({ db, storage, publicFileUrl, video, media: deps.media ?? ffmpegMedia, log: req.log }, row!.id, workspaceId, {
      mode: body.mode,
      imageUrl: body.sourceImageUrl,
      script: body.script || undefined,
      audioUrl: body.audioUrl,
      voice: body.voice as VideoVoice,
      language: body.language as VideoLanguage,
      emotion: body.emotion as VideoEmotion,
      style: { gesture: body.gesture, camera: body.camera } as VideoStyle,
      note: body.note || undefined,
      seconds: body.seconds,
      silent: !body.speak,
      creditsPerSecond: perSecond,
      options,
    });
    return reply.code(202).send({ video: view(row!) });
  });

  app.delete<{ Params: { workspaceId: string; videoId: string } }>('/workspaces/:workspaceId/videos/:videoId', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    if (!isUuid(req.params.videoId)) return reply.code(404).send({ error: 'Video not found' });
    const [gone] = await db
      .delete(modelVideos)
      .where(and(eq(modelVideos.id, req.params.videoId), eq(modelVideos.workspaceId, req.params.workspaceId)))
      .returning({ id: modelVideos.id });
    if (!gone) return reply.code(404).send({ error: 'Video not found' });
    return reply.code(204).send();
  });
};

/** Makes the video and saves it. Never throws: failures are written to the row. */
export async function runVideo(
  deps: {
    db: Db;
    storage: ObjectStore;
    publicFileUrl: (key: string) => string;
    video: Pick<FalVideo, 'speak' | 'talk' | 'walk' | 'model' | 'walkModel'>;
    media: Media;
    log: FastifyBaseLogger;
  },
  videoId: string,
  workspaceId: string,
  job: {
    mode: 'talk' | 'walk';
    imageUrl: string;
    script?: string;
    audioUrl?: string;
    voice: VideoVoice;
    language: VideoLanguage;
    emotion: VideoEmotion;
    style: VideoStyle;
    note?: string;
    seconds: number;
    silent?: boolean;
    options?: Record<string, unknown>;
    creditsPerSecond: number;
  },
): Promise<void> {
  const { db, storage, video } = deps;
  const model = job.mode === 'walk' ? video.walkModel : video.model;
  const usageModel = `video:${model}`;
  const signal = AbortSignal.timeout(RUN_TIMEOUT_MS);
  try {
    let result;
    if (job.mode === 'walk') {
      result = await walkLong(deps, videoId, workspaceId, job, signal);
    } else {
      const audioUrl = job.audioUrl ?? (await video.speak({ text: job.script!, voice: job.voice, language: job.language, emotion: job.emotion }, signal)).audioUrl;
      result = await video.talk({ imageUrl: job.imageUrl, audioUrl, prompt: videoPrompt(job.style, job.note), scriptChars: job.audioUrl ? 0 : job.script?.length }, signal);
    }
    const key = workspaceKey(workspaceId, 'videos', `${randomUUID()}.mp4`);
    await storage.put(key, result.video.bytes, result.video.contentType);
    const credits = Math.ceil(result.durationSec || job.seconds) * job.creditsPerSecond;
    await db
      .update(modelVideos)
      .set({
        status: 'succeeded',
        resultVideoUrl: deps.publicFileUrl(key),
        durationSec: result.durationSec.toFixed(2),
        credits,
        costUsd: result.costUsd.toFixed(6),
        finishedAt: new Date(),
      })
      .where(eq(modelVideos.id, videoId));
    await recordUsage(db, { workspaceId, model: usageModel, aiReplies: credits, inputTokens: 0, outputTokens: 0, costUsd: result.costUsd });
  } catch (err) {
    deps.log.warn({ err, videoId }, 'Model video failed');
    const message = err instanceof TryOnError ? err.userMessage : 'Something went wrong making this video. Try again.';
    await db.update(modelVideos).set({ status: 'failed', error: message, finishedAt: new Date() }).where(eq(modelVideos.id, videoId)).catch(() => undefined);
    await recordUsage(db, { workspaceId, model: usageModel, aiReplies: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, failed: true }).catch(() => undefined);
  }
}

/**
 * Walk and talk for any length: clips of up to 10 seconds, each starting from
 * the last frame of the one before, with the script shared out, then joined.
 */
async function walkLong(
  deps: Parameters<typeof runVideo>[0],
  videoId: string,
  workspaceId: string,
  job: Parameters<typeof runVideo>[3],
  signal: AbortSignal,
) {
  const lengths = clipLengths(job.seconds);
  if (lengths.length === 1) {
    return deps.video.walk({ imageUrl: job.imageUrl, prompt: videoPrompt(job.style, job.note, job.script, job.silent), seconds: lengths[0]!, silent: job.silent }, signal);
  }
  const lines = splitScript(job.script ?? '', lengths.length);
  const clips: Uint8Array[] = [];
  let imageUrl = job.imageUrl;
  let durationSec = 0;
  let costUsd = 0;
  for (let i = 0; i < lengths.length; i++) {
    await deps.db
      .update(modelVideos)
      .set({ options: { ...job.options, progress: { clip: i + 1, of: lengths.length } } })
      .where(eq(modelVideos.id, videoId));
    // Later clips carry on from where the last one ended.
    const note = [job.note, i > 0 ? 'Continue smoothly from this exact frame: same person, outfit, place and lighting.' : ''].filter(Boolean).join(' ');
    const clip = await deps.video.walk({ imageUrl, prompt: videoPrompt(job.style, note || undefined, lines[i] || undefined, job.silent), seconds: lengths[i]!, silent: job.silent }, signal);
    clips.push(clip.video.bytes);
    durationSec += clip.durationSec;
    costUsd += clip.costUsd;
    if (i < lengths.length - 1) {
      const frame = await deps.media.lastFrame(clip.video.bytes);
      const key = workspaceKey(workspaceId, 'images', `${randomUUID()}.jpg`);
      await deps.storage.put(key, frame, 'image/jpeg');
      imageUrl = deps.publicFileUrl(key);
    }
  }
  return { video: { bytes: await deps.media.concat(clips), contentType: 'video/mp4' }, durationSec, costUsd };
}

async function failStale(db: Db, workspaceId: string) {
  await db
    .update(modelVideos)
    .set({ status: 'failed', error: 'This video was interrupted. Try again.', finishedAt: new Date() })
    .where(and(eq(modelVideos.workspaceId, workspaceId), eq(modelVideos.status, 'pending'), lt(modelVideos.createdAt, new Date(Date.now() - STALE_MS))));
}

function view(v: typeof modelVideos.$inferSelect) {
  return {
    id: v.id,
    sourceImageUrl: v.sourceImageUrl,
    mode: v.mode,
    script: v.script,
    audioUrl: v.audioUrl,
    voice: v.voice,
    language: v.language,
    options: v.options,
    status: v.status,
    resultVideoUrl: v.resultVideoUrl,
    durationSec: v.durationSec === null ? null : Number(v.durationSec),
    credits: v.credits,
    error: v.error,
    createdAt: v.createdAt,
    finishedAt: v.finishedAt,
  };
}

export { DEFAULT_VIDEO_MODEL, DEFAULT_WALK_MODEL };
