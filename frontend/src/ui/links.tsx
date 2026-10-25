import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

/** A click the browser would open in a new tab: Cmd/Ctrl (or Shift) held, or
 *  the middle button. */
export function wantsNewTab(e: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'button'>): boolean {
  return e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1;
}

/** For rows and cards that aren't links: a Cmd/Ctrl- or middle-click opens
 *  `to` in a new tab and returns true; a plain click returns false. */
export function openInNewTab(e: MouseEvent, to: string): boolean {
  if (!wantsNewTab(e)) return false;
  e.preventDefault();
  e.stopPropagation();
  window.open(to, '_blank', 'noopener');
  return true;
}

/** A link to a page of the app. A plain click runs `onGo` (default: go to the
 *  page in this tab); Cmd/Ctrl-click, middle-click and the browser's "Open link
 *  in new tab" open it in a new tab, keeping this one as it is. */
export function AppLink({ to, onGo, title, style, children }: {
  to: string; onGo?: () => void; title?: string; style?: CSSProperties; children: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <a href={to} title={title}
      style={{ textDecoration: 'none', color: 'inherit', display: 'inline-flex', alignItems: 'center', boxSizing: 'border-box', ...style }}
      onClick={(e) => {
        if (wantsNewTab(e) || e.altKey || e.button !== 0) return;   // the browser's own handling
        e.preventDefault();
        if (onGo) onGo(); else navigate(to);
      }}>
      {children}
    </a>
  );
}
