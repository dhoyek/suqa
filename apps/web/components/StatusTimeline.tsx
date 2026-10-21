'use client';
import type { OrderStatus } from '@suqa/shared';

export const FLOW: OrderStatus[] = ['pending', 'accepted', 'preparing', 'ready', 'out_for_delivery', 'delivered'];
const ICON: Record<string, string> = { pending: '🧾', accepted: '✅', preparing: '👩‍🍳', ready: '📦', out_for_delivery: '🛵', delivered: '🏠' };

/** Horizontal order-progress stepper: filled track up to the current step, pulsing current node, labels under each node. */
export default function StatusTimeline({ status, labels, compact }: { status: OrderStatus; labels: Record<OrderStatus, string>; compact?: boolean }) {
  const idx = FLOW.indexOf(status);
  if (idx < 0) return null;                                   // rejected / cancelled are shown by the caller
  const pct = (idx / (FLOW.length - 1)) * 100;
  return (
    <div className={`stepper ${compact ? 'compact' : ''}`} role="list" aria-label={labels[status]}>
      <div className="stepper-track"><div className="stepper-fill" style={{ width: `${pct}%` }} /></div>
      {FLOW.map((s, i) => (
        <div key={s} role="listitem" className={`step ${i < idx ? 'done' : i === idx ? 'current' : ''}`} aria-current={i === idx ? 'step' : undefined}>
          <span className="node">{i < idx ? '✓' : ICON[s]}</span>
          <span className="lbl">{labels[s]}</span>
        </div>
      ))}
    </div>
  );
}
