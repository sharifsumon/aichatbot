'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

/** A failed API call, with the HTTP status and the API's own message. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const ApiBase = createContext('');

/** The API's address comes from the server at request time, so one image works on any domain. */
export function ApiProvider({ apiUrl, children }: { apiUrl: string; children: ReactNode }) {
  return <ApiBase.Provider value={apiUrl}>{children}</ApiBase.Provider>;
}

export type Api = <T = unknown>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;

/** Calls the admin API with the admin session cookie. */
export function useApi(): Api {
  const base = useContext(ApiBase);
  return useCallback(
    async <T,>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
      const hasBody = init.body !== undefined;
      let res: Response;
      try {
        res = await fetch(`${base}/admin${path}`, {
          method: init.method ?? 'GET',
          credentials: 'include',
          headers: hasBody ? { 'content-type': 'application/json' } : undefined,
          body: hasBody ? JSON.stringify(init.body) : undefined,
        });
      } catch {
        throw new ApiError(0, 'Could not reach the Agently API. Check your connection and try again.');
      }
      if (res.status === 204) return undefined as T;
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new ApiError(res.status, data.error ?? `Something went wrong (${res.status})`);
      return data as T;
    },
    [base],
  );
}

export interface Loaded<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  reload: () => void;
}

/** Loads a GET endpoint; a lapsed session goes back to sign-in. Pass null to wait. */
export function useLoad<T>(path: string | null): Loaded<T> {
  const api = useApi();
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: path !== null });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (path === null) return;
    let live = true;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    api<T>(path)
      .then((data) => live && setState({ data, loading: false }))
      .catch((e: ApiError) => {
        if (!live) return;
        if (e.status === 401) window.location.href = '/login';
        setState((s) => ({ data: s.data, error: e.message, loading: false }));
      });
    return () => {
      live = false;
    };
  }, [api, path, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { data: state.data, error: state.error, loading: state.loading, reload };
}

/** Builds a query string, leaving out empty values. */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '' && v !== false) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Sends a form with one file (and text fields first) as multipart/form-data. */
export function useUpload() {
  const base = useContext(ApiBase);
  return useCallback(
    async <T,>(path: string, file: File, fields: Record<string, string> = {}): Promise<T> => {
      const form = new FormData();
      // Text fields go before the file, so the API can read them with it.
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      form.append('file', file);
      let res: Response;
      try {
        res = await fetch(`${base}/admin${path}`, { method: 'POST', credentials: 'include', body: form, signal: AbortSignal.timeout(120_000) });
      } catch {
        throw new ApiError(0, 'The upload did not finish. Check your connection and try again.');
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new ApiError(res.status, data.error ?? `Upload failed (${res.status})`);
      return data as T;
    },
    [base],
  );
}
