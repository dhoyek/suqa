'use client';
import { useState, type ReactNode } from 'react';
import { pt, type L } from '../i18n';
import Modal from './Modal';

const REASONS = ['test', 'mistake', 'other'] as const;

/** Before any cancel: what is being cancelled, what the cancel does, and why (a reason is required). */
export default function ReasonDialog({ locale, title, line, how, onOk, onClose }: { locale: L; title: string; line: ReactNode; how: string; onOk: (reason: string) => void; onClose: () => void }) {
  const [k, setK] = useState<typeof REASONS[number] | null>(null); const [note, setNote] = useState('');
  const reason = k === 'other' ? note.trim() : k ? pt(k === 'test' ? 'opsReasonTest' : 'opsReasonMistake', locale) + (note.trim() ? ` · ${note.trim()}` : '') : '';
  return (
    <Modal open onClose={onClose} title={title}
      footer={<><button className="btn ghost" onClick={onClose}>{pt('cancel', locale)}</button><span style={{ flex: 1 }} /><button className="btn danger" disabled={!reason} onClick={() => onOk(reason)}>✕ {pt('opsCancel', locale)}</button></>}>
      <p style={{ marginTop: 0 }}>{line}</p>
      <p className="muted" style={{ fontSize: 13 }}>{how}</p>
      <div className="seg" style={{ marginBottom: 8 }}>{REASONS.map(r => <button key={r} className={k === r ? 'active' : ''} onClick={() => setK(r)}>{pt(r === 'test' ? 'opsReasonTest' : r === 'mistake' ? 'opsReasonMistake' : 'opsReasonOther', locale)}</button>)}</div>
      <input className="input" placeholder={pt('opsReasonNote', locale)} value={note} onChange={e => setNote(e.target.value)} />
    </Modal>
  );
}
