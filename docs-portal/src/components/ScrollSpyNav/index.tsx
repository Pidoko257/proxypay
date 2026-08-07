import React, {useCallback, useMemo} from 'react';
import clsx from 'clsx';
import {useScrollSpy} from './useScrollSpy';
import styles from './styles.module.css';

export interface ScrollSpySection {
  /** Must match the `id` of the section element on the page. */
  id: string;
  /** Visible label for the nav link. */
  label: string;
}

export interface ScrollSpyNavProps {
  sections: ScrollSpySection[];
  /** Accessible label for the nav landmark. */
  ariaLabel?: string;
  className?: string;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Sticky in-page section navigation with scroll-spy active highlighting.
 *
 * - Stays pinned to the top of the page on every screen size (CSS `sticky`).
 * - Highlights the link for the section currently in view (IntersectionObserver).
 * - Clicking a link smooth-scrolls to its section (respecting reduced-motion).
 * - Active state is conveyed by color, weight, AND an underline indicator, and
 *   exposed to assistive tech via `aria-current` — never color alone.
 */
export default function ScrollSpyNav({
  sections,
  ariaLabel = 'Section navigation',
  className,
}: ScrollSpyNavProps): React.JSX.Element {
  const sectionIds = useMemo(() => sections.map((s) => s.id), [sections]);
  const activeId = useScrollSpy(sectionIds);

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>, id: string) => {
      const target =
        typeof document !== 'undefined' ? document.getElementById(id) : null;
      if (!target) {
        // No matching element: fall back to default anchor behavior.
        return;
      }
      event.preventDefault();
      target.scrollIntoView({
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        block: 'start',
      });
      // Keep the URL hash in sync without an extra jump.
      if (typeof window !== 'undefined' && window.history?.replaceState) {
        window.history.replaceState(null, '', `#${id}`);
      }
      // Move focus to the section for keyboard/screen-reader users.
      target.setAttribute('tabindex', '-1');
      target.focus({preventScroll: true});
    },
    [],
  );

  return (
    <nav className={clsx(styles.nav, className)} aria-label={ariaLabel}>
      <ul className={styles.list}>
        {sections.map((section) => {
          const isActive = section.id === activeId;
          return (
            <li key={section.id} className={styles.item}>
              <a
                href={`#${section.id}`}
                className={clsx(styles.link, isActive && styles.linkActive)}
                aria-current={isActive ? 'true' : undefined}
                onClick={(event) => handleClick(event, section.id)}
              >
                {section.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
