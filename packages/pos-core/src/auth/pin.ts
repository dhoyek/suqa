// Staff PIN: hashed on the device with PBKDF2-SHA256 (100k iterations, per-user random salt) via WebCrypto.
// The server stores hash+salt (pos_set_pin) and syncs them to the shop's devices for offline unlock. The PIN itself never leaves the device.

const ITER = 100_000;
const subtle = () => globalThis.crypto.subtle;
const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

export async function hashPin(pin: string, salt?: string): Promise<{ hash: string; salt: string }> {
  const saltBytes = salt ? unb64(salt) : globalThis.crypto.getRandomValues(new Uint8Array(16));
  const key = await subtle().importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: ITER }, key, 256);
  return { hash: b64(bits), salt: b64(saltBytes.buffer as ArrayBuffer) };
}

export async function verifyPin(pin: string, hash: string, salt: string): Promise<boolean> {
  const h = await hashPin(pin, salt);
  // constant-time compare
  if (h.hash.length !== hash.length) return false;
  let diff = 0; for (let i = 0; i < hash.length; i++) diff |= h.hash.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
}

export const isValidPin = (pin: string): boolean => /^\d{4}$/.test(pin);

/** Offline unlock allowed while the device was online within `offlineDays`. */
export function offlineUnlockAllowed(lastOnlineAt: string | null | undefined, offlineDays: number, now = Date.now()): boolean {
  if (!lastOnlineAt) return false;
  return now - Date.parse(lastOnlineAt) <= offlineDays * 86_400_000;
}
export const daysOffline = (lastOnlineAt: string | null | undefined, now = Date.now()): number => (lastOnlineAt ? Math.floor((now - Date.parse(lastOnlineAt)) / 86_400_000) : Infinity);

/** Owner approval for a gated action (refund, void, discount above the limit, stock adjustment): any active owner's PIN. */
export async function verifyOwnerPin(pin: string, staff: Array<{ user_id: string; role: string; active?: boolean; pin_hash?: string | null; pin_salt?: string | null }>): Promise<string | null> {
  for (const s of staff) {
    if (s.role !== 'owner' || s.active === false || !s.pin_hash || !s.pin_salt) continue;
    if (await verifyPin(pin, s.pin_hash, s.pin_salt)) return s.user_id;
  }
  return null;
}

/** The shop's separate approval PIN as the till holds it (hash + salt, never the PIN). null = none set. */
export type ApprovalPin = { hash: string; salt: string; set_at?: string | null } | null;

/**
 * Approval for a gated action. When the shop has an approval PIN, only that PIN approves (the owner's login PIN is deliberately
 * NOT accepted here — the point is that it is never typed in front of the till). Without one, an owner's login PIN approves as before.
 * Returns the user id to stamp as approved_by (an owner of the shop), or null when the PIN is wrong.
 */
export async function verifyApproval(pin: string, staff: Array<{ user_id: string; role: string; active?: boolean; pin_hash?: string | null; pin_salt?: string | null }>, approval: ApprovalPin): Promise<string | null> {
  if (!approval?.hash || !approval.salt) return verifyOwnerPin(pin, staff);
  if (!(await verifyPin(pin, approval.hash, approval.salt))) return null;
  const owner = staff.find(s => s.role === 'owner' && s.active !== false) ?? staff.find(s => s.role === 'owner');
  return owner?.user_id ?? null;
}
