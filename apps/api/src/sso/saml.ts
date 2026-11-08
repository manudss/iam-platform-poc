import { Body, Controller, Get, Inject, Injectable, Logger, OnModuleInit, Optional, Param, Post, Req, UseGuards } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { AuthGuard, assertNotBranchTest } from '../auth/auth.guard.js';
import { ProfileService } from '../profile/profile.service.js';
import { ApplicationBus } from '../events/application-bus.service.js';
import { SecretsService } from '../integrations/secrets.service.js';
import { AppConnector, AppConnectorService } from '../connectors/app-connector.js';
import { SSO_DIRECTORY, SsoDirectory, DirectoryUser } from './oidc.js';
import { loadPluginModule } from '../plugins/v1/loader.js';
import { PluginError, PluginRegistry } from '../plugins/v1/registry.js';
import { BranchRegistries } from '../plugins/v1/branch-registries.js';
import { engineHttpError, resolveEngine } from '../plugins/v1/engines.js';
import { workspaceMode } from '../workspace/context.js';

/**
 * SAML 2.0 identity provider (plugin `saml-idp`, step 3 of the SSO plan): the protocol engine lives in the
 * plugin folder (`plugins/saml-idp/handlers.mjs`, demo signing helper in `selfsigned.mjs`); this file is the
 * core adapter. It feeds the engine its dependencies (application registry, directory, secret store, event
 * bus) and mounts the slot's engine at /sso/:tenant/saml.
 *
 * Step 3: the engine is RESOLVED through the plugin registry (slot `sso.saml`), per request, instead of
 * being loaded by id at module scope. Disabling the plugin fails closed; a replacement plugin extending
 * `sso-saml-base` takes over with no core change.
 */

interface SamlEngine {
  route: (req: any, res: any) => Promise<void>;
  details: (tenant: string, rid: string, sub: string) => Promise<unknown>;
  complete: (tenant: string, rid: string, sub: string, decision: unknown) => Promise<{ acsUrl: string; samlResponse: string; relayState?: string }>;
}
interface SamlPluginModule {
  SAML_PLUGIN: string;
  samlAttributesFor: (app: Pick<AppConnector, 'attribute_mapping'>, u: DirectoryUser) => { nameID: string; nameIDFormat: string; attributes: { name: string; values: string[] }[] };
  fillResponseTemplate: (template: string, v: Record<string, string | null>) => string;
  decodeIssuer: (samlRequest: string, deflated: boolean) => string;
  createSamlEngine: (deps: {
    liveApps: (tenant: string) => Promise<AppConnector[]>;
    pluginActive: (tenant: string, id: string) => Promise<boolean>;
    directoryUser: (tenant: string, id: string) => Promise<DirectoryUser | undefined>;
    secretGet: (ref: string) => Promise<Record<string, string> | undefined>;
    emit: (type: string, tenant: string, payload: Record<string, string>) => void;
    env: NodeJS.ProcessEnv;
    warn: (message: string) => void;
  }) => SamlEngine;
}
const plugin = loadPluginModule('saml-idp', 'handlers.mjs') as SamlPluginModule;

const defaultPlugin = loadPluginModule('saml-idp', 'handlers.mjs') as SamlPluginModule;

export const SAML_PLUGIN = defaultPlugin.SAML_PLUGIN;
export const samlAttributesFor = defaultPlugin.samlAttributesFor;
export const fillResponseTemplate = defaultPlugin.fillResponseTemplate;
export const decodeIssuer = defaultPlugin.decodeIssuer;

@Injectable()
export class SamlIdpService implements OnModuleInit {
  private readonly log = new Logger('saml-idp');
  private readonly deps: Parameters<SamlPluginModule['createSamlEngine']>[0];
  constructor(
    apps: AppConnectorService, profile: ProfileService,
    @Inject(SSO_DIRECTORY) dir: SsoDirectory, secrets: SecretsService,
    private readonly reg: PluginRegistry, @Optional() private readonly branches?: BranchRegistries,
    @Optional() events?: ApplicationBus, @Optional() private readonly host?: HttpAdapterHost,
  ) {
    this.deps = {
      liveApps: (t) => apps.liveApps(t),
      pluginActive: (t, id) => profile.pluginActive(t, id, 'live'),
      directoryUser: (t, id) => dir.user(t, id),
      secretGet: (ref) => secrets.get(ref),
      emit: (type, tenant, payload) => events?.emit({ type, tenant, branch: 'main', at: new Date().toISOString(), payload }),
      env: process.env,
      warn: (m) => this.log.warn(m),
    };
  }

  /** The engine of the plugin currently serving the sso.saml slot for this tenant (live registry: SSO sign-in is main-only). */
  private engine(t: string): Promise<SamlEngine> {
    return resolveEngine(() => this.liveRegistry(), t, 'sso.saml', 'handlers.mjs', (mod: SamlPluginModule) => mod.createSamlEngine(this.deps), this);
  }
  private async liveRegistry(): Promise<PluginRegistry> { return workspaceMode() && this.branches ? this.branches.get('main') : this.reg; }

  /** Mounts /sso/:tenant/saml/metadata and /sso/:tenant/saml/login on the HTTP server (before the Nest routes); every request resolves the slot's provider. */
  onModuleInit() {
    const app = this.host?.httpAdapter?.getInstance?.(); if (!app?.use) return;
    app.use('/sso/:tenant/saml', (req: any, res: any) => {
      const t = String(req.params?.tenant ?? '');
      void this.engine(t).then((e) => e.route(req, res)).catch((e) => {
        if (e instanceof PluginError && (e.code === 'no-provider' || e.code === 'plugin-failed')) {
          if (!res.headersSent) { res.statusCode = e.code === 'no-provider' ? 404 : 503; res.setHeader('content-type', 'application/json'); }
          res.end(JSON.stringify({ code: e.code, message: e.message }));
          return;
        }
        this.log.warn(`saml: ${(e as Error).message}`); if (!res.headersSent) { res.statusCode = 500; res.setHeader('content-type', 'application/json'); } res.end('{"error":"server_error"}');
      });
    });
  }

  async details(t: string, rid: string, sub: string) { try { return await (await this.engine(t)).details(t, rid, sub); } catch (e) { engineHttpError(e); } }
  async complete(t: string, rid: string, sub: string, decision: unknown) { try { return await (await this.engine(t)).complete(t, rid, sub, decision); } catch (e) { engineHttpError(e); } }
}

/** Console-facing API of the SAML sign-in request (the user is signed in to the console with the normal chain). */
@UseGuards(AuthGuard)
@Controller('sso/:tenant/saml-interaction')
export class SamlInteractionController {
  constructor(private readonly s: SamlIdpService) {}
  @Get(':rid') details(@Param('tenant') t: string, @Param('rid') rid: string, @Req() r: { user: { sub: string; branch?: string } }) { assertNotBranchTest(r); return this.s.details(t, rid, r.user.sub); }
  @Post(':rid/complete') complete(@Param('tenant') t: string, @Param('rid') rid: string, @Body() b: { decision?: unknown }, @Req() r: { user: { sub: string; branch?: string } }) { assertNotBranchTest(r); return this.s.complete(t, rid, r.user.sub, b?.decision); }
}
