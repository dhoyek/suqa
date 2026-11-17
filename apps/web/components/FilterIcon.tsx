/** The filter mark used on every filter button: three centred bars, each shorter than the one above (takes the button's text colour). */
export default function FilterIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden style={{ verticalAlign: 'middle', flex: 'none' }}>
      <path d="M3 6h18M7 12h10M10.5 18h3" />
    </svg>
  );
}
