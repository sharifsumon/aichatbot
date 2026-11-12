'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AddToProduct } from '@/components/AddToProduct';
import { useShop } from '@/components/Shell';
import { Chips, Empty, Loading, Notice, Pill, TopBar } from '@/components/ui';
import { ApiError, useApi, useLoad, useUpload } from '@/lib/api';
import { shrinkImage } from '@/lib/image';

type Mode = 'talk' | 'walk';
interface Setup {
  enabled: boolean;
  creditsPerSecond: number;
  voices: { id: string; label: string }[];
  languages: string[];
}
interface Video {
  id: string;
  sourceImageUrl: string;
  mode: Mode;
  script: string | null;
  status: 'pending' | 'succeeded' | 'failed';
  resultVideoUrl: string | null;
  durationSec: number | null;
  credits: number;
  error: string | null;
  options: { progress?: { clip: number; of: number } } | null;
  createdAt: string;
}
interface Photo {
  url: string;
  label: string;
}

const MOVES: { value: string; label: string; modes: Mode[] }[] = [
  { value: '', label: 'Natural', modes: ['talk', 'walk'] },
  { value: 'walk', label: 'Walk towards the camera (runway)', modes: ['walk'] },
  { value: 'walk-turn', label: 'Walk, stop and turn around', modes: ['walk'] },
  { value: 'pose', label: 'A few fashion poses', modes: ['walk'] },
  { value: 'turn', label: 'Turn left and right to show the outfit', modes: ['talk', 'walk'] },
  { value: 'presenting', label: 'Present the outfit with hand gestures', modes: ['talk', 'walk'] },
  { value: 'calm', label: 'Calm, small movements', modes: ['talk', 'walk'] },
  { value: 'excited', label: 'Excited, lively gestures', modes: ['talk', 'walk'] },
];
const CAMERAS: { value: string; label: string; modes: Mode[] }[] = [
  { value: '', label: 'Let the AI decide', modes: ['talk', 'walk'] },
  { value: 'follow', label: 'Follow the model', modes: ['walk'] },
  { value: 'orbit', label: 'Circle around the model', modes: ['walk'] },
  { value: 'static', label: 'Still', modes: ['talk', 'walk'] },
  { value: 'zoom-in', label: 'Slow zoom in', modes: ['talk', 'walk'] },
  { value: 'zoom-out', label: 'Slow zoom out to the full outfit', modes: ['talk', 'walk'] },
  { value: 'pan', label: 'Slow pan side to side', modes: ['talk', 'walk'] },
];
const LANGUAGE_LABEL: Record<string, string> = { auto: 'Detect from the script', Bengali: 'Bangla (বাংলা)' };
const CHARS_PER_SECOND = 14;
const WALK_SECONDS = [5, 10, 15, 20, 30, 45, 60];
/** About 60 seconds of speech. */
const MAX_TALK_SCRIPT = 900;

/**
 * Videos with models: a model photo becomes a short product video, talking
 * from the shop's script or own voice, or walking and talking.
 */
