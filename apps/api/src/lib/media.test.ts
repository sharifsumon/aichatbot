import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { clipLengths, ffmpegMedia, splitScript } from './media.ts';

let hasFfmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  hasFfmpeg = false;
}

test('lengths up to 60 seconds become 10-second clips and one 5-second clip', () => {
  assert.deepEqual(clipLengths(5), [5]);
  assert.deepEqual(clipLengths(10), [10]);
  assert.deepEqual(clipLengths(15), [10, 5]);
  assert.deepEqual(clipLengths(45), [10, 10, 10, 10, 5]);
  assert.deepEqual(clipLengths(60), [10, 10, 10, 10, 10, 10]);
});

test('the script is shared out between clips, cutting between sentences', () => {
  assert.deepEqual(splitScript('Hello there.', 1), ['Hello there.']);
  const parts = splitScript('Welcome to our shop. This dress is pure cotton. It comes in three colours. Order today!', 2);
  assert.equal(parts.length, 2);
  assert.equal(parts.join(' '), 'Welcome to our shop. This dress is pure cotton. It comes in three colours. Order today!');
  assert.ok(parts.every((p) => p.length > 0));
  const short = splitScript('Hi!', 3);
  assert.deepEqual(short, ['Hi!', '', '']);
  const long = splitScript(Array(60).fill('word').join(' '), 3);
  assert.equal(long.length, 3);
  assert.ok(long.every((p) => p.split(' ').length >= 15));
});

test('ffmpeg takes the last frame and joins clips', { skip: hasFfmpeg ? false : 'ffmpeg not installed' }, async () => {
  const clip = (color: string) =>
    new Uint8Array(
      execFileSync('ffmpeg', [
        '-v', 'error',
        '-f', 'lavfi', '-i', `color=c=${color}:s=64x64:d=1`,
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
        '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov', 'pipe:1',
      ]),
    );
  const a = clip('red');
  const b = clip('blue');
  const frame = await ffmpegMedia.lastFrame(a);
  assert.deepEqual([...frame.slice(0, 2)], [0xff, 0xd8]);
  const joined = await ffmpegMedia.concat([a, b]);
  const seconds = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', '-i', 'pipe:0'], { input: joined }).toString());
  assert.ok(seconds > 1.8 && seconds < 2.3, `joined video lasts ${seconds}s`);
});
