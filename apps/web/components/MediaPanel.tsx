'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useShop } from '@/components/Shell';
import { Icon } from '@/components/icons';
import { Empty, Loading, Notice } from '@/components/ui';
import { useLoad } from '@/lib/api';

export type MediaKind = 'images' | 'videos';

interface Model {
  id: string;
  name: string;
  gender: 'female' | 'male';
  imageUrl: string;
  own?: boolean;
}
interface TryOnImage {
  id: string;
  characterId: string | null;
  status: 'pending' | 'succeeded' | 'failed';
  resultImageUrl: string | null;
}
interface Video {
  id: string;
  sourceImageUrl: string;
  status: 'pending' | 'succeeded' | 'failed';
  resultVideoUrl: string | null;
  durationSec: number | null;
  options: { progress?: { clip: number; of: number } } | null;
}

/** How many tiles a section shows before "View all". */
const PREVIEW = 6;
const MAX_PICK = 10;

/** The panel that slides out next to the menu: Images (AI models and your models) or Videos. */
export function MediaPanel({ kind, onClose }: { kind: MediaKind; onClose: () => void }) {
  return (
    <aside id="media-panel" className="mpanel" aria-label={kind === 'images' ? 'Images' : 'Videos'}>
      {kind === 'images' ? <ImagesPanel onClose={onClose} /> : <VideosPanel onClose={onClose} />}
    </aside>
  );
}

function Head({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="mp-head">
      <h2>{title}</h2>
      <button type="button" className="icon-btn" aria-label={`Close ${title}`} title="Close" onClick={onClose}>
        <Icon.close />
      </button>
    </div>
  );
}

function Section({ title, count, href, children }: { title: string; count?: number; href: string; children: React.ReactNode }) {
  return (
    <section className="mp-sec">
      <div className="mp-sec-head">
        <h3>{title}</h3>
        {count !== undefined && <span className="mp-count">{count}</span>}
        <Link href={href} className="mp-all">
          View all <Icon.chevron />
        </Link>
      </div>
      {children}
    </section>
  );
}

function ImagesPanel({ onClose }: { onClose: () => void }) {
  const { ws, mediaTarget } = useShop();
  const setup = useLoad<{ models: Model[] }>(`${ws}/try-on/models`);
  const made = useLoad<{ images: TryOnImage[] }>(`${ws}/try-on`);
  const [tab, setTab] = useState<'ai' | 'own'>('ai');
  const [gender, setGender] = useState<'all' | 'female' | 'male'>('all');
  const [picked, setPicked] = useState<string[]>([]);
  const canAdd = !!mediaTarget?.addPhotos;
  const { reload } = made;

  // Keep checking while an image is being made.
  const pending = made.data?.images.filter((i) => i.status === 'pending').length ?? 0;
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(reload, 4000);
    return () => clearInterval(t);
  }, [pending, reload]);
  useEffect(() => setPicked([]), [canAdd]);

  const all = setup.data?.models ?? [];
  const ownIds = useMemo(() => new Set(all.filter((m) => m.own).map((m) => m.id)), [all]);
  const models = all.filter((m) => (tab === 'own' ? m.own : !m.own) && (gender === 'all' || m.gender === gender));
  const results = (made.data?.images ?? []).filter(
    (i) => i.status === 'succeeded' && i.resultImageUrl && (tab === 'own' ? !!i.characterId && ownIds.has(i.characterId) : !i.characterId || !ownIds.has(i.characterId)),
  );

  function toggle(url: string) {
    setPicked((cur) => (cur.includes(url) ? cur.filter((u) => u !== url) : cur.length >= MAX_PICK ? cur : [...cur, url]));
  }

  return (
    <>
      <Head title="Images" onClose={onClose} />
      <div className="mp-tabs" role="tablist" aria-label="Models">
        <button type="button" role="tab" aria-selected={tab === 'ai'} className={tab === 'ai' ? 'on' : ''} onClick={() => setTab('ai')}>
          AI models
        </button>
        <button type="button" role="tab" aria-selected={tab === 'own'} className={tab === 'own' ? 'on' : ''} onClick={() => setTab('own')}>
          Your models
        </button>
      </div>
      <div className="mp-acts">
        <Link href="/model-images" className="btn primary">
          <Icon.sparkle /> Generate
        </Link>
        <Link href={tab === 'own' ? '/model-images?add=model' : '/model-images'} className="btn mp-soft">
          + {tab === 'own' ? 'Add model' : 'Upload garment'}
        </Link>
      </div>
      <div className="mp-scroll">
        {setup.error && <Notice tone="error">{setup.error}</Notice>}
        <Section title={tab === 'own' ? 'Your models' : 'AI models'} count={models.length} href="/model-images">
          <div className="chips mp-chips" role="group" aria-label="Show">
            {(
              [
                ['all', 'All'],
                ['female', 'Women'],
                ['male', 'Men'],
              ] as const
            ).map(([v, l]) => (
              <button key={v} type="button" className={`chip${gender === v ? ' on' : ''}`} aria-pressed={gender === v} onClick={() => setGender(v)}>
                {l}
              </button>
            ))}
          </div>
          {setup.loading && !setup.data && <Loading />}
          {setup.data && models.length === 0 && (
            <Empty>{tab === 'own' ? 'Add a photo of your own model to use it in images.' : 'No models here yet.'}</Empty>
          )}
          <div className="mp-grid">
            {models.slice(0, PREVIEW).map((m) => (
              <Link key={m.id} href={`/model-images?model=${m.id}`} className="mp-tile tall" title={`Make an image with ${m.name}`}>
                <img src={m.imageUrl} alt="" loading="lazy" />
                <span className="mp-cap">{m.name}</span>
              </Link>
            ))}
          </div>
        </Section>
        <Section title={tab === 'own' ? 'Made with your models' : 'Made with AI models'} count={results.length} href="/model-images">
          {pending > 0 && (
            <div className="mp-making">
              <div className="spinner" aria-hidden="true" /> Making {pending} image{pending === 1 ? '' : 's'}…
            </div>
          )}
          {made.loading && !made.data && <Loading />}
          {made.data && results.length === 0 && !pending && <Empty>Images you make show up here.</Empty>}
          <div className="mp-grid">
            {results.slice(0, canAdd ? 12 : PREVIEW).map((i) => {
              const url = i.resultImageUrl!;
              const on = picked.includes(url);
              return canAdd ? (
                <button key={i.id} type="button" className={`mp-tile tall${on ? ' sel' : ''}`} aria-pressed={on} aria-label={on ? 'Unselect image' : 'Select image'} onClick={() => toggle(url)}>
                  <img src={url} alt="" loading="lazy" />
                  <span className="mp-ai">
                    <Icon.sparkle /> AI
                  </span>
                  {on && <span className="mp-check">{picked.indexOf(url) + 1}</span>}
                </button>
              ) : (
                <a key={i.id} href={url} target="_blank" rel="noreferrer" className="mp-tile tall" aria-label="Open image">
                  <img src={url} alt="" loading="lazy" />
                  <span className="mp-ai">
                    <Icon.sparkle /> AI
                  </span>
                </a>
              );
            })}
          </div>
        </Section>
      </div>
      {canAdd && (
        <div className="mp-foot">
          <span>
            {picked.length ? <strong>{picked.length} selected</strong> : 'Tap images to pick them'} · max {MAX_PICK}
          </span>
          {picked.length > 0 && (
            <button type="button" className="btn sm" onClick={() => setPicked([])}>
              Clear
            </button>
          )}
          <button
            type="button"
            className="btn sm primary"
            disabled={!picked.length}
            onClick={() => {
              mediaTarget!.addPhotos!(picked);
              setPicked([]);
            }}
          >
            {mediaTarget!.label}
          </button>
        </div>
      )}
    </>
  );
}

