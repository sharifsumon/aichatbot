import { createHmac, timingSafeEqual } from 'node:crypto';
import { GraphApiError } from './graph.ts';

/** Permissions Phase 1 asks for: list pages, read and answer messages and comments. */
export const FACEBOOK_SCOPES = [
  'public_profile',
  'email',
  'pages_show_list',
  'pages_manage_metadata',
  'pages_messaging',
  'pages_read_engagement',
  'pages_read_user_content',
  'pages_manage_engagement',
];

/** Webhook fields each connected page is subscribed to. */
export const PAGE_SUBSCRIBED_FIELDS = ['messages', 'messaging_postbacks', 'feed'];

export interface FacebookPage {
  id: string;
  name: string;
  accessToken: string;
  /** What the user may do on the page; MESSAGING and MODERATE are needed for Agently. */
  tasks: string[];
}

export interface FacebookAppOptions {
  appId: string;
  appSecret: string;
  version: string;
  fetch?: typeof fetch;
}

/** Facebook Login and the page calls that need the app secret. */
export class FacebookApp {
  private readonly options: FacebookAppOptions;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FacebookAppOptions) {
    this.options = options;
    this.base = `https://graph.facebook.com/${options.version}`;
    this.fetchImpl = options.fetch ?? fetch;
  }

  loginUrl(redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      client_id: this.options.appId,
      redirect_uri: redirectUri,
      state,
      response_type: 'code',
      scope: FACEBOOK_SCOPES.join(','),
    });
    return `https://www.facebook.com/${this.options.version}/dialog/oauth?${params}`;
  }

  /** Code → short-lived token → long-lived (about 60 days) user token. */
  async exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string; expiresAt?: Date }> {
    const short = await this.call<{ access_token: string }>('GET', '/oauth/access_token', {
      client_id: this.options.appId,
      client_secret: this.options.appSecret,
      redirect_uri: redirectUri,
      code,
    });
    return this.longLivedUserToken(short.access_token);
  }

  /** A short-lived user token (from sign-in or the Graph API Explorer) → a long-lived one. */
  async longLivedUserToken(shortToken: string): Promise<{ accessToken: string; expiresAt?: Date }> {
    const long = await this.call<{ access_token: string; expires_in?: number }>('GET', '/oauth/access_token', {
      grant_type: 'fb_exchange_token',
      client_id: this.options.appId,
      client_secret: this.options.appSecret,
      fb_exchange_token: shortToken,
    });
    return {
      accessToken: long.access_token,
      expiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : undefined,
    };
  }

  async me(userToken: string): Promise<{ id: string; name: string; email?: string }> {
    return this.call('GET', '/me', { fields: 'id,name,email' }, userToken);
  }

  /** Pages the user manages. Page tokens from a long-lived user token do not expire. */
  async pages(userToken: string): Promise<FacebookPage[]> {
    const pages: FacebookPage[] = [];
    let after: string | undefined;
    do {
      const res = await this.call<{
        data: { id: string; name: string; access_token: string; tasks?: string[] }[];
        paging?: { cursors?: { after?: string }; next?: string };
      }>('GET', '/me/accounts', { fields: 'id,name,access_token,tasks', limit: '100', ...(after && { after }) }, userToken);
      pages.push(...res.data.map((p) => ({ id: p.id, name: p.name, accessToken: p.access_token, tasks: p.tasks ?? [] })));
      after = res.paging?.next ? res.paging.cursors?.after : undefined;
    } while (after);
    return pages;
  }

  /** Starts webhook delivery for a page. */
  async subscribePage(pageId: string, pageToken: string): Promise<void> {
    await this.call('POST', `/${pageId}/subscribed_apps`, { subscribed_fields: PAGE_SUBSCRIBED_FIELDS.join(',') }, pageToken);
  }

  async unsubscribePage(pageId: string, pageToken: string): Promise<void> {
    await this.call('DELETE', `/${pageId}/subscribed_apps`, {}, pageToken);
  }

  /** Verifies and decodes a signed_request (data deletion and deauthorize callbacks). */
  parseSignedRequest(signedRequest: string): { user_id: string; issued_at?: number } | null {
    return parseSignedRequest(signedRequest, this.options.appSecret);
  }

  private async call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, string>, token?: string): Promise<T> {
    const query = new URLSearchParams(params);
    if (token) {
      query.set('access_token', token);
      // Proves the call comes from our server, so a leaked token alone can't be used with our app.
      query.set('appsecret_proof', createHmac('sha256', this.options.appSecret).update(token).digest('hex'));
    }
    const res = await this.fetchImpl(`${this.base}${path}?${query}`, { method, signal: AbortSignal.timeout(15_000) });
    const json = (await res.json().catch(() => ({}))) as T & { error?: { message: string; code?: number } };
    if (!res.ok || json.error) {
      throw new GraphApiError(json.error?.message ?? `Graph API returned ${res.status}`, res.status, json.error?.code);
    }
    return json;
  }
}

export function parseSignedRequest(signedRequest: string, appSecret: string): { user_id: string; issued_at?: number } | null {
  const [sig, payload] = signedRequest.split('.');
  if (!sig || !payload) return null;
  const expected = createHmac('sha256', appSecret).update(payload).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { algorithm?: string; user_id?: string; issued_at?: number };
    if (data.algorithm?.toUpperCase() !== 'HMAC-SHA256' || !data.user_id) return null;
    return { user_id: data.user_id, issued_at: data.issued_at };
  } catch {
    return null;
  }
}
