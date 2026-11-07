'use client';
import type { OrderStatus } from '@suqa/shared';

export const FLOW: OrderStatus[] = ['pending', 'accepted', 'preparing', 'ready', 'out_for_delivery', 'delivered'];
export const PICKUP_FLOW: OrderStatus[] = ['pending', 'accepted', 'preparing', 'ready', 'delivered'];
const ICON: Record<string, string> = { pending: '🧾', accepted: '✅', preparing: '👩‍🍳', ready: '📦', out_for_delivery: '🛵', delivered: '🏠' };
const PICKUP_ICON: Record<string, string> = { ...ICON, ready: '🛍️', delivered: '✅' };

/** Horizontal order-progress stepper: filled track up to the current step, pulsing current node, labels under each node. */
export default function StatusTimeline({ status, labels, compact, pickup }: { status: OrderStatus; labels: Record<OrderStatus, string>; compact?: boolean; pickup?: boolean }) {
  const FLOW_ = pickup ? PICKUP_FLOW : FLOW; const ICON_ = pickup ? PICKUP_ICON : ICON;
  const idx = FLOW_.indexOf(status);
  if (idx < 0) return null;                                   // rejected / cancelled are shown by the caller
  const pct = (idx / (FLOW_.length - 1)) * 100;
  return (
    <div className={`stepper ${compact ? 'compact' : ''}`} style={{ gridTemplateColumns: `repeat(${FLOW_.length}, 1fr)`, ['--cols' as string]: FLOW_.length }} role="list" aria-label={labels[status]}>
      <div className="stepper-track"><div className="stepper-fill" style={{ width: `${pct}%` }} /></div>
      {FLOW_.map((s, i) => (
        <div key={s} role="listitem" className={`step ${i < idx ? 'done' : i === idx ? 'current' : ''}`} aria-current={i === idx ? 'step' : undefined}>
          <span className="node">{i < idx ? '✓' : ICON_[s]}</span>
          <span className="lbl">{labels[s]}</span>
        </div>
      ))}
    </div>
  );
}
