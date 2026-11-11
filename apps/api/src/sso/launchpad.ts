import { BadRequestException, Body, Controller, Get, Inject, Param, Put, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, assertNotBranchTest } from '../auth/auth.guard.js';
import { PROFILE_STORE } from '../profile/profile.service.js';
import type { ProfileValueStore } from '../profile/store.js';
import { ProfileService } from '../profile/profile.service.js';
import { AppConnectorService } from '../connectors/app-connector.js';
import { SSO_DIRECTORY, SsoDirectory, mayOpen } from './oidc.js';

/**
 * Launchpad: the applications the signed-in person may open, each with the URL that starts its single
 * sign-on. SAML applications open IdP-initiated (the IdP posts the assertion straight to the application);
 * OIDC applications open on their own launch URL, which starts the authorization flow - the console session
 * the person already holds makes it single sign-on. Closed by design: an application the person's roles may
 * not open, a disabled one, or one without a usable launch never appears. Same access rule as the protocol
 * plugins (mayOpen), live data only (Dolt main), like every SSO sign-in.
 */
@UseGuards(AuthGuard)
@Controller('sso/:tenant/launchpad')
export class LaunchpadController {
  constructor(
    private readonly apps: AppConnectorService,
    private readonly profile: ProfileService,
    @Inject(PROFILE_STORE) private readonly preferences: ProfileValueStore,
    @Inject(SSO_DIRECTORY) private readonly dir: SsoDirectory,
  ) {}

  @Get() async list(@Param('tenant') t: string, @Req() r: { user: { sub: string; branch?: string }; headers: Record<string, unknown>; protocol?: string }) {
    assertNotBranchTest(r);
    const u = await this.dir.user(t, r.user.sub);
    const [oidcOn, samlOn, live] = await Promise.all([
      this.profile.pluginActive(t, 'oidc-provider', 'live'),
      this.profile.pluginActive(t, 'saml-idp', 'live'),
      this.apps.liveApps(t),
    ]);
    const base = baseUrl(r);
    const apps = [];
    for (const a of live) {
      if (!mayOpen(a, u)) continue;
      const url = a.protocol === 'saml'
        ? (samlOn ? `${base}/sso/${encodeURIComponent(t)}/saml/login?app=${encodeURIComponent(a.id)}` : null)
        : (oidcOn ? a.launch_url : null);
      if (!url) continue;
      apps.push({ id: a.id, name: a.name, description: a.description, logo: a.logo ?? null, protocol: a.protocol, url });
    }
    const values = await this.preferences.get(t, r.user.sub, 'live');
    let saved: unknown; try { saved = JSON.parse(String(values['console.launchpad'] ?? '{}')); } catch { saved = {}; }
    return { user: { sub: r.user.sub, name: u?.display_name || r.user.sub }, apps, preferences: readPreferences(saved, apps.map(a => a.id)) };
  }
  /** Personal preferences always belong to the authenticated subject, never a body-supplied identity.
   * They use the existing live profile value store so they survive reloads and follow the user between devices. */
  @Put('preferences') async savePreferences(@Param('tenant') t: string, @Req() r: any, @Body() body: unknown) {
    assertNotBranchTest(r);
    const current = await this.list(t, r);
    const preferences = validatePreferences(body, current.apps.map(a => a.id));
    await this.preferences.put(t, r.user.sub, { 'console.launchpad': JSON.stringify(preferences) }, 'live', r.user.sub);
    return { preferences };
  }
}
export interface LaunchpadPreferences { favourites: string[]; order: string[] }
export function readPreferences(value: unknown, allowed: string[]): LaunchpadPreferences {
  const v = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const clean = (xs: unknown) => Array.isArray(xs) ? [...new Set(xs.filter((x): x is string => typeof x === 'string' && allowed.includes(x)))] : [];
  return { favourites: clean(v.favourites), order: clean(v.order) };
}
export function validatePreferences(value: unknown, allowed: string[]): LaunchpadPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Expected favourites and order arrays');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !['favourites','order'].includes(k))) throw new BadRequestException('Unknown preference field');
  for (const key of ['favourites','order']) {
    const xs = v[key];
    if (!Array.isArray(xs) || xs.length > 1000 || xs.some(x => typeof x !== 'string' || !allowed.includes(x)) || new Set(xs).size !== xs.length) throw new BadRequestException(key + ': unique accessible application IDs only');
  }
  return readPreferences(v, allowed);
}

/** Public base URL the browser can reach: pinned by IAM_SSO_BASE_URL (the demo sets it to <origin>/api), else request-derived. Same rule as the protocol plugins. */
function baseUrl(req: { headers: Record<string, unknown>; protocol?: string }): string {
  const pinned = process.env.IAM_SSO_BASE_URL;
  if (pinned) return pinned.replace(/\/+$/, '');
  const proto = String(req?.headers?.['x-forwarded-proto'] ?? req?.protocol ?? 'http').split(',')[0].trim();
  const host = String(req?.headers?.['x-forwarded-host'] ?? req?.headers?.host ?? 'localhost').split(',')[0].trim();
  return `${proto}://${host}`;
}
