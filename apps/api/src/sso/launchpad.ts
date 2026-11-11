import { Controller, Get, Inject, Param, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, assertNotBranchTest } from '../auth/auth.guard.js';
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
      apps.push({ id: a.id, name: a.name, description: a.description, protocol: a.protocol, url });
    }
    return { user: { sub: r.user.sub, name: u?.display_name || r.user.sub }, apps };
  }
}

/** Public base URL the browser can reach: pinned by IAM_SSO_BASE_URL (the demo sets it to <origin>/api), else request-derived. Same rule as the protocol plugins. */
function baseUrl(req: { headers: Record<string, unknown>; protocol?: string }): string {
  const pinned = process.env.IAM_SSO_BASE_URL;
  if (pinned) return pinned.replace(/\/+$/, '');
  const proto = String(req?.headers?.['x-forwarded-proto'] ?? req?.protocol ?? 'http').split(',')[0].trim();
  const host = String(req?.headers?.['x-forwarded-host'] ?? req?.headers?.host ?? 'localhost').split(',')[0].trim();
  return `${proto}://${host}`;
}
