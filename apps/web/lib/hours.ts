// Opening hours: {"mon":[["09:00","13:00"],["16:00","20:00"]], ...}. Ranges past midnight ("11:00"–"02:00") roll over.
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function isOpenNow(hours: Record<string, [string, string][]> | null | undefined, override: boolean | null | undefined, tz = 'Asia/Beirut', now = new Date()): boolean {
  if (override === true || override === false) return override;
  if (!hours || !Object.keys(hours).length) return true;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
  const wd = parts.find(p => p.type === 'weekday')!.value.toLowerCase().slice(0, 3);
  const h = Number(parts.find(p => p.type === 'hour')!.value) % 24, m = Number(parts.find(p => p.type === 'minute')!.value);
  const cur = h * 60 + m;
  const toMin = (s: string) => { const [a, b] = s.split(':').map(Number); return a * 60 + b; };
  const inRanges = (ranges: [string, string][] | undefined, t: number) => (ranges ?? []).some(([a, b]) => { const x = toMin(a), y = toMin(b); return y > x ? t >= x && t < y : t >= x || t < y; });
  if (inRanges(hours[wd], cur)) return true;
  // still inside yesterday's past-midnight range?
  const yd = DAYS[(DAYS.indexOf(wd) + 6) % 7];
  return (hours[yd] ?? []).some(([a, b]) => toMin(b) < toMin(a) && cur < toMin(b));
}
