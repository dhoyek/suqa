'use client';
import { useEffect, useRef, useState } from 'react';

// Recording a voice message for Yorgo, shared by the storefront chat and the till: the browser's own recorder, kept small
// (speech does not need more) and stopped by itself at two minutes. The clip is handed over only when the person taps send.
type Cur = { mr: MediaRecorder; send: boolean; timer: ReturnType<typeof setTimeout> | null };
export function useVoiceRecorder(onClip: (clip: Blob) => void, onDenied: () => void) {
  const [recording, setRecording] = useState(false); const [canRecord, setCanRecord] = useState(false);
  const rec = useRef<Cur | null>(null);
  const clipRef = useRef(onClip); clipRef.current = onClip;
  const deniedRef = useRef(onDenied); deniedRef.current = onDenied;
  useEffect(() => { setCanRecord(typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined'); }, []);
  useEffect(() => () => { const r = rec.current; if (r) { r.send = false; try { r.mr.stop(); } catch { /* gone */ } } }, []);      // leaving the page drops a recording in progress
  const stop = (sendIt: boolean) => { const r = rec.current; if (!r) return; r.send = sendIt; if (r.timer) clearTimeout(r.timer); try { r.mr.stop(); } catch { /* already stopped */ } };
  const start = async () => {
    if (rec.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(m => MediaRecorder.isTypeSupported(m));
      const mr = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 32000 });
      const chunks: Blob[] = []; const cur: Cur = { mr, send: false, timer: null };
      mr.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      mr.onstop = () => {
        stream.getTracks().forEach(tr => tr.stop()); rec.current = null; setRecording(false);
        const clip = new Blob(chunks, { type: mr.mimeType || mime || 'audio/webm' });
        if (cur.send && clip.size > 800) clipRef.current(clip);
      };
      cur.timer = setTimeout(() => stop(true), 120_000);
      rec.current = cur; mr.start(); setRecording(true);
    } catch { deniedRef.current(); }
  };
  return { recording, canRecord, start, stop };
}

/** the microphone people know from their chat apps: a capsule, the cradle under it and a short stand */
export function MicIcon({ size = 20 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" style={{ display: 'block' }}>
    <rect x="9" y="2.5" width="6" height="11.5" rx="3" fill="currentColor" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>;
}
