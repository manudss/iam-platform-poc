import { defaultPluginsDir, loadPlugins } from '../loader.js';
import type { PluginImpl } from '../registry.js';

/**
 * The plugins shipped with the POC, loaded from their folders under `plugins/` (plan step 1: every plugin is
 * a folder - manifest.json, handlers.mjs, signature.json). This module only adapts the folder loader to the
 * named exports the rest of the API (and the specs) use; the loader validates each manifest and verifies the
 * package signature against conf/plugin-trust.json.
 * csv-connector and scim-connector ship no hooks: they are parsing libraries the core import flow calls
 * through its adapters; registering them keeps the admin catalogue honest about what is installed.
 */
const loaded = loadPlugins();
const byId = new Map(loaded.map((i) => [i.manifest.id, i]));
const need = (id: string): PluginImpl => {
  const p = byId.get(id);
  if (!p) throw new Error(`shipped plugin ${id} not found under ${defaultPluginsDir()}`);
  return p;
};

export const authPassword = need('auth-password');
export const notifyLog = need('notify-log');
export const notifyResend = need('notify-resend');
export const orgManager = need('org-manager');
export const riskGeo = need('risk-geo');
export const hrAttributes = need('hr-attributes');
export const organizations = need('organizations');
export const workflowsIga = need('workflows-iga');
export const appConnector = need('app-connector');
export const policyStudio = need('policy-studio');
export const oidcProvider = need('oidc-provider');
export const samlIdp = need('saml-idp');
export const csvConnector = need('csv-connector');
export const scimConnector = need('scim-connector');

/** Fresh lockout plugin per call (fresh failure counters), keeping the factory shape the callers use. */
export function authPasswordLockout(_failures?: unknown, _base?: unknown): PluginImpl {
  return loadPlugins().find((i) => i.manifest.id === 'auth-password-lockout')!;
}
