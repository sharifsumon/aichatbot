'use client';

import { useState } from 'react';
import { Chips, DayChart, Empty, Loading, Meter, Notice, Stat, TopBar } from '@/components/ui';
import { useLoad } from '@/lib/api';
import { num, usd } from '@/lib/format';
import type { UsageDay } from '@/lib/types';

interface Usage {
  days: UsageDay[];
  models: (Omit<UsageDay, 'day'> & { model: string })[];
  topTenants: { workspaceId: string; name: string; aiReplies: number; costUsd: string; failedCalls: number }[];
  nearLimit: { workspaceId: string; name: string; used: number; granted: number; percentUsed: number }[];
}

const RANGES = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
];

export default function UsagePage() {
  const [days, setDays] = useState('30');
  const { data, error, loading } = useLoad<Usage>(`/usage?days=${days}`);
  const totals = (data?.days ?? []).reduce(
    (a, d) => ({ replies: a.replies + d.aiReplies, cost: a.cost + Number(d.costUsd), failed: a.failed + d.failedCalls, input: a.input + d.inputTokens, output: a.output + d.outputTokens }),
    { replies: 0, cost: 0, failed: 0, input: 0, output: 0 },
  );

  return (
    <>
      <TopBar title="AI usage">
        <Chips label="Period" options={RANGES} value={days} onChange={setDays} />
      </TopBar>
      <div className="content">
        {error && <Notice tone="error">{error}</Notice>}
        {loading && !data && <Loading />}
        {data && (
          <>
            <div className="stats">
              <Stat label="AI replies" value={num(totals.replies)} />
              <Stat label="AI cost" value={usd(totals.cost)} note={totals.replies ? `${usd(totals.cost / totals.replies, 4)} per reply` : undefined} />
              <Stat label="Tokens in / out" value={`${num(totals.input)} / ${num(totals.output)}`} />
              <Stat label="Failed AI calls" value={num(totals.failed)} note={totals.replies + totals.failed ? `${((totals.failed / (totals.replies + totals.failed)) * 100).toFixed(1)}% of calls` : undefined} tone={totals.failed ? 'warn' : undefined} />
            </div>

            <section className="card pad" aria-label="Per day">
              <h2>AI replies per day</h2>
              <DayChart days={data.days} value={(d) => d.aiReplies} label="AI replies" span={Number(days)} />
              <h2 style={{ marginTop: 8 }}>Cost per day (USD)</h2>
              <DayChart days={data.days} value={(d) => Number(d.costUsd)} label="Cost" span={Number(days)} />
            </section>

            <div className="grid2">
              <section aria-label="Shops near their limit" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <h2 style={{ fontSize: 16 }}>Shops near their credit limit</h2>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Shop</th>
                        <th>Credits used this month</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.nearLimit.map((t) => (
                        <tr key={t.workspaceId}>
                          <td>
                            <a href={`/tenants/${t.workspaceId}`}>{t.name}</a>
                          </td>
                          <td>
                            <Meter used={t.used} total={t.granted} label={`${num(t.used)} / ${num(t.granted)} (${t.percentUsed}%)`} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {data.nearLimit.length === 0 && <Empty>No shop has used 80% of its credits.</Empty>}
                </div>
              </section>

              <section aria-label="By model" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <h2 style={{ fontSize: 16 }}>By model</h2>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Model</th>
                        <th>Replies</th>
                        <th>Cost</th>
                        <th>Failed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.models.map((m) => (
                        <tr key={m.model}>
                          <td>
                            <code>{m.model}</code>
                          </td>
                          <td className="num">{num(m.aiReplies)}</td>
                          <td className="num">{usd(m.costUsd)}</td>
                          <td className="num">{num(m.failedCalls)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {data.models.length === 0 && <Empty>No AI calls in this period.</Empty>}
                </div>
              </section>
            </div>

            <section aria-label="Top shops" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <h2 style={{ fontSize: 16 }}>Top shops by cost</h2>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Shop</th>
                      <th>AI replies</th>
                      <th>Cost</th>
                      <th>Failed calls</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topTenants.map((t) => (
                      <tr key={t.workspaceId}>
                        <td>
                          <a href={`/tenants/${t.workspaceId}`}>{t.name}</a>
                        </td>
                        <td className="num">{num(t.aiReplies)}</td>
                        <td className="num">{usd(t.costUsd)}</td>
                        <td className="num">{num(t.failedCalls)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {data.topTenants.length === 0 && <Empty>No usage in this period.</Empty>}
              </div>
            </section>
          </>
        )}
      </div>
    </>
  );
}
