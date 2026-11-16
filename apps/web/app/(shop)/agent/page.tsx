'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { useShop } from '@/components/Shell';
import { Dialog, Loading, Notice, Pill, Toggle, TopBar } from '@/components/ui';
import { useApi, useLoad } from '@/lib/api';
import type { Agent, AgentList } from '@/lib/types';

const TONES: { value: Agent['tone']; label: string; note: string }[] = [
  { value: 'friendly', label: 'Friendly', note: 'Warm and helpful, like a good shop assistant' },
  { value: 'professional', label: 'Professional', note: 'Polite and to the point' },
  { value: 'casual', label: 'Casual', note: 'Relaxed, like chatting with a friend' },
  { value: 'formal', label: 'Formal', note: 'Respectful, uses "apni"' },
];

const COMMENT_MODES: { value: Agent['commentReplyMode']; label: string; note: string }[] = [
  { value: 'public_and_private', label: 'Private message, with a short public note', note: 'Answers in Messenger and replies "sent you a message" under the comment. Best for prices.' },
  { value: 'public', label: 'Public reply only', note: 'Answers under the comment, where everyone can see it.' },
  { value: 'private', label: 'Private message only', note: 'Answers in Messenger and leaves the comment alone.' },
  { value: 'off', label: 'Don’t reply to comments', note: 'Comments wait for your team on the Comments page.' },
];

const CHANNEL_LABEL: Record<Agent['channelType'], string> = { facebook_page: 'Facebook', whatsapp: 'WhatsApp', instagram: 'Instagram' };
const CHANNEL_THING: Record<Agent['channelType'], string> = { facebook_page: 'Facebook page', whatsapp: 'WhatsApp number', instagram: 'Instagram account' };

/**
 * Chat Agent: one bot per channel type (the main one on Facebook, and
 * optionally one each for WhatsApp and Instagram). For each: its name, voice,
 * languages, when it hands over, and (Facebook) how it answers comments.
 */
