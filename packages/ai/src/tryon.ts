/**
 * Virtual try-on: put a garment from one photo on the person in another.
 * The shop dashboard's "Generate product image with models" uses this.
 * Two services are supported; the server's settings pick one.
 */

export type GarmentCategory = 'auto' | 'tops' | 'bottoms' | 'one-pieces';
export const GARMENT_CATEGORIES: GarmentCategory[] = ['auto', 'tops', 'bottoms', 'one-pieces'];

export interface TryOnImage {
  bytes: Uint8Array;
  contentType: string;
}

export interface TryOnRequest {
  model: TryOnImage;
  garment: TryOnImage;
  category: GarmentCategory;
  /** Optional extra words from the shop, e.g. "full length, plain studio background". */
  note?: string;
}

export interface TryOnResult {
  image: TryOnImage;
  /** What this photo cost the platform, in US dollars. */
  costUsd: number;
}

export interface TryOnProvider {
  /** fashn or gemini. */
  readonly name: string;
  readonly model: string;
  tryOn(request: TryOnRequest, signal?: AbortSignal): Promise<TryOnResult>;
}

export class TryOnError extends Error {
  /** A message safe to show the shop, e.g. "We couldn't find a person in the model photo". */
  readonly userMessage: string;
  constructor(message: string, userMessage = 'The AI could not make this photo. Try another garment photo.') {
    super(message);
    this.name = 'TryOnError';
    this.userMessage = userMessage;
  }
}

type Fetch = typeof fetch;
const dataUri = (img: TryOnImage) => `data:${img.contentType};base64,${Buffer.from(img.bytes).toString('base64')}`;
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((ok, fail) => {
    const t = setTimeout(ok, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), fail(signal.reason)), { once: true });
  });

async function download(f: Fetch, url: string, signal?: AbortSignal): Promise<TryOnImage> {
  const res = await f(url, { signal });
  if (!res.ok) throw new TryOnError(`Downloading the result failed (${res.status})`);
  return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('content-type')?.split(';')[0] || 'image/png' };
}

function fromDataUri(uri: string): TryOnImage {
  const m = /^data:([\w/+.-]+);base64,(.*)$/s.exec(uri);
  if (!m) throw new TryOnError('Unexpected image data in the result');
  return { contentType: m[1]!, bytes: new Uint8Array(Buffer.from(m[2]!, 'base64')) };
}

export interface FashnOptions {
  apiKey: string;
  /** tryon-v1.6 unless set. */
  model?: string;
  /** performance, balanced or quality. */
  mode?: 'performance' | 'balanced' | 'quality';
  /** What one photo costs, for the usage page. */
  costPerImageUsd?: number;
  baseUrl?: string;
  fetch?: Fetch;
  /** Between status checks; tests set it to 0. */
  pollMs?: number;
}

/** FASHN (fashn.ai): a model built for clothing try-on. Starts a run, then polls its status. */
export class FashnTryOn implements TryOnProvider {
  readonly name = 'fashn';
  readonly model: string;
  private readonly o: Required<Omit<FashnOptions, 'model'>>;

  constructor(options: FashnOptions) {
    this.model = options.model || 'tryon-v1.6';
    this.o = {
      apiKey: options.apiKey,
      mode: options.mode ?? 'quality',
      costPerImageUsd: options.costPerImageUsd ?? 0.075,
      baseUrl: (options.baseUrl ?? 'https://api.fashn.ai/v1').replace(/\/+$/, ''),
      fetch: options.fetch ?? fetch,
      pollMs: options.pollMs ?? 2000,
    };
  }

  async tryOn(req: TryOnRequest, signal?: AbortSignal): Promise<TryOnResult> {
    const headers = { authorization: `Bearer ${this.o.apiKey}`, 'content-type': 'application/json' };
    const start = await this.o.fetch(`${this.o.baseUrl}/run`, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({
        model_name: this.model,
        inputs: {
          model_image: dataUri(req.model),
          garment_image: dataUri(req.garment),
          category: req.category,
          mode: this.o.mode,
          output_format: 'jpeg',
          return_base64: true,
        },
      }),
    });
    const started = (await start.json().catch(() => ({}))) as { id?: string; error?: unknown; message?: string };
    if (!start.ok || !started.id) {
      throw new TryOnError(`FASHN run failed (${start.status}): ${started.message ?? JSON.stringify(started.error)}`, 'The try-on service refused the request. Try again in a minute.');
    }

    // Runs usually finish in 10–20 seconds.
    for (let i = 0; i < 90; i++) {
      await sleep(this.o.pollMs, signal);
      const res = await this.o.fetch(`${this.o.baseUrl}/status/${encodeURIComponent(started.id)}`, { headers, signal });
      if (res.status === 429 || res.status >= 500) continue;
      const s = (await res.json().catch(() => ({}))) as { status?: string; output?: string[]; error?: { name?: string; message?: string } | null };
      if (s.status === 'completed') {
        const out = s.output?.[0];
        if (!out) throw new TryOnError('FASHN finished without an image');
        const image = out.startsWith('data:') ? fromDataUri(out) : await download(this.o.fetch, out, signal);
        return { image, costUsd: this.o.costPerImageUsd };
      }
      if (s.status === 'failed') throw new TryOnError(`FASHN ${s.error?.name}: ${s.error?.message}`, fashnMessage(s.error?.name));
    }
    throw new TryOnError('FASHN took too long', 'The try-on took too long. Try again.');
  }
}

