import { screensFor, type Screen } from './screens.js';

/** Screen access is enforced by the policy engine only when switched on (the hosted demo does): IAM_SCREEN_ACCESS=1. Otherwise the legacy administrator capability decides. */
export const screenAccessOn = () => process.env.IAM_SCREEN_ACCESS === '1' && !!process.env.IAM_CORE_URL;

export interface ScreenAnswer { allow: boolean; reasons: string[]; engine: boolean }

/** Asks the policy engine whether `sub` opens `screen` (Cedar action screen:open, roles of the ACTIVE version). engine=false: no active version (before the first Apply) or no engine: the caller falls back to the legacy capability. */
export async function askScreen(tenant: string, sub: string, screen: string): Promise<ScreenAnswer> {
  const res = await fetch(`${process.env.IAM_CORE_URL}/v1/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(4000),
    body: JSON.stringify({ tenant, principal: `User::"${sub}"`, action: 'Action::"screen:open"', resource: `Screen::"${screen}"`, context: {}, audit: { source: 'http', subject: sub, note: `screen ${screen}` } }) });
  if (!res.ok) throw new Error(`core answered ${res.status}`);
  const out = (await res.json()) as { allow?: boolean; reasons?: string[]; errors?: string[] };
  const reasons = [...(out.reasons ?? [])];
  return { allow: out.allow === true, reasons, engine: !(reasons.length === 1 && reasons[0] === 'no-active-version') };
}

/** The screens among `candidates` that `sub` may open (one decision each; a super admin matches the first). */
export async function openableScreens(tenant: string, sub: string, candidates: readonly string[]): Promise<{ screens: string[]; engine: boolean }> {
  const out: string[] = []; let engine = true;
  for (const c of candidates) { const a = await askScreen(tenant, sub, c); if (!a.engine) { engine = false; break; } if (a.allow) out.push(c); }
  return { screens: out, engine };
}
export { screensFor };
export type { Screen };
