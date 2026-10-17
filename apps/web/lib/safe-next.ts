/** Only allow same-site relative paths as post-login destinations (blocks open redirects like ?next=https://evil). */
export function safeNext(next: string | undefined | null, fallback = '/'): string {
  if (!next) return fallback;
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\') || /[\r\n]/.test(next)) return fallback;
  return next;
}
