/** Shop open / shop closed, as a door: ajar with the doorway showing, or shut in its frame (takes the chip's text colour). */
export default function DoorIcon({ open, size = 20 }: { open: boolean; size?: number }) {
  const p = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true, style: { verticalAlign: 'middle', flex: 'none' } };
  return open ? (
    <svg {...p}>
      <path d="M3 21h18" />
      <path d="M14 5h4v16" />                                  {/* the frame, doorway empty */}
      <path d="M6 21V5.5L14 3v18" fill="currentColor" fillOpacity=".18" />   {/* the leaf, swung towards you */}
      <path d="M11 12v1.5" />
    </svg>
  ) : (
    <svg {...p}>
      <path d="M3 21h18" />
      <path d="M6 21V4h12v17" fill="currentColor" fillOpacity=".18" />
      <path d="M14.5 12v1.5" />
    </svg>
  );
}
