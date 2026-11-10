import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Video helpers for joining clips into one longer video. Needs ffmpeg (installed in the api image). */
export interface Media {
  /** The last frame of a video as a JPEG, to start the next clip from. */
  lastFrame(video: Uint8Array): Promise<Uint8Array>;
  /** Joins clips (same model, same size) into one MP4 with sound. */
  concat(clips: Uint8Array[]): Promise<Uint8Array>;
}

async function inTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'agently-video-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const ffmpegMedia: Media = {
  lastFrame: (video) =>
    inTemp(async (dir) => {
      await writeFile(join(dir, 'in.mp4'), video);
      await run('ffmpeg', ['-v', 'error', '-sseof', '-0.2', '-i', join(dir, 'in.mp4'), '-frames:v', '1', '-q:v', '2', '-update', '1', '-y', join(dir, 'last.jpg')], { timeout: 60_000 });
      return new Uint8Array(await readFile(join(dir, 'last.jpg')));
    }),

  concat: (clips) =>
    inTemp(async (dir) => {
      const names = await Promise.all(
        clips.map(async (c, i) => {
          const name = join(dir, `clip${i}.mp4`);
          await writeFile(name, c);
          return name;
        }),
      );
      const out = join(dir, 'out.mp4');
      // Clips from one model share codecs, so they can be joined without re-encoding.
      await writeFile(join(dir, 'list.txt'), names.map((n) => `file '${n}'`).join('\n'));
      try {
        await run('ffmpeg', ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'), '-c', 'copy', '-movflags', '+faststart', '-y', out], { timeout: 120_000 });
      } catch {
        // Otherwise re-encode: scale every clip to the first one's size and join video and sound.
        const inputs = names.flatMap((n) => ['-i', n]);
        const parts = names.map((_, i) => `[${i}:v]scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1[v${i}];`).join('');
        const streams = names.map((_, i) => `[v${i}][${i}:a]`).join('');
        await run(
          'ffmpeg',
          ['-v', 'error', ...inputs, '-filter_complex', `${parts}${streams}concat=n=${names.length}:v=1:a=1[v][a]`, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-movflags', '+faststart', '-y', out],
          { timeout: 600_000 },
        );
      }
      return new Uint8Array(await readFile(out));
    }),
};

/** Splits a script into `parts` pieces of about the same number of words, cutting between sentences when it can. */
export function splitScript(script: string, parts: number): string[] {
  const text = script.trim();
  if (parts <= 1 || !text) return [text];
  const sentences = text.match(/[^.!?।]+[.!?।]*\s*/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
  const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
  const total = words(text);
  const target = total / parts;
  const out: string[] = [];
  let current: string[] = [];
  let count = 0;
  for (const s of sentences) {
    const w = words(s);
    // A very long sentence is cut into word chunks so every clip gets a share.
    if (w > target * 1.5) {
      const ws = s.split(/\s+/);
      for (let i = 0; i < ws.length; i += Math.ceil(target)) {
        if (current.length) out.push(current.join(' ')), (current = []), (count = 0);
        out.push(ws.slice(i, i + Math.ceil(target)).join(' '));
      }
      continue;
    }
    current.push(s);
    count += w;
    if (count >= target && out.length < parts - 1) out.push(current.join(' ')), (current = []), (count = 0);
  }
  if (current.length) out.push(current.join(' '));
  // Exactly `parts` pieces: merge extras into the last one, pad with empty (silent) clips.
  while (out.length > parts) out.splice(parts - 1, 2, `${out[parts - 1]} ${out[parts]}`);
  while (out.length < parts) out.push('');
  return out;
}

/** 5-second steps up to 60: clips of 10 seconds, and one of 5 for an odd remainder. */
export function clipLengths(seconds: number): (5 | 10)[] {
  const lengths: (5 | 10)[] = Array(Math.floor(seconds / 10)).fill(10);
  if (seconds % 10) lengths.push(5);
  return lengths;
}
