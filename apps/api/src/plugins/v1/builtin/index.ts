import { defaultPluginsDir, pluginCatalogue } from '../loader.js';
import type { PluginImpl } from '../registry.js';

/**
 * The plugins shipped with the POC, loaded from their folders under `plugins/` (plan step 1: every plugin is
 * a folder - manifest.json, handlers.mjs, signature.json). This module only adapts the folder loader to the
 * named exports the rest of the API (and the specs) use; the loader validates each manifest and verifies the
 * package signature against conf/plugin-trust.json.
 * csv-connector and scim-connector ship no hooks: they are parsing libraries the core import flow calls
 * through its adapters; registering them keeps the admin catalogue honest about what is installed.
 */
// The shared verified catalogue (P1): the folder scan and signature verifications happen once per process.
const loaded = pluginCatalogue().impls();
const byId = new Map(loaded.map((i) => [i.manifest.id, i]));
const need = (id: string): PluginImpl => {
  const p = byId.get(id);
  if (!p) throw new Error(`shipped plugin ${id} not found under ${defaultPluginsDir()}`);
  return p;
};

export const authPassword = need('auth-password');
export const authTotpBase = need('auth-totp-base');
export const authEmailOtpBase = need('auth-email-otp-base');
export const authDigitCodeBase = need('auth-digit-code-base');
export const authTotp = need('auth-totp');
export const authEmailOtp = need('auth-email-otp');
export const authDigitCode = need('auth-digit-code');
export const notifyLog = need('notify-log');
export const notifyResend = need('notify-resend');
export const mailTemplatesBase = need('mail-templates-base');
export const mailTemplates = need('mail-templates');
export const orgManager = need('org-manager');
export const riskGeo = need('risk-geo');
export const hrAttributes = need('hr-attributes');
export const profilePicture = need('profile-picture');
export const organizations = need('organizations');
export const workflowsIga = need('workflows-iga');
export const appConnector = need('app-connector');
export const policyStudio = need('policy-studio');
export const oidcProvider = need('oidc-provider');
export const samlIdp = need('saml-idp');
export const csvConnector = need('csv-connector');
export const scimConnector = need('scim-connector');
export const mcpGateway = need('mcp-gateway');
export const directory = need('directory');

/**
 * The ONE shipped registration list, sourced from the shared verified catalogue (P1: catalogue partagé) and
 * consumed by BOTH the main registry factory (plugins-v1.module) and every branch registry
 * (branch-registries): the two used to carry their own diverging hardcoded lists (branch registries silently
 * missed notify-resend, saml-idp, csv-connector, scim-connector, mcp-gateway and directory). auth-password is
 * first so callers can apply their runtime base override before registering; bases precede their replacements.
 */
export const SHIPPED_PLUGIN_IDS = ['auth-password', 'auth-totp-base', 'auth-email-otp-base', 'auth-digit-code-base', 'auth-totp', 'auth-email-otp', 'auth-digit-code', 'auth-webauthn-base', 'auth-webauthn', 'notify-log', 'notify-resend', 'mail-templates-base', 'mail-templates', 'auth-password-lockout', 'org-manager', 'risk-geo', 'hr-attributes', 'profile-picture', 'organizations', 'workflows-engine-base', 'workflows-iga', 'connector-app-base', 'app-connector', 'policy-studio', 'sso-oidc-base', 'oidc-provider', 'sso-saml-base', 'saml-idp', 'connector-csv-base', 'csv-connector', 'connector-scim-base', 'scim-connector', 'mcp-gateway-base', 'mcp-gateway', 'directory', 'branding-base'] as const;
export function shippedPlugins(): PluginImpl[] {
  const c = pluginCatalogue();
  return SHIPPED_PLUGIN_IDS.map((id) => {
    const p = c.get(id);
    if (!p) throw new Error(`shipped plugin ${id} not found under ${c.dir}`);
    return p;
  });
}

/** Fresh lockout plugin per call (fresh failure counters), keeping the factory shape the callers use. */
export function authPasswordLockout(_failures?: unknown, _base?: unknown): PluginImpl {
  // catalogue.get invokes the lockout factory: fresh failure counters per registration, no rescan.
  return pluginCatalogue().get('auth-password-lockout')!;
}
