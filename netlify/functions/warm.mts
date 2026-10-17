// Keeps the Next.js server function warm so the first visitor after a quiet spell doesn't pay a cold start.
// Runs every minute (Netlify scheduled function). Cheap: a few tiny requests (~130k/month, well inside the free tier).
export default async () => {
  const base = process.env.URL;
  if (!base) return;
  await Promise.allSettled(['/', '/cart', '/s/abou-elie'].map(p => fetch(`${base}${p}`, { headers: { 'x-warm': '1' } })));
};
export const config = { schedule: '* * * * *' };
