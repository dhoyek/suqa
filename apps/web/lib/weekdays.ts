// Weekday helpers for items sold on some days only (products.available_days: 0 = Sunday … 6 = Saturday; null = every day).
type Loc = 'ar' | 'en' | string;
const NAMES: Record<string, string[]> = { ar: ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'], en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] };
const ORDER = [1, 2, 3, 4, 5, 6, 0];
export const weekdayName = (d: number, l: Loc) => (NAMES[l] ?? NAMES.en)[d];
/** "السبت، الأحد فقط" */
export const weekdaysLabel = (days: number[], l: Loc) => `${ORDER.filter(d => days.includes(d)).map(d => weekdayName(d, l)).join(l === 'ar' ? '، ' : ', ')} ${l === 'ar' ? 'فقط' : 'only'}`;
/** Days (0–6) on which every weekday-limited line can be ordered; null when no line is limited. */
export function commonDays(lines: { days?: number[] | null }[]): number[] | null {
  const limited = lines.filter(l => l.days?.length);
  if (!limited.length) return null;
  return [0, 1, 2, 3, 4, 5, 6].filter(d => limited.every(l => l.days!.includes(d)));
}
