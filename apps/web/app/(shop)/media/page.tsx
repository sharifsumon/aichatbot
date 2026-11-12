'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { AddToProduct } from '@/components/AddToProduct';
import { useShop } from '@/components/Shell';
import { Icon } from '@/components/icons';
import { Chips, Empty, Loading, Notice, TopBar } from '@/components/ui';
import { useLoad } from '@/lib/api';
import { sendToPost } from '@/lib/postMedia';

type Tab = 'images' | 'videos';
type Source = 'all' | 'ai' | 'own';

interface Model {
  id: string;
  own?: boolean;
}
interface TryOnImage {
  id: string;
  characterId: string | null;
  status: 'pending' | 'succeeded' | 'failed';
  resultImageUrl: string | null;
  createdAt: string;
}
interface Video {
  id: string;
  sourceImageUrl: string;
  status: 'pending' | 'succeeded' | 'failed';
  resultVideoUrl: string | null;
  durationSec: number | null;
  createdAt: string;
}

/** Same as Page posts: up to 10 photos in one post. */
const MAX_PHOTOS = 10;

function duration(sec: number | null) {
  if (!sec) return '';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Media library: every image and video the shop made with models, in one place.
 * Pick some and post them on the Page, or add one to a product.
 */
export default function MediaLibraryPage() {
  const { ws, manager } = useShop();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('images');
  const [source, setSource] = useState<Source>('all');
  const [picked, setPicked] = useState<string[]>([]);
  const [adding, setAdding] = useState<string>();
  const [done, setDone] = useState<string>();
  const models = useLoad<{ models: Model[] }>(manager ? `${ws}/try-on/models` : null);
  const images = useLoad<{ images: TryOnImage[] }>(manager ? `${ws}/try-on` : null);
  const videos = useLoad<{ videos: Video[] }>(manager ? `${ws}/videos` : null);

  // Opened as /media?tab=videos (for example from "Videos with models").
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('tab') === 'videos') setTab('videos');
  }, []);
  useEffect(() => setPicked([]), [tab]);

  // While something is being made, check again every few seconds.
  const makingImages = images.data?.images.filter((i) => i.status === 'pending').length ?? 0;
  const makingVideos = videos.data?.videos.filter((v) => v.status === 'pending').length ?? 0;
  const { reload: reloadImages } = images;
  const { reload: reloadVideos } = videos;
  useEffect(() => {
    if (!makingImages) return;
    const t = setInterval(reloadImages, 4000);
    return () => clearInterval(t);
  }, [makingImages, reloadImages]);
  useEffect(() => {
    if (!makingVideos) return;
    const t = setInterval(reloadVideos, 6000);
    return () => clearInterval(t);
  }, [makingVideos, reloadVideos]);

  const ownIds = useMemo(() => new Set((models.data?.models ?? []).filter((m) => m.own).map((m) => m.id)), [models.data]);
  const isOwn = (i: TryOnImage) => !!i.characterId && ownIds.has(i.characterId);
  const readyImages = (images.data?.images ?? []).filter((i) => i.status === 'succeeded' && i.resultImageUrl);
  const shownImages = readyImages.filter((i) => source === 'all' || (source === 'own' ? isOwn(i) : !isOwn(i)));
  const readyVideos = (videos.data?.videos ?? []).filter((v) => v.status === 'succeeded' && v.resultVideoUrl);

  // Picked items by id, in the order they were picked.
  const urlOf = (id: string) =>
    tab === 'videos' ? readyVideos.find((v) => v.id === id)?.resultVideoUrl : readyImages.find((i) => i.id === id)?.resultImageUrl;
  const pickedUrls = picked.map(urlOf).filter((u): u is string => !!u);

  function toggle(id: string) {
    if (tab === 'videos') return setPicked((cur) => (cur[0] === id ? [] : [id]));
    setPicked((cur) => (cur.includes(id) ? cur.filter((u) => u !== id) : cur.length >= MAX_PHOTOS ? cur : [...cur, id]));
  }

  function post() {
    sendToPost(tab === 'videos' ? { video: pickedUrls[0] } : { photos: pickedUrls });
    router.push('/page-posts');
  }

  if (!manager) {
    return (
      <>
        <TopBar title="Media library" />
        <div className="content">
          <Notice tone="info">Only the shop owner and admins can use the Media library.</Notice>
        </div>
      </>
    );
  }

  const load = tab === 'images' ? images : videos;

  return (
    <>
      <TopBar title="Media library">
        {tab === 'images' ? (
          <Link href="/generate-image" className="btn primary">
            <Icon.sparkle /> Generate with a model
          </Link>
        ) : (
          <Link href="/model-videos" className="btn primary">
            <Icon.sparkle /> Make a video
          </Link>
        )}
      </TopBar>
      <div className="content">
        <div className="tabs lib-tabs" role="tablist" aria-label="Media">
          {(
            [
              ['images', 'Images', readyImages.length],
              ['videos', 'Videos', readyVideos.length],
            ] as const
          ).map(([v, label, n]) => (
            <button key={v} type="button" role="tab" aria-selected={tab === v} className={`tab${tab === v ? ' on' : ''}`} onClick={() => setTab(v)}>
              {label}
              {n > 0 && <span className="lib-n">{n}</span>}
            </button>
          ))}
        </div>

        {tab === 'images' && (
          <Chips
            label="Show"
            value={source}
            onChange={(v) => {
              setSource(v);
              setPicked([]);
            }}
            options={[
              { value: 'all', label: 'All' },
              { value: 'ai', label: 'AI models' },
              { value: 'own', label: 'Your models' },
            ]}
          />
        )}

        {done && <Notice tone="ok">{done}</Notice>}
        {load.error && <Notice tone="error">{load.error}</Notice>}
        {load.loading && !load.data && <Loading />}

        {(tab === 'images' ? makingImages : makingVideos) > 0 && (
          <div className="lib-making">
            <div className="spinner" aria-hidden="true" />
            {tab === 'images'
              ? `Making ${makingImages} image${makingImages === 1 ? '' : 's'}…`
              : `Making ${makingVideos} video${makingVideos === 1 ? '' : 's'}… this takes a few minutes`}
          </div>
        )}

        {tab === 'images' && images.data && shownImages.length === 0 && (
          <Empty>
            {source === 'own' ? 'No images made with your own models yet.' : 'No images yet.'}{' '}
            <Link href={source === 'own' ? '/model-images?add=model' : '/generate-image'}>{source === 'own' ? 'Add your model' : 'Make your first one'}</Link>.
          </Empty>
        )}
        {tab === 'videos' && videos.data && readyVideos.length === 0 && (
          <Empty>
            No videos yet. <Link href="/model-videos">Make your first one</Link>.
          </Empty>
        )}

        <div className="lib-grid">
          {tab === 'images'
            ? shownImages.map((i) => {
                const url = i.resultImageUrl!;
                const n = picked.indexOf(i.id);
                return (
                  <button key={i.id} type="button" className={`lib-item${n >= 0 ? ' sel' : ''}`} aria-pressed={n >= 0} aria-label={n >= 0 ? 'Unselect image' : 'Select image'} onClick={() => toggle(i.id)}>
                    <img src={url} alt="" loading="lazy" />
                    <span className="lib-check">{n >= 0 ? n + 1 : ''}</span>
                    <span className="lib-tag">{isOwn(i) ? 'Your model' : 'AI model'}</span>
                  </button>
                );
              })
            : readyVideos.map((v) => {
                const url = v.resultVideoUrl!;
                const on = picked[0] === v.id;
                return (
                  <button key={v.id} type="button" className={`lib-item${on ? ' sel' : ''}`} aria-pressed={on} aria-label={on ? 'Unselect video' : 'Select video'} onClick={() => toggle(v.id)}>
                    <video src={url} poster={v.sourceImageUrl} preload="none" muted playsInline />
                    <span className="lib-play" aria-hidden="true">
                      <span>
                        <Icon.play />
                      </span>
                    </span>
                    <span className="lib-check">{on ? '✓' : ''}</span>
                    {v.durationSec ? <span className="lib-dur">{duration(v.durationSec)}</span> : null}
                  </button>
                );
              })}
        </div>
      </div>

      {picked.length > 0 && (
        <div className="lib-bar" role="region" aria-label="Selected">
          <strong>
            {picked.length} selected
            {tab === 'images' && <span className="sub"> · up to {MAX_PHOTOS}</span>}
          </strong>
          <button type="button" className="btn sm" onClick={() => setPicked([])}>
            Clear
          </button>
          {pickedUrls.length === 1 && (
            <a className="btn sm lib-open" href={pickedUrls[0]} target="_blank" rel="noreferrer">
              Open
            </a>
          )}
          <button
            type="button"
            className="btn sm"
            disabled={pickedUrls.length !== 1}
            title={pickedUrls.length !== 1 ? 'Pick one image to add it to a product' : undefined}
            onClick={() => setAdding(pickedUrls[0])}
          >
            Add to product
          </button>
          <button type="button" className="btn sm primary" onClick={post}>
            Post on Page
          </button>
        </div>
      )}

      {adding && (
        <AddToProduct
          url={adding}
          kind={tab === 'videos' ? 'video' : 'photo'}
          onClose={() => setAdding(undefined)}
          onDone={(p) => {
            setAdding(undefined);
            setPicked([]);
            setDone(`Added to ${p.title}. Open the Product Catalog to see it.`);
          }}
        />
      )}
    </>
  );
}
