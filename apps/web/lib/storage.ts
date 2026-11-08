/** Small browser-only notes that survive the Facebook sign-in round trip. */
export const INVITE_KEY = 'agently_invite';

export function readOnce(key: string): string | null {
  try {
    const v = localStorage.getItem(key);
    localStorage.removeItem(key);
    return v;
  } catch {
    return null;
  }
}

export function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: the person just opens the link again */
  }
}
