// Keeps the Next.js server function warm so the first visitor after a quiet spell doesn't pay a cold start.
// Runs every 5 minutes (Netlify scheduled function). Cheap: two tiny requests.
export default async () => {
  const base = process.env.URL;
  if (!base) return;
  await Promise.allSettled(['/', '/cart'].map(p => fetch(`${base}${p}`, { headers: { 'x-warm': '1' } })));
};
export const config = { schedule: '*/5 * * * *' };
