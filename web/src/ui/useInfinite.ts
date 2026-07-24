import { useEffect, useRef, useState } from "react";

/**
 * Progressive ("lazy") rendering. Returns how many items to render + a sentinel
 * ref to place at the end of the list; each time the sentinel scrolls near the
 * viewport it reveals `step` more. Resets to `step` whenever `resetKey` changes
 * (e.g. the filters changed), so we never render thousands of cards up front.
 */
export function useInfinite(total: number, step = 24, resetKey?: unknown) {
  const [shown, setShown] = useState(step);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { setShown(step); }, [resetKey, step]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || shown >= total) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) setShown((s) => Math.min(total, s + step)); },
      { rootMargin: "800px" }, // prefetch before it's visible for a seamless scroll
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown, total, step]);

  return { shown: Math.min(shown, total), sentinelRef };
}
