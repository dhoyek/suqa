// Lightweight placeholder shown by loading.tsx while a server page streams in — navigation feels instant.
export default function Skeleton({ rows = 4, header = true }: { rows?: number; header?: boolean }) {
  return (
    <div className="stack" aria-busy="true" aria-live="polite">
      {header && <div className="skel" style={{ width: '40%', height: 24 }} />}
      {Array.from({ length: rows }).map((_, i) => (
        <div className="card stack" key={i}>
          <div className="skel" style={{ width: '55%' }} />
          <div className="skel" style={{ width: '85%' }} />
          <div className="skel" style={{ width: '30%' }} />
        </div>
      ))}
    </div>
  );
}
