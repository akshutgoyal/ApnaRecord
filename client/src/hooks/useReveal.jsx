import { useEffect, useRef, useState } from 'react';

/**
 * Scroll reveal, used by the landing page.
 *
 * Content is rendered visible and only hidden once the observer has confirmed it
 * is off-screen — so a JS failure, a slow chunk or reduced-motion never leaves a
 * blank page. This is one of the product's three permitted motions; everything
 * else is instant.
 */
export function useReveal({ rootMargin = '0px 0px -12% 0px', threshold = 0.08 } = {}) {
  const ref = useRef(null);
  const [state, setState] = useState('idle');

  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;

    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced || typeof IntersectionObserver === 'undefined') return undefined;

    setState('pending');

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setState('in');
            observer.disconnect();
          }
        }
      },
      { rootMargin, threshold }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [rootMargin, threshold]);

  const className = state === 'pending' ? 'reveal reveal-pending' : state === 'in' ? 'reveal reveal-in' : 'reveal';

  return { ref, className };
}

/**
 * A reveal wrapper, so a section does not need to thread refs and classes by hand.
 */
export function Reveal({ children, as: Tag = 'div', className = '', delay = 0 }) {
  const { ref, className: revealClass } = useReveal();
  return (
    <Tag ref={ref} className={`${revealClass} ${className}`} style={delay ? { animationDelay: `${delay}ms` } : undefined}>
      {children}
    </Tag>
  );
}
