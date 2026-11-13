import * as React from 'react';

/**
 * Current time (ms) refreshed every `intervalMs`, without reading the clock during render
 * (keeps Cache Components prerendering deterministic). Returns `null` on the server.
 */
export function useNow(intervalMs = 1000): number | null {
  const subscribe = React.useCallback(
    (onChange: () => void) => {
      const id = setInterval(onChange, intervalMs);
      return () => clearInterval(id);
    },
    [intervalMs],
  );
  return React.useSyncExternalStore(subscribe, getNow, getServerNow);
}

let cached = 0;
function getNow(): number {
  // useSyncExternalStore requires a stable snapshot between notifications; quantise to 250 ms.
  const t = Math.floor(Date.now() / 250) * 250;
  if (t !== cached) cached = t;
  return cached;
}

function getServerNow(): null {
  return null;
}

export function useMediaQuery(query: string): boolean {
  const subscribe = React.useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    [query],
  );
  return React.useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
