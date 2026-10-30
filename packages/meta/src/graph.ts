/** Messenger's limit per text message. */
const MAX_TEXT = 2000;

export class GraphApiError extends Error {
  readonly status: number;
  /** Meta error code; 190 means the page token is expired or revoked. */
  readonly code?: number;

  constructor(message: string, status: number, code?: number) {
    super(message);
    this.name = 'GraphApiError';
    this.status = status;
    this.code = code;
  }

  get tokenInvalid(): boolean {
    return this.code === 190;
  }

  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export interface GraphClientOptions {
  version: string;
  fetch?: typeof fetch;
}

/** The few Graph API calls Phase 1 needs, all made with a page access token. */
export class GraphClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GraphClientOptions) {
    this.base = `https://graph.facebook.com/${options.version}`;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** Replies in Messenger. Long text is split, since Messenger caps each message at 2000 characters. */
  async sendText(pageToken: string, psid: string, text: string): Promise<string[]> {
    const ids: string[] = [];
    for (const part of splitText(text, MAX_TEXT)) {
      const res = await this.post<{ message_id: string }>('/me/messages', pageToken, {
        recipient: { id: psid },
        messaging_type: 'RESPONSE',
        message: { text: part },
      });
      ids.push(res.message_id);
    }
    return ids;
  }

  /** Public reply under a comment. */
  async replyToComment(pageToken: string, commentId: string, text: string): Promise<string> {
    const res = await this.post<{ id: string }>(`/${commentId}/comments`, pageToken, { message: text });
    return res.id;
  }

  /** The one private Messenger reply a page may send to a commenter. */
  async privateReply(pageToken: string, pageId: string, commentId: string, text: string): Promise<string> {
    const res = await this.post<{ message_id: string }>(`/${pageId}/messages`, pageToken, {
      recipient: { comment_id: commentId },
      message: { text: text.slice(0, MAX_TEXT) },
    });
    return res.message_id;
  }

  private async post<T>(path: string, token: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: { message: string; code?: number } };
    if (!res.ok || json.error) {
      throw new GraphApiError(json.error?.message ?? `Graph API returned ${res.status}`, res.status, json.error?.code);
    }
    return json;
  }
}

/** Splits on paragraph, then line, then word boundaries so no part exceeds max. */
export function splitText(text: string, max: number): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' '));
    const at = cut > max / 2 ? cut : max;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}