export default function ModelVideosPage() {
  const { ws, manager, reloadHome } = useShop();
  const api = useApi();
  const upload = useUpload();
  const setup = useLoad<Setup>(`${ws}/videos/setup`);
  const tryOn = useLoad<{ images: { id: string; status: string; resultImageUrl: string | null }[] }>(`${ws}/try-on`);
  const characters = useLoad<{ models: { id: string; name: string; imageUrl: string }[] }>(`${ws}/try-on/models`);
  const [videos, setVideos] = useState<Video[]>();
  const [photo, setPhoto] = useState<string>();
  const [uploaded, setUploaded] = useState<Photo[]>([]);
  const [mode, setMode] = useState<Mode>('walk');
  const [move, setMove] = useState('walk');
  const [camera, setCamera] = useState('follow');
  const [note, setNote] = useState('');
  const [speaks, setSpeaks] = useState(true);
  const [voiceSource, setVoiceSource] = useState<'script' | 'recording'>('script');
  const [script, setScript] = useState('');
  const [language, setLanguage] = useState('auto');
  const [voice, setVoice] = useState('Wise_Woman');
  const [recording, setRecording] = useState<{ url: string; name: string }>();
  const [seconds, setSeconds] = useState(10);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const [adding, setAdding] = useState<string>();
  const photoInput = useRef<HTMLInputElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);

  const loadVideos = useCallback(async () => {
    try {
      setVideos((await api<{ videos: Video[] }>(`${ws}/videos`)).videos);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, ws]);
  useEffect(() => {
    loadVideos();
  }, [loadVideos]);
  const pending = videos?.some((v) => v.status === 'pending');
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(loadVideos, 5000);
    return () => clearInterval(t);
  }, [pending, loadVideos]);

  // Options that don't fit the mode fall back to the default.
  useEffect(() => {
    if (!MOVES.find((m) => m.value === move)?.modes.includes(mode)) setMove('');
    if (!CAMERAS.find((c) => c.value === camera)?.modes.includes(mode)) setCamera('');
    if (mode === 'walk') setVoiceSource('script');
    // A silent video can only be a movement video.
    if (!speaks && mode === 'talk') setMode('walk');
  }, [mode, move, camera, speaks]);

  const photos: Photo[] = [
    ...uploaded,
    ...(tryOn.data?.images ?? []).filter((i) => i.status === 'succeeded' && i.resultImageUrl).map((i) => ({ url: i.resultImageUrl!, label: 'Your image' })),
    ...(characters.data?.models ?? []).map((m) => ({ url: m.imageUrl, label: m.name })),
  ];

  async function pickPhoto(f: File | undefined) {
    if (!f) return;
    setBusy('photo');
    setError(undefined);
    try {
      const r = await upload<{ url: string }>(`${ws}/uploads/images`, await shrinkImage(f), 60_000);
      setUploaded((u) => [{ url: r.url, label: 'Uploaded' }, ...u]);
      setPhoto(r.url);
    } catch (e) {
      setError((e as ApiError).status === 503 ? 'Photo uploads are not switched on yet.' : (e as Error).message);
    } finally {
      setBusy(undefined);
      if (photoInput.current) photoInput.current.value = '';
    }
  }

  async function pickRecording(f: File | undefined) {
    if (!f) return;
    setBusy('audio');
    setError(undefined);
    try {
      if (f.size > 10 * 1024 * 1024) throw new Error('The recording is larger than 10 MB. Use a shorter one.');
      const r = await upload<{ url: string }>(`${ws}/uploads/audio`, f, 120_000);
      setRecording({ url: r.url, name: f.name });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
      if (audioInput.current) audioInput.current.value = '';
    }
  }

  const perSecond = setup.data?.creditsPerSecond ?? 0;
  const estimateSec = mode === 'walk' ? seconds : voiceSource === 'recording' ? null : Math.max(3, Math.ceil(script.trim().length / CHARS_PER_SECOND));
  const ready = !!photo && (!speaks || (voiceSource === 'recording' ? !!recording : !!script.trim()));

  async function generate() {
    if (!photo) return;
    setBusy('start');
    setError(undefined);
    setDone(undefined);
    try {
      const r = await api<{ video: Video }>(`${ws}/videos`, {
        method: 'POST',
        body: {
          sourceImageUrl: photo,
          mode,
          ...(!speaks ? { speak: false } : voiceSource === 'recording' && mode === 'talk' ? { audioUrl: recording?.url } : { script: script.trim(), voice, language }),
          ...(move && { gesture: move }),
          ...(camera && { camera }),
          ...(note.trim() && { note: note.trim() }),
          ...(mode === 'walk' && { seconds }),
        },
      });
      setVideos((cur) => [r.video, ...(cur ?? [])]);
      setDone(mode === 'walk' && seconds > 10 ? `Your video is being made in ${Math.ceil(seconds / 10)} clips. It can take ${Math.ceil(seconds / 10) * 3} to ${Math.ceil(seconds / 10) * 6} minutes; you can leave this page.` : 'Your video is being made. It usually takes 2 to 6 minutes; you can leave this page.');
      reloadHome();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  async function remove(v: Video) {
    if (!window.confirm('Remove this video from the list? If you added it to a product, it stays there.')) return;
    try {
      await api(`${ws}/videos/${v.id}`, { method: 'DELETE' });
      setVideos((cur) => cur?.filter((x) => x.id !== v.id));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!manager) {
    return (
      <>
        <TopBar title="Videos with models" back={{ href: "/media?tab=videos", label: "Media library" }} />
        <div className="content">
          <Notice tone="info">Only the shop owner and admins can make videos with models.</Notice>
        </div>
      </>
    );
  }

  return (
    <>
      <TopBar title="Videos with models" back={{ href: "/media?tab=videos", label: "Media library" }} />
      <div className="content">
        <p className="sub" style={{ margin: 0, fontSize: 14 }}>
          Turn a model photo into a short product video. The model can walk and talk with the camera following, or talk to the camera from your script or your own voice.
        </p>
        {setup.data && !setup.data.enabled && <Notice tone="warn">Videos with models are not switched on for Agently yet.</Notice>}
        {done && <Notice tone="ok">{done}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}

        <div className="tryon">
          <section className="card pad" aria-label="Choose a photo">
            <h2>1. Choose a photo</h2>
            <button type="button" className="btn" onClick={() => photoInput.current?.click()} disabled={busy === 'photo'}>
              {busy === 'photo' ? 'Uploading…' : '+ Upload a photo'}
            </button>
            <input ref={photoInput} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => pickPhoto(e.target.files?.[0])} />
            {(tryOn.loading || characters.loading) && photos.length === 0 && <Loading />}
            {!tryOn.loading && photos.length === 0 && <Empty>Make an image with a model first, or upload a photo.</Empty>}
            <div className="pick">
              {photos.map((p) => (
                <button key={p.url} type="button" className={photo === p.url ? 'on' : ''} aria-pressed={photo === p.url} onClick={() => setPhoto(p.url)}>
                  <img src={p.url} alt="" loading="lazy" />
                  <span>{p.label}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="card pad" aria-label="Describe the video">
            <h2>2. Describe the video</h2>
            <Chips
              label="Kind of video"
              value={mode}
              onChange={setMode}
              options={
                speaks
                  ? [
                      { value: 'walk', label: 'Walk and talk' },
                      { value: 'talk', label: 'Talking' },
                    ]
                  : [{ value: 'walk', label: 'Walk and move' }]
              }
            />
            <small className="muted">
              {!speaks
                ? 'The model moves and the camera follows, with no speech. Up to 60 seconds.'
                : mode === 'walk'
                ? 'The model moves and the camera follows. Up to 60 seconds. Speech is in English; for Bangla choose Talking.'
                : 'The model talks to the camera with accurate lip-sync; little walking. Up to about 60 seconds. Speaks Bangla, English and more.'}
            </small>
            <fieldset className="style">
              <legend>Movement and camera</legend>
              <label className="field">
                Pose and movement
                <select value={move} onChange={(e) => setMove(e.target.value)}>
                  {MOVES.filter((m) => m.modes.includes(mode)).map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Camera
                <select value={camera} onChange={(e) => setCamera(e.target.value)}>
                  {CAMERAS.filter((c) => c.modes.includes(mode)).map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
              {mode === 'walk' && (
                <label className="field">
                  Length
                  <select value={seconds} onChange={(e) => setSeconds(Number(e.target.value))}>
                    {WALK_SECONDS.map((n) => (
                      <option key={n} value={n}>
                        {n} seconds{n > 10 ? ` (${Math.ceil(n / 10)} clips joined)` : ''}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="field">
                Your own directions
                <textarea
                  rows={2}
                  maxLength={500}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="e.g. she walks down a sunny street, stops, smiles and points at her dress"
                />
              </label>
            </fieldset>

            <fieldset className="style">
              <legend>What the model says</legend>
              <label className="check">
                <input type="checkbox" checked={speaks} onChange={(e) => setSpeaks(e.target.checked)} /> The model speaks
              </label>
              {!speaks && <small className="muted">A silent video: the model only moves. Tick the box to add a script and voice.</small>}
              {speaks && mode === 'talk' && (
                <Chips
                  label="Voice"
                  value={voiceSource}
                  onChange={setVoiceSource}
                  options={[
                    { value: 'script', label: 'Type a script' },
                    { value: 'recording', label: 'Upload my voice' },
                  ]}
                />
              )}
              {!speaks ? null : voiceSource === 'script' ? (
                <>
                  <label className="field">
                    Script
                    <textarea
                      rows={4}
                      maxLength={mode === 'walk' ? Math.max(200, seconds * 18) : MAX_TALK_SCRIPT}
                      value={script}
                      onChange={(e) => setScript(e.target.value)}
                      placeholder={mode === 'walk' ? 'One or two short lines, e.g. “Our new Eid collection is here. Order today!”' : 'e.g. “Assalamu alaikum! This is our new cotton kurti, perfect for summer…”'}
                    />
                  </label>
                  {mode === 'talk' && (
                    <>
                      <label className="field">
                        Language
                        <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                          {(setup.data?.languages ?? ['auto']).map((l) => (
                            <option key={l} value={l}>
                              {LANGUAGE_LABEL[l] ?? l}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="field">
                        Voice
                        <select value={voice} onChange={(e) => setVoice(e.target.value)}>
                          {(setup.data?.voices ?? []).map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    </>
                  )}
                  <small className="muted">
                    {mode === 'walk'
                      ? `About 2 to 3 words a second fit, so ${seconds} seconds is roughly ${Math.round(seconds * 2.5)} words.${seconds > 10 ? ' Longer videos are made in 10-second clips joined together; the script is shared between them.' : ''}`
                      : `Up to about 60 seconds (${script.length}/${MAX_TALK_SCRIPT} characters). For Bangla, write the script in Bangla letters (বাংলা).`}
                  </small>
                </>
              ) : (
                <>
                  <button type="button" className="btn" onClick={() => audioInput.current?.click()} disabled={busy === 'audio'}>
                    {busy === 'audio' ? 'Uploading…' : recording ? `✓ ${recording.name} (change)` : '+ Upload a voice recording'}
                  </button>
                  <input ref={audioInput} type="file" accept="audio/*" hidden onChange={(e) => pickRecording(e.target.files?.[0])} />
                  {recording && <audio controls src={recording.url} style={{ width: '100%' }} />}
                  <small className="muted">MP3, WAV, M4A or OGG, up to 10 MB and about 60 seconds. Record on your phone in any language, including Bangla.</small>
                </>
              )}
            </fieldset>

            <button type="button" className="btn primary" disabled={!ready || !!busy || !setup.data?.enabled} onClick={generate}>
              {busy === 'start'
                ? 'Starting…'
                : `Generate video${perSecond ? (estimateSec ? ` · about ${estimateSec * perSecond} credits` : ` · ${perSecond} credits a second`) : ''}`}
            </button>
            {!ready && <small className="muted">{!photo ? 'Choose a photo first.' : voiceSource === 'recording' ? 'Upload a voice recording.' : 'Write what the model says.'}</small>}
          </section>
        </div>

        <section aria-label="Your videos" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h2 style={{ fontSize: 16 }}>Your videos</h2>
          {!videos && <Loading />}
          {videos?.length === 0 && <Empty>Videos you make show up here. Each one takes a few minutes.</Empty>}
          <div className="results">
            {videos?.map((v) => (
              <div key={v.id} className="result">
                <div className="ph">
                  {v.status === 'succeeded' && v.resultVideoUrl ? (
                    <video src={v.resultVideoUrl} controls playsInline preload="metadata" poster={v.sourceImageUrl} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : v.status === 'pending' ? (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                      <div className="spinner" aria-hidden="true" />
                      {v.options?.progress ? `Making clip ${v.options.progress.clip} of ${v.options.progress.of}…` : 'Making your video…'}
                    </div>
                  ) : (
                    <div style={{ padding: 16 }}>{v.error ?? 'This video could not be made.'}</div>
                  )}
                </div>
                <div className="info">
                  <Pill>{v.mode === 'walk' ? 'Walk and talk' : 'Talking'}</Pill>
                  {v.status === 'succeeded' && v.resultVideoUrl && (
                    <>
                      <button type="button" className="btn sm primary" onClick={() => setAdding(v.resultVideoUrl!)}>
                        Add to a product
                      </button>
                      <a className="btn sm" href={v.resultVideoUrl} download target="_blank" rel="noreferrer">
                        Download
                      </a>
                    </>
                  )}
                  {v.status === 'failed' && <Pill tone="red">Failed</Pill>}
                  {v.status !== 'pending' && (
                    <button type="button" className="btn sm link" style={{ marginLeft: 'auto' }} onClick={() => remove(v)}>
                      Remove
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
      {adding && (
        <AddToProduct
          url={adding}
          kind="video"
          onClose={() => setAdding(undefined)}
          onDone={(p) => {
            setAdding(undefined);
            setDone(`Added to ${p.title} as its product video.`);
          }}
        />
      )}
    </>
  );
}
