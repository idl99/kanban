import type { ReactNode } from "react";
import { usePhone } from "./usePhone";

/**
 * Wrap a dropdown menu so it opens as a bottom sheet on a phone: dimmed backdrop (a tap on it closes),
 * grip, full width, scrolls when tall (`.menu-sheet` in styles.css). Elsewhere the menu renders as is.
 * Rendered in place (not portaled), so the menu's own "click outside closes" checks keep treating the
 * sheet as inside.
 */
export function MenuSheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const phone = usePhone();
  if (!phone) return <>{children}</>;
  return (
    <div className="sheet-wrap menu-sheet" onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onClick={(e) => e.target === e.currentTarget && e.stopPropagation()}>
      {children}
    </div>
  );
}
