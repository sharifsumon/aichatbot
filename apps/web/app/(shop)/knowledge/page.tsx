'use client';

import { useEffect, useRef, useState } from 'react';
import { useShop } from '@/components/Shell';
import { Dialog, Empty, Loading, Meter, Notice, Pill, TopBar } from '@/components/ui';
import { ApiError, useApi, useLoad, useUpload } from '@/lib/api';
import { ago } from '@/lib/format';
import type { KnowledgeSource } from '@/lib/types';

type Kind = 'text' | 'qa' | 'website' | 'sheet';

const TYPE: Record<KnowledgeSource['type'], string> = { file: 'File', text: 'Text', qa: 'Q&A', website: 'Website', sheet: 'Google Sheet' };
const STATUS: Record<KnowledgeSource['status'], { label: string; tone?: 'green' | 'red' | 'amber' }> = {
  queued: { label: 'Waiting to be read', tone: 'amber' },
  processing: { label: 'Reading…', tone: 'amber' },
  ready: { label: 'Ready', tone: 'green' },
  failed: { label: 'Could not read', tone: 'red' },
};

const mb = (b: number) => `${(b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 1 : 0)} MB`;

/** Knowledge base: what the bot reads to answer questions about the shop. */
export default function KnowledgePage() {
  const { ws, manager, reloadHome } = useShop();
  const api = useApi();
  const upload = useUpload();
  const file = useRef<HTMLInputElement>(null);
  const { data, error, loading, reload } = useLoad<{ sources: KnowledgeSource[]; usage: { usedBytes: number; limitBytes: number } }>(`${ws}/knowledge`);
  const [adding, setAdding] = useState<Kind>();
  const [done, setDone] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);

  // Sources are read in the background; check back until they are done.
  const pending = data?.sources.some((s) => s.status === 'queued' || s.status === 'processing');
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(reload, 4_000);
    return () => clearInterval(t);
  }, [pending, reload]);

  async function pickFile(f: File | undefined) {
    if (!f) return;
    setBusy(true);
    setProblem(undefined);
    try {
      await upload(`${ws}/knowledge/files`, f);
      setDone(`${f.name} added. The bot can use it once it has been read.`);
      reload();
      reloadHome();
    } catch (e) {
      setProblem((e as ApiError).status === 503 ? 'File uploads are not switched on yet. Paste the text instead, or use a Google Sheet link.' : (e as Error).message);
    } finally {
      setBusy(false);
      if (file.current) file.current.value = '';
    }
  }

  async function act(s: KnowledgeSource, what: 'resync' | 'delete') {
    if (what === 'delete' && !window.confirm(`Remove ${s.name}? The bot stops using it straight away.`)) return;
    setProblem(undefined);
    try {
      await api(`${ws}/knowledge/${s.id}${what === 'resync' ? '/resync' : ''}`, { method: what === 'resync' ? 'POST' : 'DELETE' });
      setDone(what === 'resync' ? `Reading ${s.name} again.` : `${s.name} removed.`);
      reload();
      reloadHome();
    } catch (e) {
      setProblem((e as Error).message);
    }
  }

  return (
    <>
      <TopBar title="Knowledge base">
        {manager && (
          <>
            <button type="button" className="btn" onClick={() => file.current?.click()} disabled={busy}>
              {busy ? 'Uploading…' : 'Upload a file'}
            </button>
            <input ref={file} type="file" hidden accept=".pdf,.xlsx,.csv,.txt,.md" onChange={(e) => pickFile(e.target.files?.[0])} />
            <button type="button" className="btn" onClick={() => setAdding('qa')}>
              + Questions and answers
            </button>
            <button type="button" className="btn primary" onClick={() => setAdding('text')}>
              + Add text
            </button>
          </>
        )}
      </TopBar>
      <div className="content">
        <p className="muted" style={{ margin: 0 }}>
          The bot answers from what you add here: delivery times, exchange and return rules, size charts, shop hours. Products and prices come from the{' '}
          <a href="/catalog">catalog</a>, so you don&apos;t need to add them twice.
        </p>
        {done && <Notice tone="ok">{done}</Notice>}
        {(problem || error) && <Notice tone="error">{problem ?? error}</Notice>}
        {data && (
          <section className="card pad" style={{ maxWidth: 420 }}>
            <Meter used={data.usage.usedBytes} total={data.usage.limitBytes} label={`${mb(data.usage.usedBytes)} of ${mb(data.usage.limitBytes)} used`} />
            {manager && (
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="btn sm" onClick={() => setAdding('website')}>
                  + Website page
                </button>
                <button type="button" className="btn sm" onClick={() => setAdding('sheet')}>
                  + Google Sheet
                </button>
              </div>
            )}
          </section>
        )}
        <div className="table-wrap">
          <table style={{ minWidth: 720 }}>
            <thead>
              <tr>
                <th>Source</th>
                <th>Type</th>
                <th>Status</th>
                <th>Added</th>
                <th>
                  <span className="sr">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data?.sources.map((s) => (
                <tr key={s.id}>
                  <td>
                    <strong>{s.name}</strong>
                    {s.url && (
                      <div className="sub" style={{ overflowWrap: 'anywhere' }}>
                        {s.url}
                      </div>
                    )}
                    {s.error && <div className="sub" style={{ color: 'var(--red)' }}>{s.error}</div>}
                  </td>
                  <td>{TYPE[s.type]}</td>
                  <td>
                    <Pill tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Pill>
                  </td>
                  <td className="muted">{ago(s.createdAt)}</td>
                  <td>
                    {manager && (
                      <div className="actions">
                        {(s.type === 'website' || s.type === 'sheet' || s.status === 'failed') && (
                          <button type="button" className="btn sm" onClick={() => act(s, 'resync')} disabled={s.status === 'processing'}>
                            Read again
                          </button>
                        )}
                        <button type="button" className="btn sm" onClick={() => act(s, 'delete')}>
                          Remove
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {loading && !data && <Loading />}
          {data && data.sources.length === 0 && <Empty>Nothing yet. Start with your delivery and exchange rules: they are what customers ask most.</Empty>}
        </div>
      </div>
      {adding && (
        <AddSource
          kind={adding}
          onClose={() => setAdding(undefined)}
          onDone={(name) => {
            setAdding(undefined);
            setDone(`${name} added. The bot can use it once it has been read.`);
            reload();
            reloadHome();
          }}
        />
      )}
    </>
  );
}

function AddSource({ kind, onClose, onDone }: { kind: Kind; onClose: () => void; onDone: (name: string) => void }) {
  const { ws } = useShop();
  const api = useApi();
  const [name, setName] = useState(kind === 'text' ? 'Delivery and exchange' : kind === 'qa' ? 'Common questions' : '');
  const [content, setContent] = useState('');
  const [url, setUrl] = useState('');
  const [pairs, setPairs] = useState([{ question: '', answer: '' }]);

  const title = { text: 'Add text', qa: 'Add questions and answers', website: 'Add a website page', sheet: 'Add a Google Sheet' }[kind];

  return (
    <Dialog
      title={title}
      submitLabel="Add"
      wide={kind !== 'website' && kind !== 'sheet'}
      onClose={onClose}
      onSubmit={async () => {
        const body =
          kind === 'text'
            ? { type: kind, name, content }
            : kind === 'qa'
              ? { type: kind, name, pairs: pairs.filter((p) => p.question.trim() && p.answer.trim()) }
              : { type: kind, name: name || undefined, url };
        if (kind === 'qa' && !body.pairs?.length) return 'Add at least one question with its answer.';
        await api(`${ws}/knowledge`, { method: 'POST', body });
        onDone(name || url);
      }}
    >
      <label className="field">
        Name {kind === 'website' || kind === 'sheet' ? <small>(optional)</small> : null}
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required={kind === 'text' || kind === 'qa'} />
      </label>
      {kind === 'text' && (
        <label className="field">
          Text
          <textarea
            rows={10}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            required
            placeholder={'Delivery: 2 to 3 days inside Dhaka, 3 to 5 days outside.\nExchange: within 7 days if the tag is on. Customer pays delivery both ways.'}
          />
        </label>
      )}
      {kind === 'qa' && (
        <>
          {pairs.map((p, i) => (
            <div key={i} className="row" style={{ alignItems: 'flex-start' }}>
              <label className="field">
                Question
                <input value={p.question} onChange={(e) => setPairs(pairs.map((x, j) => (j === i ? { ...x, question: e.target.value } : x)))} placeholder="Do you deliver outside Dhaka?" />
              </label>
              <label className="field" style={{ flex: '2 1 200px' }}>
                Answer
                <textarea rows={2} value={p.answer} onChange={(e) => setPairs(pairs.map((x, j) => (j === i ? { ...x, answer: e.target.value } : x)))} placeholder="Yes, all over Bangladesh in 3 to 5 days." />
              </label>
            </div>
          ))}
          <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setPairs([...pairs, { question: '', answer: '' }])}>
            + Another question
          </button>
        </>
      )}
      {(kind === 'website' || kind === 'sheet') && (
        <label className="field">
          Link
          <input value={url} onChange={(e) => setUrl(e.target.value)} required inputMode="url" placeholder={kind === 'sheet' ? 'https://docs.google.com/spreadsheets/d/…' : 'https://yourshop.com/delivery'} />
          {kind === 'sheet' && <small>Share the sheet as “Anyone with the link can view”.</small>}
        </label>
      )}
    </Dialog>
  );
}
