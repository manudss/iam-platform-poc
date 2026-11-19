import { workspaceMode } from '../../workspace/context.js';
import { BranchRegistries } from '../../plugins/v1/branch-registries.js';
import { PluginRegistry } from '../../plugins/v1/registry.js';
import { EnrollmentStore } from '../../authn/enroll-store.js';
import { CORE_SETTINGS_ID, isEmptyConfig, parseStored, validateConfig } from '../../authn/config.js';
import { SEED_CONFIG } from './authn-config.js';
// Published fictional credentials of the frozen initial demo, never production secrets.
export const DEMO_TOTP_SECRET = 'JBSWY3DPEHPK3PXP', DEMO_PIN = '246810', DEMO_PIN8 = '24681024';
export async function seedAuthnV1(tenant: string, reg: PluginRegistry, enroll: EnrollmentStore, branches?: BranchRegistries): Promise<boolean> {
    const main = await (workspaceMode() ? branches!.get('main') : reg);
    if (!isEmptyConfig(parseStored(await main.coreSettings(tenant, CORE_SETTINGS_ID)))) return false;
    const cfg = validateConfig(SEED_CONFIG);
    await main.putCoreSettings(tenant, CORE_SETTINGS_ID, cfg as unknown as Record<string, unknown>);
    // The seeded chains use TOTP, e-mail code, PIN and passkey: their method plugins must serve the slots (step 2).
    // The profile components they ship (passkey management, authenticator setup) run plugin JS in the console: the uiComponents grant.
    for (const id of ['auth-totp', 'auth-email-otp', 'auth-digit-code', 'auth-webauthn']) { try { await main.install(tenant, id, {}); } catch (e) { if (process.env.IAM_DATA_MIGRATIONS === '1') throw e; /* legacy demo behavior */ } try { await main.enable(tenant, id, { uiComponents: true }); } catch (e) { if (process.env.IAM_DATA_MIGRATIONS === '1') throw e; console.warn('authn demo seed: cannot enable', id, (e as Error).message); } }
    const have = await enroll.status(tenant, 'demo-alice');
    if (!have['authenticator-app']) await enroll.setTotp(tenant, 'demo-alice', 'authenticator-app', DEMO_TOTP_SECRET);
    if (!have['pin-keypad']) await enroll.setPin(tenant, 'demo-alice', 'pin-keypad', DEMO_PIN);
    if (!have['pin-keypad-8']) await enroll.setPin(tenant, 'demo-alice', 'pin-keypad-8', DEMO_PIN8);
    if (!have['e-mail-code']) await enroll.setEmail(tenant, 'demo-alice', 'e-mail-code', 'alice@example.invalid');
    return true;
}
