import { Body, Controller, Get, Inject, Injectable, Logger, OnModuleInit, Optional, Param, Post, Req, UseGuards } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { Connection } from 'mysql2/promise';
import { AuthGuard, assertNotBranchTest } from '../auth/auth.guard.js';
import { ProfileService } from '../profile/profile.service.js';
import { VersioningService } from '../versioning/versioning.service.js';
import { ApplicationBus } from '../events/application-bus.service.js';
import { SecretsService } from '../integrations/secrets.service.js';
import { AppConnector, AppConnectorService } from '../connectors/app-connector.js';
import { defaultPluginsDir } from '../plugins/v1/loader.js';

/**
 * OIDC provider (plugin `oidc-provider`, step 2 of the SSO plan): the protocol engine lives in the plugin
 * folder (`plugins/oidc-provider/handlers.mjs`); this file is the core adapter. It owns the directory
 * access (decision 2: identity storage stays core), feeds the engine its dependencies (application
 * registry, directory, secret store, event bus) and mounts its middleware at /sso/:tenant/oidc.
 */

/** The plugin engine, loaded from its signed folder (the registry verifies the signature at boot). */
interface OidcEngine {
  middleware: (req: any, res: any, next: (e?: unknown) => void) => void;
  details: (tenant: string, uid: string, sub: string, req: unknown) => Promise<unknown>;
  complete: (tenant: string, uid: string, sub: string, decision: unknown, req: unknown) => Promise<{ redirectTo: string }>;
}
interface OidcPluginModule {
  OIDC_PLUGIN: string;
  SUPPORTED_CLAIMS: readonly string[];
  PROFILE_KEYS: readonly string[];
  claimsFor: (app: Pick<AppConnector, 'attribute_mapping'>, u: DirectoryUser) => Record<string, unknown>;
  mayOpen: (app: Pick<AppConnector, 'enabled' | 'allowed_roles'>, u: DirectoryUser | undefined) => boolean;
  createOidcEngine: (deps: {
    liveApps: (tenant: string) => Promise<AppConnector[]>;
    pluginActive: (tenant: string, id: string) => Promise<boolean>;
    directoryUser: (tenant: string, id: string) => Promise<DirectoryUser | undefined>;
    secretGet: (ref: string) => Promise<Record<string, string> | undefined>;
    emit: (type: string, tenant: string, payload: Record<string, string>) => void;
    env: NodeJS.ProcessEnv;
    warn: (message: string) => void;
  }) => OidcEngine;
}
const plugin = createRequire(import.meta.url)(resolve(defaultPluginsDir(), 'oidc-provider', 'handlers.mjs')) as OidcPluginModule;

export const OIDC_PLUGIN = plugin.OIDC_PLUGIN;
/** Claims this provider can send. An application's `attribute_mapping` picks among them (any other name is ignored). */
export const SUPPORTED_CLAIMS = plugin.SUPPORTED_CLAIMS;
/** Profile keys an application may read a claim from. */
export const PROFILE_KEYS = plugin.PROFILE_KEYS;
export const claimsFor = plugin.claimsFor;
export const mayOpen = plugin.mayOpen;

export interface DirectoryUser { id: string; display_name: string; email: string; department: string; roles: string[] }
/** Where the signed-in user's attributes and roles come from (live data: Dolt main). */
export interface SsoDirectory { user(tenant: string, id: string): Promise<DirectoryUser | undefined> }
export const SSO_DIRECTORY = 'SSO_DIRECTORY';
export class DoltSsoDirectory implements SsoDirectory {
  constructor(private readonly v: VersioningService) {}
  async user(_t: string, id: string) {
    return this.v.at('main', async (c: Connection) => {
      const [u] = await c.query('select id, display_name, email, department from identities where id=? and login_enabled=1', [id]);
      const r = (u as Record<string, string | null>[])[0]; if (!r) return undefined;
      const [a] = await c.query('select role_id from assignments where identity_id=? order by role_id', [id]);
      return { id: String(r.id), display_name: r.display_name ?? '', email: r.email ?? '', department: r.department ?? '', roles: (a as { role_id: string }[]).map((x) => x.role_id) };
    });
  }
}
export class MemorySsoDirectory implements SsoDirectory {
  constructor(public users: DirectoryUser[] = []) {}
  async user(_t: string, id: string) { return this.users.find((u) => u.id === id); }
}

@Injectable()
export class OidcProviderService implements OnModuleInit {
  private readonly log = new Logger('oidc-provider');
  private readonly engine: OidcEngine;
  constructor(
    apps: AppConnectorService, profile: ProfileService,
    @Inject(SSO_DIRECTORY) dir: SsoDirectory, secrets: SecretsService,
    @Optional() events?: ApplicationBus, @Optional() private readonly host?: HttpAdapterHost,
  ) {
    this.engine = plugin.createOidcEngine({
      liveApps: (t) => apps.liveApps(t),
      pluginActive: (t, id) => profile.pluginActive(t, id, 'live'),
      directoryUser: (t, id) => dir.user(t, id),
      secretGet: (ref) => secrets.get(ref),
      emit: (type, tenant, payload) => events?.emit({ type, tenant, branch: 'main', at: new Date().toISOString(), payload }),
      env: process.env,
      warn: (m) => this.log.warn(m),
    });
  }

  /** Mounts /sso/:tenant/oidc/* on the HTTP server (before the Nest routes). */
  onModuleInit() {
    const app = this.host?.httpAdapter?.getInstance?.(); if (!app?.use) return;
    app.use('/sso/:tenant/oidc', this.engine.middleware);
  }

  details(t: string, uid: string, sub: string, req: unknown) { return this.engine.details(t, uid, sub, req); }
  complete(t: string, uid: string, sub: string, decision: unknown, req: unknown) { return this.engine.complete(t, uid, sub, decision, req); }
}

/** Console-facing API of the sign-in request (the user is signed in to the console with the normal chain; the bearer token proves who). */
@UseGuards(AuthGuard)
@Controller('sso/:tenant/interaction')
export class SsoInteractionController {
  constructor(private readonly o: OidcProviderService) {}
  @Get(':uid') details(@Param('tenant') t: string, @Param('uid') uid: string, @Req() r: { user: { sub: string; branch?: string } }) { assertNotBranchTest(r); return this.o.details(t, uid, r.user.sub, r); }
  @Post(':uid/complete') complete(@Param('tenant') t: string, @Param('uid') uid: string, @Body() b: { decision?: unknown }, @Req() r: { user: { sub: string; branch?: string } }) { assertNotBranchTest(r); return this.o.complete(t, uid, r.user.sub, b?.decision, r); }
}
