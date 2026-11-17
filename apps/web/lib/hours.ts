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

/** When a closed shop opens next, as a short label: "8:00 AM", "tomorrow 8:00 AM", "Saturday 8:00 AM" (Arabic alike).
 *  null when it is open, has no timetable, or was paused by hand (nobody knows when it comes back). */
export function reopenLabel(hours: Record<string, [string, string][]> | null | undefined, override: boolean | null | undefined, tz = 'Asia/Beirut', locale: 'ar' | 'en' = 'ar', now = new Date()): string | null {
  if (override === true || override === false) return null;
  if (!hours || !Object.keys(hours).length || isOpenNow(hours, override, tz, now)) return null;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
  const wd = parts.find(p => p.type === 'weekday')!.value.toLowerCase().slice(0, 3);
  const cur = (Number(parts.find(p => p.type === 'hour')!.value) % 24) * 60 + Number(parts.find(p => p.type === 'minute')!.value);
  const toMin = (s: string) => { const [a, b] = s.split(':').map(Number); return a * 60 + b; };
  const today = DAYS.indexOf(wd);
  for (let d = 0; d < 8; d++) {
    const starts = (hours[DAYS[(today + d) % 7]] ?? []).map(r => toMin(r[0])).filter(t => d > 0 || t > cur).sort((a, b) => a - b);
    if (!starts.length) continue;
    const t = starts[0]; const hh = Math.floor(t / 60), mm = t % 60;
    const time = locale === 'ar'
      ? `${hh % 12 || 12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'ص' : 'م'}`
      : `${hh % 12 || 12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
    if (d === 0) return time;
    if (d === 1) return `${locale === 'ar' ? 'غداً' : 'tomorrow'} ${time}`;
    const names = locale === 'ar' ? ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'] : ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return `${names[(today + d) % 7]} ${time}`;
  }
  return null;
}
