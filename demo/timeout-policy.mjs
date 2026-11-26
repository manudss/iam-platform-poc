// Only chat streaming gets a longer upstream inactivity budget. CPU inference can
// spend over 15 seconds evaluating the tool prompt before emitting its first token.
// This is not a total turn deadline and does not change API authorization.
export const API_TIMEOUT_MS = 15_000;
export const CHAT_IDLE_TIMEOUT_MS = 300_000;
export function apiTimeoutMs(method, pathname) {
  return method === 'POST' && /^\/api\/tenants\/[^/]+\/ai\/conversations\/cv-[0-9a-f]{12}\/chat$/.test(pathname)
    ? CHAT_IDLE_TIMEOUT_MS : API_TIMEOUT_MS;
}
