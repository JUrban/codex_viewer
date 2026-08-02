import { useEffect, useState } from "react";

const EDGE_DISTANCE_PX = 480;

interface ControlVisibility {
  top: boolean;
  bottom: boolean;
}

const hiddenControls: ControlVisibility = { top: false, bottom: false };

export function PageJumpControls() {
  const [visible, setVisible] = useState(hiddenControls);

  useEffect(() => {
    const updateVisibility = () => {
      const pageHeight = document.documentElement.scrollHeight;
      const viewportBottom = window.scrollY + window.innerHeight;
      const next = {
        top: window.scrollY > EDGE_DISTANCE_PX,
        bottom: pageHeight > window.innerHeight &&
          pageHeight - viewportBottom > EDGE_DISTANCE_PX,
      };
      setVisible((current) => (
        current.top === next.top && current.bottom === next.bottom ? current : next
      ));
    };

    updateVisibility();
    window.addEventListener("scroll", updateVisibility, { passive: true });
    window.addEventListener("resize", updateVisibility);
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(updateVisibility);
    resizeObserver?.observe(document.documentElement);
    return () => {
      window.removeEventListener("scroll", updateVisibility);
      window.removeEventListener("resize", updateVisibility);
      resizeObserver?.disconnect();
    };
  }, []);

  const scrollTo = (top: number) => {
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      ?? false;
    window.scrollTo({ top, behavior: reduceMotion ? "auto" : "smooth" });
  };

  return (
    <nav className="page-jump-controls" aria-label="Page position">
      <button
        type="button"
        className={`page-jump-control${visible.top ? " is-visible" : ""}`}
        aria-label="Back to top"
        aria-hidden={!visible.top}
        tabIndex={visible.top ? 0 : -1}
        onClick={() => scrollTo(0)}
      >
        <span aria-hidden="true">↑</span> TOP
      </button>
      <button
        type="button"
        className={`page-jump-control${visible.bottom ? " is-visible" : ""}`}
        aria-label="Jump to bottom"
        aria-hidden={!visible.bottom}
        tabIndex={visible.bottom ? 0 : -1}
        onClick={() => scrollTo(document.documentElement.scrollHeight)}
      >
        <span aria-hidden="true">↓</span> END
      </button>
    </nav>
  );
}
