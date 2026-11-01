import { BadRequestException, Controller, Get, Query, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { AdminGuard } from '../auth/admin.guard.js';

const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9])[A-Za-z0-9.-]*(\.[A-Za-z]{2,})/g;
const DENY = /(token|password|secret|credential|authorization|cookie|api.?key|hash|salt|otp|signature)/i;
/** Second line of defence: the core already masks, the API scrubs again and forwards only the known fields. */
export function scrub(r: any) {
  const payload: Record<string, string> = {};
  for (const [k, v] of Object.entries(r?.payload ?? {})) payload[k] = DENY.test(k) && k !== 'effectKey' ? '[masked]' : String(v).replace(EMAIL, '$1***@$2***$3').slice(0, 120);
  const s = (v: unknown, n = 80) => (v == null ? v : String(v).slice(0, n));
  return {
    seq: Number(r.seq), at_ms: Number(r.at_ms), envelope_id: s(r.envelope_id), kind: s(r.kind), mode: s(r.mode), tenant: s(r.tenant), effect_key: s(r.effect_key),
    payload, elapsed_ms: Number(r.elapsed_ms), verdict: s(r.verdict),
    expected: (r.expected ?? []).map((e: any) => ({ id: s(e.id), mandatory: !!e.mandatory })),
    outcomes: (r.outcomes ?? []).map((o: any) => ({ id: s(o.id), mandatory: !!o.mandatory, status: s(o.status), verdict: s(o.verdict), detail: s(o.detail), data_keys: Array.isArray(o.data_keys) ? o.data_keys.map((x: unknown) => s(x)) : null })),
  };
}

/**
 * Event bus observer: READ ONLY. One GET that reads the core's record of what really went through the NATS bus
 * (events, who was expected, who answered, delay, silence). No route emits, replays or answers anything.
 * Needs a sign-in and the admin capability. The core admin token never leaves the server.
 */
@UseGuards(AuthGuard, AdminGuard)
@Controller('bus')
export class BusObserverController {
  @Get('records')
  async records(@Query('after') after?: string, @Query('limit') limit?: string) {
    for (const [n, v] of [['after', after], ['limit', limit]] as const) if (v !== undefined && !/^\d{1,9}$/.test(v)) throw new BadRequestException(`${n} must be a number`);
    const url = process.env.IAM_CORE_URL, tok = process.env.IAM_CORE_ADMIN_TOKEN;
    if (!url || !tok) throw new ServiceUnavailableException('the core is not connected (IAM_CORE_URL / IAM_CORE_ADMIN_TOKEN)');
    let res: Response;
    try { res = await fetch(`${url}/v1/bus/records?after=${after ?? 0}&limit=${limit ?? 200}`, { headers: { 'x-core-admin-token': tok }, signal: AbortSignal.timeout(3000) }); }
    catch { throw new ServiceUnavailableException('the core does not answer'); }
    if (!res.ok) throw new ServiceUnavailableException(`the core refused the read (${res.status})`);
    const b: any = await res.json();
    return { enabled: !!b.enabled, records: (b.records ?? []).map(scrub), first_seq: b.first_seq ?? 0, last_seq: b.last_seq ?? 0, capacity: b.capacity ?? 0, note: b.note ?? '' };
  }
}
