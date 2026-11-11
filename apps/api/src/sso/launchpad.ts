import { createHash } from 'node:crypto';
import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, Put, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
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

  @Get() async list(@Param('tenant') t: string, @Req() r: { user: { sub: string; branch?: string }; headers: Record<string, unknown>; protocol?: string }, @Res() res: Response) {
    assertNotBranchTest(r);
    const body = await this.build(t, r);
    // Private per-user HTTP cache: the ETag stamps THIS person's filtered payload, so a 304 only ever
    // stands in for the same user's own list - nothing personalised is shared between users or roles.
    const etag = '"' + createHash('sha256').update(JSON.stringify(body)).digest('base64url') + '"';
    res.setHeader('Cache-Control', 'private, must-revalidate');
    res.setHeader('ETag', etag);
    if (String(r.headers?.['if-none-match'] ?? '') === etag) { res.status(304).end(); return; }
    res.json(body);
  }

  /** The person's filtered launchpad payload: rights filtering (mayOpen) runs here, on every request. */
  private async build(t: string, r: { user: { sub: string }; headers: Record<string, unknown>; protocol?: string }) {
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
      apps.push({ id: a.id, name: a.name, description: a.description, logo: logoUrl(base, t, a.logo), protocol: a.protocol, url });
    }
    const values = await this.preferences.get(t, r.user.sub, 'live');
    let saved: unknown; try { saved = JSON.parse(String(values['console.launchpad'] ?? '{}')); } catch { saved = {}; }
    return { user: { sub: r.user.sub, name: u?.display_name || r.user.sub }, apps, preferences: readPreferences(saved, apps.map(a => a.id)) };
  }
  /** Personal preferences always belong to the authenticated subject, never a body-supplied identity.
   * They use the existing live profile value store so they survive reloads and follow the user between devices. */
  @Put('preferences') async savePreferences(@Param('tenant') t: string, @Req() r: any, @Body() body: unknown) {
    assertNotBranchTest(r);
    const current = await this.build(t, r);
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

/** Stored artwork is a validated data URL (plugins/app-connector/logo.mjs): bytes + type for serving. */
const DATA_URL = /^data:image\/(png|jpeg|webp|svg\+xml);base64,([A-Za-z0-9+/]+={0,2})$/;
export function logoBytes(logo: string | null | undefined): { type: string; bytes: Buffer } | null {
  const m = logo ? DATA_URL.exec(logo) : null;
  return m ? { type: 'image/' + m[1], bytes: Buffer.from(m[2], 'base64') } : null;
}
/** The content address of an artwork: sha256 of its bytes. Unguessable, stable across restarts, changes with the artwork. */
export const logoId = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
/** In the launchpad payload the artwork travels as a content-hashed URL (immutable, cacheable), never inline. */
function logoUrl(base: string, t: string, logo: string | null | undefined): string | null {
  const art = logoBytes(logo);
  return art ? `${base}/sso/${encodeURIComponent(t)}/launchpad/logo/${logoId(art.bytes)}` : null;
}

/**
 * Artwork at its content address. Public by design: the hash is the capability (unguessable, 256 bits of the
 * artwork's own bytes), the bytes are non-personal application metadata, and the response is immutable so any
 * cache may keep it forever - this is the one piece of the launchpad that may be shared. No authentication,
 * no enumeration: an unknown hash is a 404 and reveals nothing.
 */
@Controller('sso/:tenant/launchpad/logo')
export class LaunchpadLogoController {
  constructor(private readonly apps: AppConnectorService) {}
  @Get(':id') async logo(@Param('tenant') t: string, @Param('id') id: string, @Res() res: Response) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new NotFoundException('unknown artwork');
    for (const a of await this.apps.liveApps(t)) {
      const art = logoBytes(a.logo);
      if (art && logoId(art.bytes) === id) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.setHeader('Content-Type', art.type);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.send(art.bytes);
        return;
      }
    }
    throw new NotFoundException('unknown artwork');
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
