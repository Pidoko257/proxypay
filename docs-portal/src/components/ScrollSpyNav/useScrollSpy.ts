import {useEffect, useRef, useState} from 'react';

export interface UseScrollSpyOptions {
  /**
   * IntersectionObserver rootMargin. The negative bottom margin biases the
   * "active" section toward the one near the top of the viewport, which feels
   * natural when a sticky nav sits at the top of the page.
   */
  rootMargin?: string;
  /** Thresholds passed to IntersectionObserver. */
  threshold?: number | number[];
}

/**
 * Tracks which section is currently in view and returns its id.
 *
 * Uses IntersectionObserver (not scroll listeners) so the work is batched by
 * the browser and stays cheap. SSR-safe: every DOM access happens inside
 * useEffect, which never runs during server rendering.
 *
 * @param sectionIds Section element ids in document order. Order matters: when
 *   several sections are visible at once, the first one (topmost) wins.
 */
export function useScrollSpy(
  sectionIds: string[],
  {rootMargin = '-80px 0px -55% 0px', threshold = [0, 0.25, 0.5, 1]}: UseScrollSpyOptions = {},
): string {
  const [activeId, setActiveId] = useState<string>(sectionIds[0] ?? '');
  // Tracks the set of currently-intersecting section ids across observer ticks.
  const visibleIds = useRef<Set<string>>(new Set());

  // Re-create the observer whenever the list of ids changes.
  const idsKey = sectionIds.join('|');

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      return undefined;
    }

    const ids = idsKey ? idsKey.split('|') : [];
    visibleIds.current = new Set();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.id;
          if (entry.isIntersecting) {
            visibleIds.current.add(id);
          } else {
            visibleIds.current.delete(id);
          }
        }
        // Pick the first section (in document order) that is visible.
        const firstVisible = ids.find((id) => visibleIds.current.has(id));
        if (firstVisible) {
          setActiveId(firstVisible);
        }
      },
      {rootMargin, threshold},
    );

    const observed: Element[] = [];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) {
        observer.observe(el);
        observed.push(el);
      }
    }

    return () => {
      observer.disconnect();
      observed.length = 0;
    };
    // idsKey captures the section list; rootMargin/threshold are primitives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, rootMargin, JSON.stringify(threshold)]);

  return activeId;
}
