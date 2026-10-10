/** ⭐ Important toggle (new-ticket dialog, drawer header): unattended runs review an important ticket in an auto huddle before landing. */
export function StarToggle({ on, onChange, disabled }: { on: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  const title = on
    ? "Important: Claude reviews the work in an auto huddle before landing it. Click to unmark."
    : "Mark as important: Claude reviews the work in an auto huddle before landing it";
  return (
    <button type="button" className={`star-toggle ${on ? "on" : ""}`} aria-pressed={on} aria-label="Important" title={title}
      disabled={disabled} onClick={() => onChange(!on)}>
      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
        <path d="M12 3.2l2.6 5.5 6 .8-4.4 4.1 1.1 5.9L12 16.6l-5.3 2.9 1.1-5.9-4.4-4.1 6-.8z"
          fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

/** The ⭐ before a card's title. */
export function ImportantStar() {
  return <span className="important-star" title="Important: reviewed in an auto huddle before landing" aria-label="Important">⭐</span>;
}