function fashnMessage(name?: string): string {
  if (name === 'PoseError') return 'The AI could not find a clear person in the model photo, or a clear garment in yours. Try a straight, well-lit garment photo.';
  if (name === 'ImageLoadError') return 'The AI could not open one of the photos. Upload the garment photo again as JPEG or PNG.';
  if (name === 'ContentModerationError') return 'The photo was refused by the AI service’s content rules.';
  return 'The AI could not make this photo. Try another garment photo.';
}

export interface GeminiOptions {
  apiKey: string;
  /** e.g. gemini-2.5-flash-image. */
  model?: string;
  costPerImageUsd?: number;
  baseUrl?: string;
  fetch?: Fetch;
}

const CATEGORY_WORDS: Record<GarmentCategory, string> = {
  auto: 'the garment',
  tops: 'the top',
  bottoms: 'the bottom wear',
  'one-pieces': 'the full outfit',
};

/** Google Gemini's image model ("Nano Banana"): a general image editor told to dress the model. */
export class GeminiTryOn implements TryOnProvider {
  readonly name = 'gemini';
  readonly model: string;
  private readonly o: Required<Omit<GeminiOptions, 'model'>>;

  constructor(options: GeminiOptions) {
    this.model = options.model || 'gemini-2.5-flash-image';
    this.o = {
      apiKey: options.apiKey,
      costPerImageUsd: options.costPerImageUsd ?? 0.039,
      baseUrl: (options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, ''),
      fetch: options.fetch ?? fetch,
    };
  }

  async tryOn(req: TryOnRequest, signal?: AbortSignal): Promise<TryOnResult> {
    const what = CATEGORY_WORDS[req.category];
    const prompt = [
      `The first image is a fashion model. The second image shows ${what} a shop sells.`,
      `Make a realistic e-commerce product photo of the same model wearing exactly ${what} from the second image.`,
      'Keep the model’s face, body, skin tone, hair and pose unchanged, and keep the background.',
      'Copy the garment faithfully: colour, print, embroidery, fabric texture, neckline, sleeves and length.',
      'Do not add text, logos or watermarks.',
      req.note ? `Also: ${req.note}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    const inline = (img: TryOnImage) => ({ inline_data: { mime_type: img.contentType, data: Buffer.from(img.bytes).toString('base64') } });
    const res = await this.o.fetch(`${this.o.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`, {
      method: 'POST',
      signal,
      headers: { 'x-goog-api-key': this.o.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }, inline(req.model), inline(req.garment)] }],
        generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '3:4' } },
      }),
    });
    type Part = { inlineData?: { mimeType: string; data: string }; inline_data?: { mime_type: string; data: string }; text?: string };
    const body = (await res.json().catch(() => ({}))) as {
      candidates?: { content?: { parts?: Part[] }; finishReason?: string }[];
      promptFeedback?: { blockReason?: string };
      error?: { message?: string };
    };
    if (!res.ok) throw new TryOnError(`Gemini failed (${res.status}): ${body.error?.message ?? ''}`, 'The image AI refused the request. Try again in a minute.');
    if (body.promptFeedback?.blockReason) throw new TryOnError(`Gemini blocked: ${body.promptFeedback.blockReason}`, 'The photo was refused by the AI service’s content rules.');
    for (const part of body.candidates?.[0]?.content?.parts ?? []) {
      const d = part.inlineData ?? (part.inline_data && { mimeType: part.inline_data.mime_type, data: part.inline_data.data });
      if (d?.data) return { image: { contentType: d.mimeType, bytes: new Uint8Array(Buffer.from(d.data, 'base64')) }, costUsd: this.o.costPerImageUsd };
    }
    throw new TryOnError(`Gemini returned no image (${body.candidates?.[0]?.finishReason ?? 'no candidates'})`);
  }
}

/** Reads TRYON_* settings; undefined when no service is configured. */
export function tryOnFromEnv(env: Record<string, string | undefined> = process.env): TryOnProvider | undefined {
  const provider = (env.TRYON_PROVIDER || 'fashn').toLowerCase();
  const apiKey = env.TRYON_API_KEY;
  if (!apiKey) return undefined;
  const cost = env.TRYON_COST_PER_IMAGE_USD ? Number(env.TRYON_COST_PER_IMAGE_USD) : undefined;
  if (provider === 'gemini') return new GeminiTryOn({ apiKey, model: env.TRYON_MODEL, costPerImageUsd: cost });
  if (provider === 'fashn') return new FashnTryOn({ apiKey, model: env.TRYON_MODEL, costPerImageUsd: cost, mode: (env.TRYON_MODE as FashnOptions['mode']) || undefined });
  throw new Error(`TRYON_PROVIDER must be fashn or gemini, not ${provider}`);
}
