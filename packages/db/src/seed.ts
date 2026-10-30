import { createDb, plans, type PlanLimits } from './index.ts';

// Demo plans from the spec. Every number is editable later in the super admin panel.
const demoPlans: { key: string; name: string; priceBdt: string; priceUsd: string; trialDays?: number; limits: PlanLimits }[] = [
  { key: 'trial', name: 'Free trial', priceBdt: '0', priceUsd: '0', trialDays: 14, limits: { pages: 1, agents: 1, aiCreditsPerMonth: 300, knowledgeBaseMb: 20, staffSeats: 1 } },
  { key: 'starter', name: 'Starter', priceBdt: '990', priceUsd: '9', limits: { pages: 1, agents: 1, aiCreditsPerMonth: 2000, knowledgeBaseMb: 100, staffSeats: 2 } },
  { key: 'growth', name: 'Growth', priceBdt: '2490', priceUsd: '25', limits: { pages: 3, agents: 3, aiCreditsPerMonth: 8000, knowledgeBaseMb: 500, staffSeats: 5 } },
  { key: 'pro', name: 'Pro', priceBdt: '5990', priceUsd: '59', limits: { pages: 10, agents: 10, aiCreditsPerMonth: 25000, knowledgeBaseMb: 2048, staffSeats: 15 } },
];

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

const { db, close } = createDb(url, { max: 1 });
for (const plan of demoPlans) {
  await db
    .insert(plans)
    .values(plan)
    .onConflictDoNothing({ target: plans.key });
}
await close();
console.log(`Seeded ${demoPlans.length} plans`);
