import { falDetail, TryOnError } from './tryon.ts';

/**
 * "Videos with models": a model photo talks from the shop's script. Two steps
 * on fal.ai with the same key: the script becomes a voice (text-to-speech),
 * then a talking-avatar model animates the photo to that voice.
 */

/** "Talking": lip-syncs the photo to a voice. Any length; little body movement. */
export const DEFAULT_VIDEO_MODEL = 'fal-ai/kling-video/ai-avatar/v2/standard';
/** "Walk and talk": full motion and camera from a prompt, speech from the prompt (English or Chinese), 5 or 10 seconds. */
export const DEFAULT_WALK_MODEL = 'fal-ai/kling-video/v2.6/pro/image-to-video';
export const DEFAULT_VOICE_MODEL = 'fal-ai/minimax/speech-2.6-turbo';
/**
 * Voice models tried in order when none is set: fal closes older ones to some
 * keys ("API key does not have access to model"), so the next one is tried.
 */
export const VOICE_MODELS = ['fal-ai/minimax/speech-2.6-turbo', 'fal-ai/minimax/preview/speech-2.5-turbo', 'fal-ai/minimax/speech-02-turbo'];

/** The request body for a MiniMax voice model: 2.6 names the script `prompt`, older ones `text`. */
function voiceInput(model: string, req: SpeakRequest) {
  return {
    [/speech-2\.6/.test(model) ? 'prompt' : 'text']: req.text,
    voice_setting: { voice_id: req.voice ?? 'Wise_Woman', speed: 1, emotion: req.emotion ?? 'happy' },
    language_boost: req.language ?? 'auto',
    output_format: 'url',
  };
}

/** US dollars per second of video, from fal's model pages. */
const VIDEO_PRICES: Record<string, number> = {
  'fal-ai/kling-video/ai-avatar/v2/standard': 0.0562,
  'fal-ai/kling-video/ai-avatar/v2/pro': 0.115,
  'fal-ai/kling-video/v2.6/pro/image-to-video': 0.14,
};
/** US dollars per 1,000 characters of script. */
const VOICE_PRICE_PER_1000 = 0.1;

/** The voices the shop can pick (MiniMax system voices). */
export const VIDEO_VOICES = {
  Wise_Woman: 'Woman, warm and calm',
  Calm_Woman: 'Woman, soft',
  Lively_Girl: 'Young woman, lively',
  Friendly_Person: 'Friendly, neutral',
  Deep_Voice_Man: 'Man, deep',
  Casual_Guy: 'Young man, casual',
  Elegant_Man: 'Man, polished',
  Patient_Man: 'Man, gentle',
} as const;
export type VideoVoice = keyof typeof VIDEO_VOICES;

/** Language hints for the voice. "auto" lets the AI decide. */
export const VIDEO_LANGUAGES = ['auto', 'English', 'Hindi', 'Arabic', 'Malay', 'Indonesian'] as const;
export type VideoLanguage = (typeof VIDEO_LANGUAGES)[number];

export const VIDEO_EMOTIONS = ['happy', 'neutral', 'surprised'] as const;
export type VideoEmotion = (typeof VIDEO_EMOTIONS)[number];

/** How the model moves and how the camera moves, sent as the video prompt. */
export const VIDEO_STYLES = {
  gesture: {
    walk: 'walking confidently towards the camera like on a fashion runway',
    'walk-turn': 'walking towards the camera, stopping and turning around once to show the outfit',
    pose: 'striking a few elegant fashion poses, one after another',
    presenting: 'presenting the outfit to the camera with natural, friendly hand gestures',
    calm: 'standing calmly with small natural movements while talking',
    excited: 'energetic and excited, expressive hand gestures',
    turn: 'turning slightly left and right to show the outfit while talking',
  },
  camera: {
    follow: 'the camera tracks the model smoothly, following the movement',
    orbit: 'the camera slowly circles around the model',
    static: 'the camera stays still',
    'zoom-in': 'the camera slowly zooms in',
    'zoom-out': 'the camera slowly zooms out to show the full outfit',
    pan: 'the camera slowly pans from side to side',
  },
} as const;
export type VideoStyle = {
  gesture?: keyof typeof VIDEO_STYLES.gesture;
  camera?: keyof typeof VIDEO_STYLES.camera;
};

