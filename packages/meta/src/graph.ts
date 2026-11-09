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

  /** The page token lacks a permission, e.g. pages_manage_posts on a page connected before posting existed. */
  get permissionMissing(): boolean {
    return this.code === 10 || (this.code !== undefined && this.code >= 200 && this.code < 300);
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

  /** Sends a photo in Messenger by its public URL (product photos). */
  async sendImage(pageToken: string, psid: string, url: string): Promise<string> {
    const res = await this.post<{ message_id: string }>('/me/messages', pageToken, {
      recipient: { id: psid },
      messaging_type: 'RESPONSE',
      message: { attachment: { type: 'image', payload: { url, is_reusable: true } } },
    });
    return res.message_id;
  }

  /** Throws a GraphApiError when the page token no longer works (tokenInvalid for a revoked one). */
  async checkPageToken(pageToken: string): Promise<void> {
    const res = await this.fetchImpl(`${this.base}/me?fields=id`, {
      headers: { authorization: `Bearer ${pageToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: { message: string; code?: number } };
    if (!res.ok || json.error) throw new GraphApiError(json.error?.message ?? `Graph API returned ${res.status}`, res.status, json.error?.code);
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

  /**
   * Publishes a post on the page and returns its id ("{pageId}_{postId}").
   * Needs pages_manage_posts.
   *
   * With a button: a link post with one real button at the bottom. Facebook
   * only allows that on link posts and shows the link's own preview (its
   * og:image) above it. MESSAGE_PAGE opens Messenger; ORDER_NOW opens
   * `target` (default: `link`).
   *
   * Without: the photos are uploaded unpublished first, then attached to one
   * post, so several photos show as one album-style post.
   */
  async publishPost(
    pageToken: string,
    pageId: string,
    post: { message: string } & (
      | { button: { type: 'ORDER_NOW' | 'MESSAGE_PAGE'; link: string; target?: string }; photoUrls?: never }
      | { photoUrls: string[]; button?: never }
    ),
  ): Promise<string> {
    if (post.button) {
      const { button } = post;
      const res = await this.post<{ id: string }>(`/${pageId}/feed`, pageToken, {
        message: post.message,
        link: button.link,
        call_to_action:
          button.type === 'MESSAGE_PAGE'
            ? { type: 'MESSAGE_PAGE', value: { app_destination: 'MESSENGER' } }
            : { type: button.type, value: { link: button.target ?? button.link } },
      });
      return res.id;
    }
    const media: { media_fbid: string }[] = [];
    for (const url of post.photoUrls) {
      // Facebook downloads the photo while we wait, which can take a while.
      const photo = await this.post<{ id: string }>(`/${pageId}/photos`, pageToken, { url, published: false }, 60_000);
      media.push({ media_fbid: photo.id });
    }
    const res = await this.post<{ id: string }>(`/${pageId}/feed`, pageToken, {
      message: post.message,
      ...(media.length ? { attached_media: media } : {}),
    });
    return res.id;
  }

  private async post<T>(path: string, token: string, body: unknown, timeoutMs = 15_000): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
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
