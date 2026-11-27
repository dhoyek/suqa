'use client';
/** Short sounds for the till: scan beep and the new-order chime. Silent when the page has had no user gesture yet (browser rule). */
let ctx: AudioContext | null = null;
const ac = () => (ctx ??= new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)());
function tone(freq: number, at: number, dur: number, gain = 0.06, type: OscillatorType = 'sine') {
  const a = ac(); if (a.state === 'suspended') void a.resume().catch(() => undefined);
  const o = a.createOscillator(); const g = a.createGain(); const t = a.currentTime + at;
  o.type = type; o.frequency.value = freq; o.connect(g); g.connect(a.destination);
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.015); g.gain.setValueAtTime(gain, t + dur - 0.04); g.gain.linearRampToValueAtTime(0, t + dur);   // soft edges: loud without a click
  o.start(a.currentTime + at); o.stop(a.currentTime + at + dur);
}
export function beep() { try { tone(1760, 0, 0.08, 0.05, 'square'); } catch { /* no audio */ } }
/** Three rising notes, played twice, + vibration: something arrived (a new order, a driver's confirmation, a customer on his way). Loud enough for a shop floor. */
export function newOrderChime() {
  try { for (const at of [0, 0.75]) { tone(880, at, 0.16, 0.3); tone(1175, at + 0.17, 0.16, 0.3); tone(1568, at + 0.34, 0.28, 0.3); } } catch { /* no audio */ }
  try { navigator.vibrate?.([120, 60, 120]); } catch { /* no vibration */ }
}
