import type { ApiClient } from './api';

/**
 * My applications is the signed-in home: its code chunk and its data start during sign-in or
 * bootstrap instead of waiting for the router, the shell and the component to load first
 * (the old path fetched chunk, then shell, then data in series). The early response is consumed
 * once, only by the launchpad page, and only while fresh; anything else loads the normal way.
 */

let chunk: Promise<unknown> | undefined;
/** Starts fetching the launchpad code chunk (idempotent). */
export function preloadLaunchpadChunk(): Promise<unknown> {
  return (chunk ??= import('./launchpad'));
}

interface Prefetched { at: number; promise: Promise<unknown> }
let prefetched: Prefetched | undefined;
/** An early response older than this is never shown: the page asks again. */
const PREFETCH_TTL_MS = 30_000;

/** Fires the launchpad request ahead of the page, right after sign-in or when a stored session is restored. */
export function prefetchLaunchpad(api: ApiClient): void {
  const promise = api.raw('GET', '@/sso/{t}/launchpad');
  promise.catch(() => { /* consumed or not, a failed early request never surfaces here: the page retries */ });
  prefetched = { at: Date.now(), promise };
}

/** The early response, once. Absent or stale: undefined, the page loads normally. */
export function consumeLaunchpadPrefetch<T>(): Promise<T> | undefined {
  const p = prefetched;
  prefetched = undefined;
  return p && Date.now() - p.at <= PREFETCH_TTL_MS ? (p.promise as Promise<T>) : undefined;
}

/** Test hook: drops any pending early response. */
export function resetLaunchpadPrefetch(): void { prefetched = undefined; }
