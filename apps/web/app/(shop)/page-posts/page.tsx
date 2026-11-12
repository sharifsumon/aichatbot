'use client';

import { useMemo, useRef, useState } from 'react';
import { useShop } from '@/components/Shell';
import { Empty, Loading, Notice, TopBar } from '@/components/ui';
import { ApiError, useApi, useLoad, useUpload } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { shrinkImage } from '@/lib/image';

/** Same limits as the API. */
const MAX_TEXT = 5000;
const MAX_PHOTOS = 10;
const MAX_VIDEO_MB = 100;

interface PagePost {
  id: string;
  postId: string;
  message: string;
  photoUrls: string[];
  videoUrl: string | null;
  url: string;
  pageName: string;
  createdAt: string;
}

/** "What's on your mind?" for the shop's Facebook page: text with photos or a video, posted straight to the page. */
export default function PagePostsPage() {
  const { ws, home, manager } = useShop();
  const api = useApi();
  const upload = useUpload();
  const past = useLoad<{ posts: PagePost[] }>(`${ws}/page-posts`);
  const pages = useMemo(() => (home?.channels ?? []).filter((c) => c.type === 'facebook_page' && c.status !== 'disconnected'), [home]);
  const [channelId, setChannelId] = useState('');
  const page = pages.find((p) => p.id === channelId) ?? pages.find((p) => p.status === 'connected') ?? pages[0];
  const [message, setMessage] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [video, setVideo] = useState('');
  const [uploading, setUploading] = useState<string>();
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<{ url: string; pageName: string }>();
  const photoInput = useRef<HTMLInputElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);
  const busy = posting || !!uploading;

  async function addPhotos(files: File[]) {
    const room = MAX_PHOTOS - photos.length;
    const list = files.slice(0, room);
    setError(undefined);
    try {
      for (let i = 0; i < list.length; i++) {
        setUploading(`Uploading photo ${i + 1} of ${list.length}…`);
        const r = await upload<{ url: string }>(`${ws}/uploads/images`, await shrinkImage(list[i]!), 60_000);
        setPhotos((cur) => [...cur, r.url]);
      }
      if (files.length > room) setError(`Only ${MAX_PHOTOS} photos fit in one post.`);
    } catch (e) {
      setError((e as ApiError).status === 503 ? 'Uploads are not switched on yet.' : (e as Error).message);
    } finally {
      setUploading(undefined);
      if (photoInput.current) photoInput.current.value = '';
    }
  }

  async function addVideo(f: File | undefined) {
    if (!f) return;
    if (f.size > MAX_VIDEO_MB * 1024 * 1024) return setError(`A video can be at most ${MAX_VIDEO_MB} MB.`);
    setError(undefined);
    setUploading('Uploading video…');
    try {
      const r = await upload<{ url: string }>(`${ws}/uploads/videos`, f, 10 * 60_000);
      setVideo(r.url);
    } catch (e) {
      setError((e as ApiError).status === 503 ? 'Uploads are not switched on yet.' : (e as Error).message);
    } finally {
      setUploading(undefined);
      if (videoInput.current) videoInput.current.value = '';
    }
  }

  async function post() {
    if (!page) return setError('Connect your Facebook page in Settings first.');
    if (!message.trim() && !photos.length && !video) return setError('Write something, or add photos or a video.');
    setPosting(true);
    setError(undefined);
    setDone(undefined);
    try {
      const r = await api<{ post: { url: string; pageName: string } }>(`${ws}/page-posts`, {
        method: 'POST',
        body: { channelId: page.id, message: message.trim(), ...(video ? { videoUrl: video } : { photoUrls: photos }) },
      });
      setDone(r.post);
      setMessage('');
      setPhotos([]);
      setVideo('');
      past.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPosting(false);
    }
  }

  return (
    <>
      <TopBar title="Page posts" />
      <div className="content narrow">
        {manager && (
          <section className="card pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {pages.length === 0 && <Notice tone="warn">Connect your Facebook page in Settings first, then come back to post.</Notice>}
            {page && page.status !== 'connected' && <Notice tone="warn">{page.name} needs to be reconnected in Settings before you can post.</Notice>}
            {pages.length > 1 && (
              <label className="field">
                Page
                <select value={page?.id ?? ''} onChange={(e) => setChannelId(e.target.value)}>
                  {pages.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="field">
              What&rsquo;s on your mind?
              <textarea rows={5} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={MAX_TEXT} placeholder="Eid collection is here! Limited stock, order today 🔥" />
              <small className="muted">
                {message.length} / {MAX_TEXT}
              </small>
            </label>

            {photos.length > 0 && (
              <div className="photos">
                {photos.map((url, i) => (
                  <div key={url} className="shot">
                    <div className="img">
                      <img src={url} alt={`Photo ${i + 1}`} />
                    </div>
                    <button type="button" className="btn link" style={{ fontSize: 12, padding: 6 }} onClick={() => setPhotos(photos.filter((u) => u !== url))} disabled={busy}>
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
            {video && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
                <video src={video} controls preload="metadata" style={{ width: '100%', maxWidth: 420, maxHeight: 360, borderRadius: 12, background: '#000' }} />
                <button type="button" className="btn link" onClick={() => setVideo('')} disabled={busy}>
                  Remove video
                </button>
              </div>
            )}

            <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button type="button" className="btn sm" onClick={() => photoInput.current?.click()} disabled={busy || !!video || photos.length >= MAX_PHOTOS}>
                + Photos
              </button>
              <button type="button" className="btn sm" onClick={() => videoInput.current?.click()} disabled={busy || !!video || photos.length > 0}>
                + Video
              </button>
              <input ref={photoInput} type="file" multiple accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => addPhotos([...(e.target.files ?? [])])} />
              <input ref={videoInput} type="file" accept="video/mp4,video/quicktime,video/webm" hidden onChange={(e) => addVideo(e.target.files?.[0])} />
              {uploading && <small className="muted">{uploading}</small>}
              <button type="button" className="btn primary" style={{ marginLeft: 'auto' }} onClick={post} disabled={busy || !page || page.status !== 'connected'}>
                {posting ? 'Posting…' : page ? `Post on ${page.name}` : 'Post'}
              </button>
            </div>
            <small className="muted">
              Up to {MAX_PHOTOS} photos, or one video (MP4, MOV or WebM, up to {MAX_VIDEO_MB} MB). Facebook doesn&rsquo;t allow photos and a video in the same post.
            </small>
            {error && <Notice tone="error">{error}</Notice>}
            {done && (
              <Notice tone="ok">
                Posted on {done.pageName}.{' '}
                <a href={done.url} target="_blank" rel="noreferrer">
                  Open the post
                </a>
                {done.url.includes('/videos/') ? ' Facebook may take a few minutes to finish the video.' : ''}
              </Notice>
            )}
          </section>
        )}

        <section className="card pad" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <strong>Posted from Agently</strong>
          {past.loading && !past.data && <Loading />}
          {past.data && past.data.posts.length === 0 && <Empty>No page posts yet.</Empty>}
          {past.data?.posts.map((p) => (
            <div key={p.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', borderTop: '1px solid var(--line-soft)', paddingTop: 10 }}>
              {p.photoUrls[0] ? (
                <img src={p.photoUrls[0]} alt="" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 8, flex: 'none' }} />
              ) : p.videoUrl ? (
                <video src={p.videoUrl} preload="metadata" muted style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 8, flex: 'none', background: '#000' }} />
              ) : null}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 14, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{p.message ? p.message.slice(0, 200) + (p.message.length > 200 ? '…' : '') : <span className="muted">{p.videoUrl ? 'Video' : `${p.photoUrls.length} photo${p.photoUrls.length === 1 ? '' : 's'}`}</span>}</div>
                <small className="muted">
                  {dateTime(p.createdAt)} on {p.pageName} ·{' '}
                  <a href={p.url} target="_blank" rel="noreferrer">
                    Open on Facebook
                  </a>
                </small>
              </div>
            </div>
          ))}
        </section>
      </div>
    </>
  );
}
