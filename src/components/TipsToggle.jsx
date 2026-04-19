export default function TipsToggle({ active, onClick }) {
  return (
    <button
      className={`chrome-toggle chrome-toggle--tips${active ? ' active' : ''}`}
      onClick={onClick}
      aria-label={active ? 'Dismiss walkthrough tips' : 'Show walkthrough tips'}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 18h6" />
        <path d="M10 22h4" />
        <path d="M12 2a7 7 0 0 1 4 12.7V17a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-2.3A7 7 0 0 1 12 2z" />
      </svg>
    </button>
  );
}