function duration(sec: number | null) {
  if (!sec) return '';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function VideosPanel({ onClose }: { onClose: () => void }) {
  const { ws, mediaTarget } = useShop();
  const load = useLoad<{ videos: Video[] }>(`${ws}/videos`);
  const [picked, setPicked] = useState<string>();
  const canAdd = !!mediaTarget?.addVideo;
  const { reload } = load;
  const making = (load.data?.videos ?? []).filter((v) => v.status === 'pending');
  const ready = (load.data?.videos ?? []).filter((v) => v.status === 'succeeded' && v.resultVideoUrl);

  useEffect(() => {
    if (!making.length) return;
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [making.length, reload]);
  useEffect(() => setPicked(undefined), [canAdd]);

  return (
    <>
      <Head title="Videos" onClose={onClose} />
      <div className="mp-acts">
        <Link href="/model-videos" className="btn primary">
          <Icon.sparkle /> Make a video
        </Link>
        <Link href="/model-videos" className="btn mp-soft">
          View all
        </Link>
      </div>
      <div className="mp-scroll">
        {load.error && <Notice tone="error">{load.error}</Notice>}
        {making.length > 0 && (
          <section className="mp-sec">
            <div className="mp-sec-head">
              <h3>Making</h3>
            </div>
            {making.map((v) => {
              const p = v.options?.progress;
              return (
                <div key={v.id} className="mp-row">
                  <img src={v.sourceImageUrl} alt="" />
                  <div>
                    <strong>Making your video…</strong>
                    <small className="muted">{p ? `Part ${p.clip} of ${p.of}` : 'This takes a few minutes'}</small>
                    <div className="bar">
                      <div style={{ width: `${p ? Math.round((p.clip / p.of) * 100) : 15}%` }} />
                    </div>
                  </div>
                </div>
              );
            })}
          </section>
        )}
        <Section title="Your videos" count={ready.length} href="/model-videos">
          {load.loading && !load.data && <Loading />}
          {load.data && ready.length === 0 && <Empty>Videos you make with your models show up here.</Empty>}
          <div className="mp-grid">
            {ready.slice(0, 12).map((v) => {
              const url = v.resultVideoUrl!;
              const on = picked === url;
              const inner = (
                <>
                  <video src={url} poster={v.sourceImageUrl} preload="none" muted playsInline />
                  <span className="mp-play" aria-hidden="true">
                    <span>
                      <Icon.play />
                    </span>
                  </span>
                  {v.durationSec ? <span className="mp-dur">{duration(v.durationSec)}</span> : null}
                  {on && <span className="mp-check">✓</span>}
                </>
              );
              return canAdd ? (
                <button key={v.id} type="button" className={`mp-tile tall${on ? ' sel' : ''}`} aria-pressed={on} aria-label={on ? 'Unselect video' : 'Select video'} onClick={() => setPicked(on ? undefined : url)}>
                  {inner}
                </button>
              ) : (
                <a key={v.id} href={url} target="_blank" rel="noreferrer" className="mp-tile tall" aria-label="Open video">
                  {inner}
                </a>
              );
            })}
          </div>
        </Section>
      </div>
      {canAdd && (
        <div className="mp-foot">
          <span>{picked ? <strong>1 selected</strong> : 'Tap a video to pick it'}</span>
          <button
            type="button"
            className="btn sm primary"
            disabled={!picked}
            onClick={() => {
              mediaTarget!.addVideo!(picked!);
              setPicked(undefined);
            }}
          >
            {mediaTarget!.label}
          </button>
        </div>
      )}
    </>
  );
}
