export interface ChunkOptions {
  /** Upper bound per chunk, in characters. ~1,200 characters is ~300–400 tokens. */
  maxChars?: number;
  /** Characters repeated from the end of one chunk at the start of the next. */
  overlap?: number;
}

/** Bangla sentences end with the danda (।); English with . ! ? */
const SENTENCE_END = /(?<=[।!?.])\s+/u;

/**
 * Splits text into chunks for embedding: paragraphs first, then sentences,
 * then hard cuts for anything still too long. Works for Bangla and English.
 */
export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const maxChars = options.maxChars ?? 1200;
  const overlap = Math.min(options.overlap ?? 150, Math.floor(maxChars / 4));

  const pieces = normalise(text)
    .split(/\n{2,}/)
    .flatMap((p) => (p.length <= maxChars ? [p] : p.split(SENTENCE_END)))
    .flatMap((s) => hardSplit(s, maxChars))
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (current && current.length + piece.length + 2 > maxChars) {
      chunks.push(current);
      const tail = overlap ? current.slice(-overlap) : '';
      // Start the overlap at a word boundary so chunks don't begin mid-word.
      const carry = tail.includes(' ') ? tail.slice(tail.indexOf(' ') + 1) : '';
      current = carry && carry.length + piece.length + 2 <= maxChars ? `${carry}\n\n${piece}` : piece;
    } else {
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** One chunk per row group for tables, so a product row is never split in half. */
export function chunkLines(lines: string[], maxChars = 1200): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of lines.map((l) => l.trim()).filter(Boolean)) {
    if (current && current.length + line.length + 1 > maxChars) {
      chunks.push(current);
      current = '';
    }
    current = current ? `${current}\n${line}` : line;
  }
  if (current) chunks.push(...hardSplit(current, maxChars));
  return chunks;
}

/** Q&A pairs stay whole: one chunk per pair. */
export function chunkQa(pairs: { question: string; answer: string }[]): string[] {
  return pairs
    .map((p) => ({ q: p.question.trim(), a: p.answer.trim() }))
    .filter((p) => p.q && p.a)
    .map((p) => `Q: ${p.q}\nA: ${p.a}`);
}

function normalise(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function hardSplit(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    const cut = window.lastIndexOf(' ');
    const at = cut > maxChars / 2 ? cut : maxChars;
    out.push(rest.slice(0, at));
    rest = rest.slice(at).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}