export function videoPrompt(style: VideoStyle = {}, note?: string, script?: string, silent = false): string {
  const gesture = style.gesture && VIDEO_STYLES.gesture[style.gesture];
  const camera = style.camera && VIDEO_STYLES.camera[style.camera];
  return [
    'A fashion model in a product video for an online clothing shop.',
    'Keep the face, outfit and background exactly as in the photo; the outfit must not change.',
    gesture ? `The model is ${gesture}.` : '',
    camera ? `Camera: ${camera}.` : '',
    note ? note : '',
    // The walk model speaks what the prompt quotes; it reads English best in lowercase.
    silent
      ? 'The model does not talk; no speech.'
      : script
        ? `The model looks at the camera and says: "${script.replace(/"/g, "'").toLowerCase()}"`
        : 'Natural lip movement matched to the voice.',
  ]
    .filter(Boolean)
    .join(' ');
}

/** A fal model page link or id typed by the admin, as an endpoint id. */
function endpointId(input?: string): string {
  return (input ?? '').trim().replace(/^https?:\/\/(www\.)?fal\.ai\/models\//, '').replace(/^https?:\/\/(queue\.)?fal\.run\//, '').replace(/[?#].*$/, '').replace(/\/(api|playground)$/, '').replace(/^\/+|\/+$/g, '');
}

/** What a walk-and-talk second costs, for the price shown before generating. */
export function videoPricePerSecond(model: string): number {
  return VIDEO_PRICES[model] ?? 0.14;
}

export interface FalVideoOptions {
  apiKey: string;
  /** The talking-avatar endpoint; Kling AI Avatar v2 Standard unless set. */
  model?: string;
  /** The walk-and-talk endpoint; Kling 2.6 Pro image-to-video unless set. */
  walkModel?: string;
  voiceModel?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  pollMs?: number;
}

export interface SpeakRequest {
  text: string;
  voice?: VideoVoice;
  language?: VideoLanguage;
  emotion?: VideoEmotion;
}

export interface TalkResult {
  video: { bytes: Uint8Array; contentType: string };
  durationSec: number;
  costUsd: number;
}

export class FalVideo {
  readonly model: string;
  readonly walkModel: string;
  readonly voiceModel: string;
  private readonly voiceModels: string[];
  private readonly o: { apiKey: string; baseUrl: string; fetch: typeof fetch; pollMs: number };

  constructor(options: FalVideoOptions) {
    this.model = endpointId(options.model) || DEFAULT_VIDEO_MODEL;
    this.walkModel = endpointId(options.walkModel) || DEFAULT_WALK_MODEL;
    const voice = endpointId(options.voiceModel);
    this.voiceModels = voice ? [voice] : VOICE_MODELS;
    this.voiceModel = this.voiceModels[0]!;
    this.o = {
      apiKey: options.apiKey,
      baseUrl: (options.baseUrl ?? 'https://queue.fal.run').replace(/\/+$/, ''),
      fetch: options.fetch ?? fetch,
      pollMs: options.pollMs ?? 4000,
    };
  }

  /** What a video of this many seconds costs, with a voice made from this many characters. */
  costUsd(seconds: number, scriptChars = 0): number {
    return seconds * (VIDEO_PRICES[this.model] ?? 0.0562) + (scriptChars / 1000) * VOICE_PRICE_PER_1000;
  }

  /** Turns the script into speech. Returns a link to the audio on fal. */
  async speak(req: SpeakRequest, signal?: AbortSignal): Promise<{ audioUrl: string; durationSec: number }> {
    let out: { audio?: { url?: string }; duration_ms?: number } | undefined;
    for (const [i, model] of this.voiceModels.entries()) {
      try {
        out = (await this.run(model, voiceInput(model, req), 'voice', signal)) as typeof out;
        break;
      } catch (err) {
        // A model this key can't use (or that fal removed): try the next one.
        const closed = err instanceof TryOnError && /\b(401|403|404)\b|does not have access|no model called/i.test(`${err.message} ${err.userMessage}`);
        if (!closed || i === this.voiceModels.length - 1 || /balance|locked/i.test(err instanceof TryOnError ? err.userMessage : '')) throw err;
      }
    }
    const audioUrl = out?.audio?.url;
    if (!audioUrl) throw new TryOnError('fal.ai speech finished without audio', 'The voice could not be made. Try a shorter or simpler script.');
    return { audioUrl, durationSec: (out?.duration_ms ?? 0) / 1000 };
  }

  /**
   * Walk and talk: one model makes the motion, the camera move and the speech
   * (from the script in the prompt). 5 or 10 seconds.
   */
  async walk(req: { imageUrl: string; prompt: string; seconds: 5 | 10; silent?: boolean }, signal?: AbortSignal): Promise<TalkResult> {
    const model = this.walkModel;
    const out = (await this.run(model, { start_image_url: req.imageUrl, prompt: req.prompt, duration: String(req.seconds), generate_audio: !req.silent }, 'video', signal)) as {
      video?: { url?: string; content_type?: string };
      duration?: number;
    };
    const video = await this.download(out.video, signal);
    const durationSec = out.duration ?? req.seconds;
    // Without sound, fal charges half for Kling.
    return { video, durationSec, costUsd: durationSec * (VIDEO_PRICES[model] ?? 0.14) * (req.silent ? 0.5 : 1) };
  }

  /** Animates the photo to the voice and downloads the finished video. */
  async talk(req: { imageUrl: string; audioUrl: string; prompt: string; scriptChars?: number }, signal?: AbortSignal): Promise<TalkResult> {
    const out = (await this.run(this.model, { image_url: req.imageUrl, audio_url: req.audioUrl, prompt: req.prompt }, 'video', signal)) as {
      video?: { url?: string; content_type?: string };
      duration?: number;
    };
    const video = await this.download(out.video, signal);
    const durationSec = out.duration ?? 0;
    return { video, durationSec, costUsd: this.costUsd(durationSec, req.scriptChars) };
  }

  /** fal's links expire, so the video is downloaded and stored by us. */
  private async download(file: { url?: string; content_type?: string } | undefined, signal?: AbortSignal) {
    if (!file?.url) throw new TryOnError('fal.ai finished without a video', 'The AI could not make this video. Try another photo.');
    const res = await this.o.fetch(file.url, { signal });
    if (!res.ok) throw new TryOnError(`Downloading the video failed (${res.status})`, 'The video was made but could not be saved. Try again.');
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: file.content_type || res.headers.get('content-type')?.split(';')[0] || 'video/mp4' };
  }

  /** Submits to fal's queue, waits for it, and returns the result JSON. */
  private async run(model: string, input: unknown, what: 'voice' | 'video', signal?: AbortSignal): Promise<unknown> {
    const headers = { authorization: `Key ${this.o.apiKey}`, 'content-type': 'application/json' };
    const start = await this.o.fetch(`${this.o.baseUrl}/${model}`, { method: 'POST', headers, body: JSON.stringify(input), signal });
    const started = (await start.json().catch(() => ({}))) as { request_id?: string; status_url?: string; response_url?: string; detail?: unknown };
    if (!start.ok || !started.request_id) {
      const detail = started.detail ? falDetail(started.detail) : '';
      const message =
        start.status === 403 && /balance|locked/i.test(detail)
          ? 'The fal.ai account is out of balance. Top it up at fal.ai/dashboard/billing.'
          : start.status === 401 || start.status === 403
            ? 'The fal.ai API key was refused. Check it under Platform settings.'
            : start.status === 404
              ? `fal.ai has no model called ${model}. Check the video model under Platform settings.`
              : `fal.ai error ${start.status}${detail ? `: ${detail}` : ''}.`;
      throw new TryOnError(`fal.ai ${what} submit to ${model} failed (${start.status}): ${JSON.stringify(started.detail ?? started)}`, message);
    }
    const app = model.split('/').slice(0, 2).join('/');
    const statusUrl = started.status_url ?? `${this.o.baseUrl}/${app}/requests/${started.request_id}/status`;
    const responseUrl = started.response_url ?? `${this.o.baseUrl}/${app}/requests/${started.request_id}`;
    for (;;) {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new TryOnError('Stopped waiting', 'The video took too long. Try again.'));
        const t = setTimeout(resolve, this.o.pollMs);
        signal?.addEventListener('abort', () => (clearTimeout(t), reject(new TryOnError('Stopped waiting', 'The video took too long. Try again.'))), { once: true });
      });
      const res = await this.o.fetch(statusUrl, { headers, signal });
      if (res.status === 429 || res.status >= 500) continue;
      const st = (await res.json().catch(() => ({}))) as { status?: string; error?: string; error_type?: string };
      if (st.error) throw new TryOnError(`fal.ai ${what} ${st.error_type ?? 'error'}: ${st.error}`, `The AI could not make this ${what}: ${st.error}`);
      if (st.status !== 'COMPLETED') continue;
      const out = await this.o.fetch(responseUrl, { headers, signal });
      const body = (await out.json().catch(() => ({}))) as { detail?: unknown };
      if (!out.ok) {
        const detail = falDetail(body.detail ?? body);
        const blocked = /content|safety|policy/i.test(detail);
        throw new TryOnError(
          `fal.ai ${what} result ${out.status}: ${detail}`,
          blocked ? 'The AI service’s content rules refused this. Try another photo or script.' : `The AI could not make this ${what}: ${detail}`,
        );
      }
      return body;
    }
  }
}
