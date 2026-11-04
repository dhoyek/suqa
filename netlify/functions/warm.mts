// Keeps the Next.js server function warm so the first visitor after a quiet spell doesn't pay a cold start.
// Every 10 minutes, one request (~4.3k invocations/month). It used to run every minute on 3 pages (~170k/month),
// which burned through the Netlify credit allowance — keep it lean.
export default async () => {
  const base = process.env.URL;
  if (!base) return;
  await fetch(`${base}/`, { headers: { 'x-warm': '1' } }).catch(() => {});
};
export const config = { schedule: '*/10 * * * *' };
