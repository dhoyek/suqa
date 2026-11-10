'use client';
/** Short sounds for the till: scan beep and the new-order chime. Silent when the page has had no user gesture yet (browser rule). */
let ctx: AudioContext | null = null;
const ac = () => (ctx ??= new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)());
function tone(freq: number, at: number, dur: number, gain = 0.06, type: OscillatorType = 'sine') {
  const a = ac(); const o = a.createOscillator(); const g = a.createGain();
  o.type = type; o.frequency.value = freq; g.gain.value = gain; o.connect(g); g.connect(a.destination);
  o.start(a.currentTime + at); o.stop(a.currentTime + at + dur);
}
export function beep() { try { tone(1760, 0, 0.08, 0.05, 'square'); } catch { /* no audio */ } }
/** Two rising notes + vibration: an order just arrived. */
export function newOrderChime() {
  try { tone(880, 0, 0.12); tone(1318, 0.14, 0.18); } catch { /* no audio */ }
  try { navigator.vibrate?.([120, 60, 120]); } catch { /* no vibration */ }
}
