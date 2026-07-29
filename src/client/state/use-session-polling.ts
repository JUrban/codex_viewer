import { useEffect, useRef } from "react";

export function useSessionPolling(
  enabled: boolean,
  poll: () => Promise<unknown>,
  intervalMs: number,
): void {
  const pollRef = useRef(poll);
  pollRef.current = poll;

  useEffect(() => {
    if (!enabled) return;
    let timer: number | undefined;
    let disposed = false;

    const schedule = () => {
      if (!disposed && !document.hidden) {
        timer = window.setTimeout(run, intervalMs);
      }
    };
    const run = async () => {
      timer = undefined;
      await pollRef.current();
      schedule();
    };
    const onVisibility = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      if (!document.hidden) schedule();
    };

    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, intervalMs]);
}