export default function AgentPage() {
  const { ws, manager, reloadHome } = useShop();
  const api = useApi();
  const list = useLoad<AgentList>(manager ? `${ws}/agents` : null);
  const [selected, setSelected] = useState<string>();
  const [a, setA] = useState<Agent>();
  const [keywords, setKeywords] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [adding, setAdding] = useState(false);

  const agents = list.data?.agents;
  const current = agents?.find((x) => x.id === selected) ?? agents?.[0];

  useEffect(() => {
    if (current) {
      setA(current);
      setKeywords(current.handoffRules.keywords.join(', '));
    }
  }, [current]);

  if (!manager) {
    return (
      <>
        <TopBar title="Chat Agent" />
        <div className="content">
          <Notice tone="info">Only the shop owner or an admin can change the bot.</Notice>
        </div>
      </>
    );
  }
  if (!a || !current || !agents) {
    return (
      <>
        <TopBar title="Chat Agent" />
        <div className="content">{list.error ? <Notice tone="error">{list.error}</Notice> : <Loading />}</div>
      </>
    );
  }

  const path = `${ws}/agents/${a.id}`;
  const reload = list.reload;
  const missing = (['whatsapp', 'instagram'] as const).filter((t) => !agents.some((x) => x.channelType === t));
  const unanswered = list.data!.unanswered.filter((t): t is 'whatsapp' | 'instagram' => t === 'whatsapp' || t === 'instagram');
  const atLimit = agents.length >= list.data!.limit;

  async function setStatus(live: boolean) {
    setProblem(undefined);
    setSaved(undefined);
    try {
      await api(path, { method: 'PATCH', body: { status: live ? 'live' : 'paused' } });
      reload();
      reloadHome();
      setSaved(live ? `${a!.name} is now replying to customers.` : `${a!.name} is paused. Messages wait in your inbox.`);
    } catch (e) {
      setProblem((e as Error).message);
    }
  }

  async function remove() {
    if (!window.confirm(`Remove ${a!.name}? ${CHANNEL_LABEL[a!.channelType]} messages will wait in your inbox for your team.`)) return;
    setProblem(undefined);
    try {
      await api(path, { method: 'DELETE' });
      setSelected(undefined);
      setSaved(`${a!.name} removed.`);
      reload();
    } catch (e) {
      setProblem((e as Error).message);
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setProblem(undefined);
    setSaved(undefined);
    try {
      const body = {
        name: a!.name,
        tone: a!.tone,
        systemInstruction: a!.systemInstruction,
        languages: a!.languages,
        handoffEnabled: a!.handoffEnabled,
        handoffRules: { ...rules, keywords: keywords.split(',').map((k) => k.trim()).filter(Boolean) },
        ...(a!.channelType === 'facebook_page' ? { commentReplyMode: a!.commentReplyMode } : {}),
      };
      await api(path, { method: 'PATCH', body });
      reload();
      reloadHome();
      setSaved('Saved. The bot uses these settings from its next reply.');
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const set = <K extends keyof Agent>(k: K, v: Agent[K]) => setA({ ...a, [k]: v });
  const rules = a.handoffRules;
  const setRule = <K extends keyof Agent['handoffRules']>(k: K, v: Agent['handoffRules'][K]) => setA({ ...a, handoffRules: { ...rules, [k]: v } });

  const toggleLang = (l: 'bn' | 'en', on: boolean) => set('languages', on ? [...new Set([...a.languages, l])] : a.languages.filter((x) => x !== l));

  return (
    <>
      <TopBar title="Chat Agent">
        <Toggle checked={a.status === 'live'} onChange={setStatus} label={a.status === 'live' ? 'Replying to customers' : a.status === 'paused' ? 'Paused' : 'Not switched on yet'} />
      </TopBar>
      <form className="content narrow" onSubmit={save}>
        <nav className="tabs" aria-label="Chat agents">
          {agents.map((x) => (
            <button
              key={x.id}
              type="button"
              className={`tab${x.id === a.id ? ' on' : ''}`}
              aria-current={x.id === a.id ? 'page' : undefined}
              onClick={() => {
                setSelected(x.id);
                setSaved(undefined);
                setProblem(undefined);
              }}
            >
              {CHANNEL_LABEL[x.channelType]} agent
              {x.status === 'live' && (
                <span aria-label="on" title="Replying to customers" style={{ width: 8, height: 8, borderRadius: 4, background: 'var(--green)', marginLeft: 8, display: 'inline-block' }} />
              )}
            </button>
          ))}
          {missing.length > 0 && (
            <button type="button" className="tab" onClick={() => setAdding(true)}>
              + Add agent
            </button>
          )}
        </nav>
        {saved && <Notice tone="ok">{saved}</Notice>}
        {problem && <Notice tone="error">{problem}</Notice>}
        {unanswered.length > 0 && (
          <Notice tone="warn">
            {unanswered.map((t) => CHANNEL_LABEL[t]).join(' and ')} messages are waiting for your team because no agent answers there.{' '}
            <button type="button" className="btn link" style={{ padding: 0, height: 'auto', color: 'inherit', fontWeight: 700 }} onClick={() => setAdding(true)}>
              Add an agent
            </button>
          </Notice>
        )}

        <section className="card pad">
          <h2>Where this bot answers</h2>
          {current.channels.length > 0 ? (
            current.channels.map((c) => (
              <div key={c.id} className="page-row">
                <div>
                  <strong>{c.name}</strong>
                  <span className="sub">{CHANNEL_THING[c.type as Agent['channelType']] ?? c.type}</span>
                </div>
                <Pill tone={c.status === 'connected' ? 'green' : 'amber'}>{c.status === 'connected' ? 'Connected' : 'Needs reconnecting'}</Pill>
              </div>
            ))
          ) : (
            <p className="sub" style={{ margin: 0 }}>
              No {CHANNEL_THING[a.channelType]} connected yet. <Link href="/settings?tab=pages">Connect one in Settings</Link>, then switch this bot on.
            </p>
          )}
        </section>

        <section className="card pad">
          <h2>Who the bot is</h2>
          <div className="row">
            <label className="field">
              Bot name
              <input value={a.name} onChange={(e) => set('name', e.target.value)} maxLength={80} required />
              <small>Customers see this name, e.g. “Mina from Dhaka Style”.</small>
            </label>
            <label className="field">
              Tone
              <select value={a.tone} onChange={(e) => set('tone', e.target.value as Agent['tone'])}>
                {TONES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}: {t.note}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend style={{ marginBottom: 6 }}>Languages</legend>
            <div className="row">
              <label className="check">
                <input type="checkbox" checked={a.languages.includes('bn')} onChange={(e) => toggleLang('bn', e.target.checked)} /> Bangla (and Banglish)
              </label>
              <label className="check">
                <input type="checkbox" checked={a.languages.includes('en')} onChange={(e) => toggleLang('en', e.target.checked)} /> English
              </label>
            </div>
            <small>The bot replies in the language the customer writes in.</small>
          </fieldset>
          <label className="field">
            Instructions for the bot
            <textarea
              rows={6}
              value={a.systemInstruction}
              onChange={(e) => set('systemInstruction', e.target.value)}
              maxLength={4000}
              placeholder="e.g. Always greet with Assalamu Alaikum. Never offer discounts. Delivery takes 2 to 3 days in Dhaka and 3 to 5 days outside."
            />
            <small>
              House rules in plain words. For facts customers ask about (sizes, delivery, exchanges), use the <Link href="/knowledge">knowledge base</Link>.
            </small>
          </label>
        </section>

        <section className="card pad">
          <h2>When to hand a chat to your team</h2>
          <label className="check">
            <input type="checkbox" checked={a.handoffEnabled} onChange={(e) => set('handoffEnabled', e.target.checked)} /> Hand over to a person when needed
          </label>
          {a.handoffEnabled && (
            <>
              <label className="check">
                <input type="checkbox" checked={rules.onHumanRequest} onChange={(e) => setRule('onHumanRequest', e.target.checked)} /> When the customer asks for a person
              </label>
              <label className="check">
                <input type="checkbox" checked={rules.onComplaint} onChange={(e) => setRule('onComplaint', e.target.checked)} /> When the customer complains
              </label>
              <label className="field">
                When the bot isn&apos;t sure (below {Math.round(rules.minConfidence * 100)}% sure)
                <input type="range" min={0} max={0.9} step={0.05} value={rules.minConfidence} onChange={(e) => setRule('minConfidence', Number(e.target.value))} />
                <small>Higher hands over more often. Lower lets the bot try more answers itself.</small>
              </label>
              <label className="field">
                Words that always hand over
                <input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="refund, wholesale, manager" />
                <small>Separate with commas.</small>
              </label>
            </>
          )}
          <p className="sub" style={{ margin: 0 }}>
            A handed-over chat shows as “Needs you” in the inbox, and the bot stays quiet until you hand it back.
          </p>
        </section>

        {a.channelType === 'facebook_page' && (
          <section className="card pad">
            <h2>Comments on your posts</h2>
            {COMMENT_MODES.map((m) => (
              <label key={m.value} className="check" style={{ alignItems: 'flex-start' }}>
                <input type="radio" name="comments" checked={a.commentReplyMode === m.value} onChange={() => set('commentReplyMode', m.value)} style={{ marginTop: 3 }} />
                <span>
                  <strong>{m.label}</strong>
                  <br />
                  <span className="sub">{m.note}</span>
                </span>
              </label>
            ))}
          </section>
        )}

        <div className="save-bar">
          {a.channelType !== 'facebook_page' && (
            <button type="button" className="btn link" style={{ marginRight: 'auto', color: 'var(--red)' }} onClick={remove}>
              Remove this agent
            </button>
          )}
          <button type="submit" className="btn primary" disabled={busy || a.languages.length === 0}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
      {adding && (
        <AddAgentDialog
          choices={missing}
          atLimit={atLimit}
          limit={list.data!.limit}
          onClose={() => setAdding(false)}
          onAdd={async (channelType) => {
            const r = await api<{ agent: Agent }>(`${ws}/agents`, { method: 'POST', body: { channelType } });
            setAdding(false);
            setSelected(r.agent.id);
            setSaved(`${r.agent.name} added. It starts with your Facebook agent's settings; change anything below, then switch it on.`);
            reload();
          }}
        />
      )}
    </>
  );
}

function AddAgentDialog({
  choices,
  atLimit,
  limit,
  onClose,
  onAdd,
}: {
  choices: ('whatsapp' | 'instagram')[];
  atLimit: boolean;
  limit: number;
  onClose: () => void;
  onAdd: (t: 'whatsapp' | 'instagram') => Promise<void>;
}) {
  const [type, setType] = useState(choices[0]!);
  return (
    <Dialog title="Add a chat agent" submitLabel="Add agent" onClose={onClose} onSubmit={() => onAdd(type)}>
      {atLimit && (
        <Notice tone="warn">
          Your plan allows {limit} {limit === 1 ? 'agent' : 'agents'}. <Link href="/settings?tab=subscription">Upgrade</Link> to add another.
        </Notice>
      )}
      {choices.map((t) => (
        <label key={t} className="check" style={{ alignItems: 'flex-start' }}>
          <input type="radio" name="agent-channel" checked={type === t} onChange={() => setType(t)} style={{ marginTop: 3 }} />
          <span>
            <strong>{CHANNEL_LABEL[t]} agent</strong>
            <br />
            <span className="sub">Answers messages on your {CHANNEL_THING[t]}, with its own name, tone and instructions.</span>
          </span>
        </label>
      ))}
    </Dialog>
  );
}
