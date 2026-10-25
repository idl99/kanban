/** How far (px) a scroll must go one way before the header changes. */
const TRAVEL = 24;
/** Below this scrollTop (px) the header never shrinks. */
const NEAR_TOP = 60;

export type ShrinkInput = { y: number; dy: number; user: boolean };
export type ShrinkState = { slim: boolean; down: number; up: number };

/**
 * One scroll step of a feed: slim once the user has scrolled down TRAVEL px past NEAR_TOP, full again once they
 * scrolled up TRAVEL px or the feed is back at the top. Scrolls the user didn't make (new messages, the feed
 * resizing) only reset the travel.
 */
export function shrinkStep(s: ShrinkState, { y, dy, user }: ShrinkInput): ShrinkState {
  if (y <= 4) return { slim: false, down: 0, up: 0 };
  if (!user) return { ...s, down: 0, up: 0 };
  const down = dy > 0 ? s.down + dy : 0;
  const up = dy < 0 ? s.up - dy : 0;
  if (!s.slim && down >= TRAVEL && y > NEAR_TOP) return { slim: true, down: 0, up: 0 };
  if (s.slim && up >= TRAVEL) return { slim: false, down: 0, up: 0 };
  return { slim: s.slim, down, up };
}
