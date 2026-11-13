import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest runs without globals, so Testing Library cannot register its own auto-cleanup.
afterEach(() => cleanup());

// findBy*/waitFor default to 1 s, which flaked once when the whole monorepo pipeline (parallel Next builds)
// saturated the CPU. 5 s is still fast-failing but robust under load; no assertion is weakened.
configure({ asyncUtilTimeout: 5_000 });

// jsdom has no ResizeObserver; Radix (checkbox, etc.) measures with it. A no-op stub is enough for tests.
if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
    ResizeObserverStub;
}
