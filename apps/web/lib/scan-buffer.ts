/**
 * Telling a barcode scanner from a person at the keyboard. A scanner in keyboard mode types the whole code in a burst and ends
 * with Enter; a person is far slower. The burst is not perfectly even though: on a slow computer the first key or two can lag
 * (the USB device waking up, the browser busy), and a strict "every gap under 40 ms" rule then drops the start of the code —
 * 762210096759 arrives as 62210096759 and looks like an unknown item. So a few slow gaps are forgiven, but only for a code long
 * enough that no person types it that way: someone at the keyboard makes a slow gap on every key and never gets past four.
 */
export type ScanOpts = { minLength?: number; maxGap?: number; longGap?: number };

export class ScanBuffer {
  private buf = ''; private last = -Infinity; private slow = 0;
  private readonly minLength: number; private readonly maxGap: number; private readonly longGap: number;
  constructor(o: ScanOpts = {}) { this.minLength = o.minLength ?? 4; this.maxGap = o.maxGap ?? 40; this.longGap = o.longGap ?? 300; }

  /** Call before handling a key. Returns true when this key starts a new burst (what was collected before is dropped). */
  private tick(t: number): boolean {
    const gap = t - this.last; this.last = t;
    if (gap > this.longGap) { this.buf = ''; this.slow = 0; return true; }
    if (gap > this.maxGap && this.buf) { this.slow += 1; if (this.slow > 3) { this.buf = ''; this.slow = 0; return true; } }
    return !this.buf;
  }
  /** A printable key. Returns true when it is the first key of a burst — the moment to remember what the focused input held. */
  char(k: string, t: number): boolean { const first = this.tick(t); this.buf += k; return first; }
  /** Enter. Returns the scanned code, or null when this was ordinary typing. */
  enter(t: number): string | null {
    this.tick(t);
    const code = this.buf, slow = this.slow; this.buf = ''; this.slow = 0;
    const need = slow === 0 ? this.minLength : slow <= 2 ? Math.max(6, this.minLength) : Math.max(8, this.minLength);
    return code.length >= need ? code : null;
  }
}
