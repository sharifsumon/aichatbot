/** Hands photos or a video picked in the Media library to the Page posts composer. */
const KEY = 'agently_post_media';

export interface PostMedia {
  photos?: string[];
  video?: string;
}

export function sendToPost(media: PostMedia) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(media));
  } catch {
    /* private mode: the composer just opens empty */
  }
}

/** Reads and clears what the Media library handed over, if anything. */
export function takePostMedia(): PostMedia | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    sessionStorage.removeItem(KEY);
    const v = JSON.parse(raw) as PostMedia;
    return {
      photos: Array.isArray(v.photos) ? v.photos.filter((u) => typeof u === 'string') : undefined,
      video: typeof v.video === 'string' ? v.video : undefined,
    };
  } catch {
    return null;
  }
}
