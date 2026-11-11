import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import samlify from 'samlify';
import { DOMParser } from '@xmldom/xmldom';

// Step 4: the samlify instance this spec drives for the service-provider side is NOT the plugin's copy
// anymore (the plugin resolves its own). samlify >= 2.15 refuses to parse without a registered schema
// validator, so the SP side registers the same demonstration-grade structural check the plugin registers
// on its own instance (well-formed XML rooted in a SAML namespace; signatures/conditions are samlify's).
const SAML_NS = ['urn:oasis:names:tc:SAML:2.0:protocol', 'urn:oasis:names:tc:SAML:2.0:assertion'];
samlify.setSchemaValidator({
  validate: async (xml: unknown) => {
    const root = new DOMParser().parseFromString(String(xml), 'text/xml')?.documentElement;
    if (!root || !SAML_NS.includes(root.namespaceURI ?? '')) throw new Error('not a SAML message');
  },
});
import { EventsModule } from '../events/events.module.js';
import { PluginsV1Module } from '../plugins/v1/plugins-v1.module.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { ApplicationBus } from '../events/application-bus.service.js';
import { AppConnectorService } from '../connectors/app-connector.js';
import { SSO_DIRECTORY, MemorySsoDirectory } from './oidc.js';
import { samlAttributesFor, fillResponseTemplate, decodeIssuer } from './saml.js';
import { startTestBus, TestBus } from '../testing/test-bus.js';

// Step 3 cleanup (decision 6): PluginsV1Module requires a reachable bus - one nats+core pair for this spec file.
let testBus: TestBus | undefined;
before(async () => { testBus = await startTestBus(import.meta.url); });
after(async () => { await testBus?.close(); });

async function eventually(check: () => boolean) {
  for (let i = 0; i < 60; i++) { if (check()) return; await new Promise(r => setTimeout(r, 50)); }
  assert.ok(check(), 'expected durable SSO event was not delivered');
}

const T = 'acme-demo', PORT = 13583, BASE = `http://localhost:${PORT}`, ISS = `${BASE}/sso/${T}/saml`;
const PAYROLL_ENTITY = 'https://payroll.example.invalid/saml/metadata', PAYROLL_ACS = 'https://payroll.example.invalid/saml/acs';
const BIND_POST = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST', BIND_REDIRECT = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';
const yanis = { id: 'yanis-leroy', display_name: 'Yanis Leroy', email: 'yanis@example.invalid', department: 'People Ops', roles: ['hr-partner'] };
const alice = { id: 'demo-alice', display_name: 'Alice Martin', email: 'alice@example.invalid', department: 'Finance', roles: ['employee'] };
const MAPPING = { NameID: 'email', givenName: 'display_name', email: 'email', roles: 'roles', department: 'department' };

describe('saml attribute mapping and response template (pure)', () => {
  const app = { attribute_mapping: { ...MAPPING, 'bad name!': 'roles', unknown: 'nope' } }; // malformed names and unknown profile keys are dropped
  it('maps only known profile keys, keeps attribute names sane, reads NameID from the mapping', () => {
    const { nameID, nameIDFormat, attributes } = samlAttributesFor(app, yanis);
    assert.equal(nameID, 'yanis@example.invalid');
    assert.equal(nameIDFormat, 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress');
    const names = attributes.map((a) => a.name).sort();
    assert.deepEqual(names, ['department', 'email', 'givenName', 'roles']);
    assert.equal(attributes.find((a) => a.name === 'roles')!.values[0], 'hr-partner');
  });
  it('without a NameID mapping the account id is used, with the unspecified format', () => {
    const { nameID, nameIDFormat } = samlAttributesFor({ attribute_mapping: { email: 'email' } }, yanis);
    assert.equal(nameID, 'yanis-leroy'); assert.equal(nameIDFormat, 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified');
  });
  it('an explicit nameid_format overrides the mapping-derived NameID', () => {
    const email = samlAttributesFor({ attribute_mapping: { NameID: 'id' }, nameid_format: 'emailAddress' } as never, yanis);
    assert.equal(email.nameID, 'yanis@example.invalid'); assert.equal(email.nameIDFormat, 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress');
    const persistent = samlAttributesFor({ attribute_mapping: { NameID: 'email' }, nameid_format: 'persistent' } as never, yanis);
    assert.equal(persistent.nameID, 'yanis-leroy'); assert.equal(persistent.nameIDFormat, 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent');
  });
  it('the template filler escapes XML and drops InResponseTo for an IdP-initiated response', () => {
    const t = '<samlp:Response Destination="{Destination}" InResponseTo="{InResponseTo}"><saml:Issuer>{Issuer}</saml:Issuer>{AttributeStatement}</samlp:Response>';
    const out = fillResponseTemplate(t, { Destination: 'https://a.example/acs?x=1&y=2', InResponseTo: null, Issuer: 'me', AttributeStatement: '<raw/>' });
    assert.equal(out, '<samlp:Response Destination="https://a.example/acs?x=1&amp;y=2"><saml:Issuer>me</saml:Issuer><raw/></samlp:Response>');
  });
});

describe('SAML identity provider: a service provider signs a user in (Web SSO, POST binding) through the embedded samlify', () => {
  let app: INestApplication, reg: PluginRegistry, apps: AppConnectorService, events: { type: string; payload: Record<string, string> }[] = [];
  const saved = { b: process.env.IAM_SSO_BASE_URL };
  before(async () => {
    process.env.IAM_SSO_BASE_URL = BASE;
    const guard = { canActivate: (c: any) => { const r = c.switchToHttp().getRequest(); const s = r.headers['x-test-sub']; if (!s) return false; r.user = { sub: String(s), tenant: T }; return true; } };
    const mod = await Test.createTestingModule({ imports: [EventsModule, PluginsV1Module] }).overrideGuard(AuthGuard).useValue(guard).compile();
    app = mod.createNestApplication(); await app.init(); await app.listen(PORT);
    reg = app.get(PluginRegistry); apps = app.get(AppConnectorService);
    (app.get(SSO_DIRECTORY) as MemorySsoDirectory).users.push(yanis, alice);
    app.get(ApplicationBus).consumeOnBus('sso-test', ['sso.login.succeeded', 'sso.login.denied', 'sso.login.failed', 'sso.token.issued', 'sso.assertion.issued'], (e) => { events.push({ type: e.type, payload: e.payload }); });
    await reg.install(T, 'app-connector', {}); await reg.enable(T, 'app-connector', {});
    await apps.create(T, 'admin', { id: 'payroll', name: 'Payroll', protocol: 'saml', entity_id: PAYROLL_ENTITY, acs_url: PAYROLL_ACS, enabled: true, allowed_roles: ['hr-partner'], attribute_mapping: MAPPING });
    await apps.create(T, 'admin', { id: 'off', name: 'Off', protocol: 'saml', entity_id: 'https://off.example.invalid/saml', acs_url: 'https://off.example.invalid/acs', enabled: false, allowed_roles: ['hr-partner'], attribute_mapping: {} });
  });
  after(async () => { process.env.IAM_SSO_BASE_URL = saved.b; await app.close(); });

  /** The IdP as the SP sees it: entity id and signing certificate from the published metadata. */
  async function idpForSp(wantSigned = false) {
    const meta = await (await fetch(`${ISS}/metadata`)).text();
    const cert = meta.match(/<ds:X509Certificate>([^<]+)<\/ds:X509Certificate>/)![1];
    return samlify.IdentityProvider({
      entityID: ISS, signingCert: `-----BEGIN CERTIFICATE-----\n${cert}\n-----END CERTIFICATE-----`,
      singleSignOnService: [{ Binding: BIND_REDIRECT, Location: `${ISS}/login` }, { Binding: BIND_POST, Location: `${ISS}/login` }],
      wantAuthnRequestsSigned: wantSigned,
    });
  }
  const makeSp = (entityID = PAYROLL_ENTITY, acs = PAYROLL_ACS) =>
    samlify.ServiceProvider({ entityID, authnRequestsSigned: false, wantAssertionsSigned: true, assertionConsumerService: [{ Binding: BIND_POST, Location: acs }] });

  const api = (path: string, sub?: string, body?: object) => fetch(BASE + path, { method: body ? 'POST' : 'GET', headers: { ...(sub ? { 'x-test-sub': sub } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });

  /** Starts an SP-initiated SSO (redirect binding) and returns the console request id and the AuthnRequest id. */
  async function begin(sub: string, opts: { relay?: string; sp?: any } = {}) {
    const idp = await idpForSp();
    const r = (opts.sp ?? makeSp()).createLoginRequest(idp, 'redirect', { relayState: opts.relay ?? 'rs-1' });
    const url = typeof r === 'string' ? r : r.context;
    const res = await fetch(String(url), { redirect: 'manual' });
    const loc = res.headers.get('location') ?? '';
    assert.equal(res.status, 302, `expected a redirect to the console, got ${res.status}: ${await res.text()}`);
    assert.match(loc, /^\/sso-saml\/[0-9a-f]+\?tenant=acme-demo$/);
    return { rid: loc.split('/')[2].split('?')[0], authnId: typeof r === 'string' ? undefined : r.id };
  }

  it('is a 404 while the saml-idp plugin is off, then publishes its metadata (entity id, certificate, SSO endpoint)', async () => {
    assert.equal((await fetch(`${ISS}/metadata`)).status, 404);
    await reg.install(T, 'saml-idp', {}); await reg.enable(T, 'saml-idp', {});
    const res = await fetch(`${ISS}/metadata`);
    assert.equal(res.status, 200);
    const meta = await res.text();
    assert.ok(meta.includes('<md:EntityDescriptor') || meta.includes('<EntityDescriptor'), 'an EntityDescriptor');
    assert.ok(meta.includes(`entityID="${ISS}"`), 'the public entity id');
    assert.ok(meta.includes('X509Certificate') && meta.includes('SingleSignOnService'));
  });

  it('signs an HR user in end to end: consent, then a signed response the SP verifies with the published certificate', async () => {
    const { rid, authnId } = await begin('yanis-leroy');
    assert.equal((await api(`/sso/${T}/saml-interaction/${rid}`)).status, 403, 'the console API needs a signed-in user');
    const det = await (await api(`/sso/${T}/saml-interaction/${rid}`, 'yanis-leroy')).json() as any;
    assert.deepEqual(det, { app: { id: 'payroll', name: 'Payroll', description: '' }, attributes: ['NameID', 'givenName', 'email', 'roles', 'department'], user: { sub: 'yanis-leroy', name: 'Yanis Leroy' }, allowed: true });
    const done = await (await api(`/sso/${T}/saml-interaction/${rid}/complete`, 'yanis-leroy', { decision: 'allow' })).json() as any;
    assert.equal(done.acsUrl, PAYROLL_ACS); assert.equal(done.relayState, 'rs-1');
    const xml = Buffer.from(done.samlResponse, 'base64').toString('utf8');
    assert.ok(xml.includes('urn:oasis:names:tc:SAML:2.0:status:Success'));
    if (authnId) assert.ok(xml.includes(`InResponseTo="${authnId}"`), 'the response answers the request');
    const parsed = await makeSp().parseLoginResponse(await idpForSp(), 'post', { body: { SAMLResponse: done.samlResponse, RelayState: 'rs-1' } });
    assert.equal(parsed.extract.nameID, 'yanis@example.invalid');
    const attrs = parsed.extract.attributes as Record<string, string | string[]>;
    assert.deepEqual([].concat(attrs.roles as any), ['hr-partner']);
    assert.deepEqual([].concat(attrs.givenName as any), ['Yanis Leroy']);
    assert.deepEqual([].concat(attrs.department as any), ['People Ops']);
    await eventually(() => events.some((e) => e.type === 'sso.assertion.issued' && e.payload.app === 'payroll' && e.payload.subject === 'yanis-leroy'));
    await eventually(() => events.some((e) => e.type === 'sso.login.succeeded' && e.payload.app === 'payroll'));
  });

  it('IdP-initiated: ?app= starts SSO without an SP request, the response carries no InResponseTo and the SP accepts it', async () => {
    const r = await fetch(`${ISS}/login?app=payroll`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    const rid = (r.headers.get('location') ?? '').split('/')[2].split('?')[0];
    const det = await (await api(`/sso/${T}/saml-interaction/${rid}`, 'yanis-leroy')).json() as any;
    assert.equal(det.app.id, 'payroll'); assert.equal(det.allowed, true);
    const done = await (await api(`/sso/${T}/saml-interaction/${rid}/complete`, 'yanis-leroy', { decision: 'allow' })).json() as any;
    assert.equal(done.acsUrl, PAYROLL_ACS);
    const xml = Buffer.from(done.samlResponse, 'base64').toString('utf8');
    assert.ok(!xml.includes('InResponseTo'), 'unsolicited: no request is answered');
    const parsed = await makeSp().parseLoginResponse(await idpForSp(), 'post', { body: { SAMLResponse: done.samlResponse } });
    assert.equal(parsed.extract.nameID, 'yanis@example.invalid');
    await eventually(() => events.some((e) => e.type === 'sso.login.succeeded' && e.payload.app === 'payroll' && e.payload.subject === 'yanis-leroy'));
  });

  it('passes RelayState back unchanged', async () => {
    const { rid } = await begin('yanis-leroy', { relay: 'opaque-state-42' });
    const done = await (await api(`/sso/${T}/saml-interaction/${rid}/complete`, 'yanis-leroy', { decision: 'allow' })).json() as any;
    assert.equal(done.relayState, 'opaque-state-42');
  });

  it('honours a user who declines at the consent screen: a signed RequestDenied answer, no attributes', async () => {
    const { rid } = await begin('yanis-leroy');
    const done = await (await api(`/sso/${T}/saml-interaction/${rid}/complete`, 'yanis-leroy', { decision: 'deny' })).json() as any;
    assert.equal(done.acsUrl, PAYROLL_ACS);
    const xml = Buffer.from(done.samlResponse, 'base64').toString('utf8');
    assert.ok(xml.includes('urn:oasis:names:tc:SAML:2.0:status:RequestDenied'));
    assert.ok(xml.includes('SignatureValue'), 'still signed, so the application can trust the refusal');
    assert.ok(!xml.includes('AttributeStatement'));
    await eventually(() => events.some((e) => e.type === 'sso.login.denied' && e.payload.reason === 'user-declined'));
  });

  it('refuses a user without an allowed role, with the same signed RequestDenied answer', async () => {
    const { rid } = await begin('demo-alice');
    const det = await (await api(`/sso/${T}/saml-interaction/${rid}`, 'demo-alice')).json() as any;
    assert.equal(det.allowed, false);
    const done = await (await api(`/sso/${T}/saml-interaction/${rid}/complete`, 'demo-alice', { decision: 'allow' })).json() as any;
    assert.ok(Buffer.from(done.samlResponse, 'base64').toString('utf8').includes('RequestDenied'));
    await eventually(() => events.some((e) => e.type === 'sso.login.denied' && e.payload.subject === 'demo-alice' && e.payload.reason === 'not-allowed'));
  });

  it('signed AuthnRequests: verified against the registered SP certificate, unsigned refused when required', async () => {
    // @ts-expect-error - the plugin's demo self-signed helper is a plain .mjs without type declarations
    const { selfSignedCert } = await import('../../../../plugins/saml-idp/selfsigned.mjs') as any;
    const spKey = selfSignedCert('SP test (fictional)');
    await apps.create(T, 'admin', { id: 'signed-sp', name: 'Signed SP', protocol: 'saml', entity_id: 'https://signed.example.invalid/saml', acs_url: 'https://signed.example.invalid/acs', enabled: true, allowed_roles: ['hr-partner'], attribute_mapping: MAPPING, sp_certificate: spKey.certPem, want_signed_requests: true });
    const idp = await idpForSp(true);
    const signedSp = samlify.ServiceProvider({ entityID: 'https://signed.example.invalid/saml', signingCert: spKey.certPem, privateKey: spKey.privateKeyPem, authnRequestsSigned: true, assertionConsumerService: [{ Binding: BIND_POST, Location: 'https://signed.example.invalid/acs' }] });
    // a signed request is accepted and signs the user in
    const r = signedSp.createLoginRequest(idp, 'redirect', {});
    const res = await fetch(String(typeof r === 'string' ? r : r.context), { redirect: 'manual' });
    assert.equal(res.status, 302, `signed request accepted, got ${res.status}: ${await res.text()}`);
    // the same entity without a signature is refused
    const unsigned = makeSp('https://signed.example.invalid/saml', 'https://signed.example.invalid/acs').createLoginRequest(await idpForSp(), 'redirect', {});
    const res2 = await fetch(String(typeof unsigned === 'string' ? unsigned : unsigned.context), { redirect: 'manual' });
    assert.equal(res2.status, 400, 'unsigned AuthnRequest refused while the application requires a signature');
  });

  it('negative tests: unknown service provider, ACS mismatch, disabled application, bad decision, single use', async () => {
    const stranger = makeSp('https://stranger.example.invalid/saml', 'https://stranger.example.invalid/acs');
    // unknown SP: a well-formed AuthnRequest from an entity the registry does not know
    const idp = await idpForSp();
    const bad = stranger.createLoginRequest(idp, 'redirect', {});
    let r = await fetch(String(typeof bad === 'string' ? bad : bad.context), { redirect: 'manual' });
    assert.equal(r.status, 400); assert.match(await r.text(), /unknown service provider/);
    await eventually(() => events.some((e) => e.type === 'sso.login.failed' && e.payload.reason === 'unknown-service-provider'));
    // ACS mismatch: the payroll entity but a different consumer URL
    const moved = makeSp(PAYROLL_ENTITY, 'https://payroll.example.invalid/other-acs');
    const m = moved.createLoginRequest(idp, 'redirect', {});
    r = await fetch(String(typeof m === 'string' ? m : m.context), { redirect: 'manual' });
    assert.equal(r.status, 400); assert.match(await r.text(), /AssertionConsumerServiceURL/);
    // disabled application
    const off = makeSp('https://off.example.invalid/saml', 'https://off.example.invalid/acs');
    const o = off.createLoginRequest(idp, 'redirect', {});
    r = await fetch(String(typeof o === 'string' ? o : o.context), { redirect: 'manual' });
    assert.equal(r.status, 400); assert.match(await r.text(), /disabled/);
    await eventually(() => events.some((e) => e.type === 'sso.login.denied' && e.payload.reason === 'application-disabled'));
    // bad decision + single use of a request
    const { rid } = await begin('yanis-leroy');
    assert.equal((await api(`/sso/${T}/saml-interaction/${rid}/complete`, 'yanis-leroy', { decision: 'maybe' })).status, 400);
    await api(`/sso/${T}/saml-interaction/${rid}/complete`, 'yanis-leroy', { decision: 'allow' });
    assert.equal((await api(`/sso/${T}/saml-interaction/${rid}/complete`, 'yanis-leroy', { decision: 'allow' })).status, 404);
    assert.equal((await api(`/sso/${T}/saml-interaction/does-not-exist`, 'yanis-leroy')).status, 404);
  });

  it('a tampered response does not verify on the SP side', async () => {
    const { rid } = await begin('yanis-leroy');
    const done = await (await api(`/sso/${T}/saml-interaction/${rid}/complete`, 'yanis-leroy', { decision: 'allow' })).json() as any;
    const s = done.samlResponse as string;
    const flip = s.slice(0, 200) + (s[200] === 'A' ? 'B' : 'A') + s.slice(201);
    await assert.rejects(makeSp().parseLoginResponse(await idpForSp(), 'post', { body: { SAMLResponse: flip } }));
  });

  it('accepts an AuthnRequest sent with the POST binding too', async () => {
    const idp = await idpForSp();
    const r = makeSp().createLoginRequest(idp, 'post', { relayState: 'rs-post' }) as any;
    const res = await fetch(`${ISS}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `SAMLRequest=${encodeURIComponent(r.context)}&RelayState=rs-post`, redirect: 'manual' });
    assert.equal(res.status, 302); assert.match(res.headers.get('location') ?? '', /^\/sso-saml\//);
  });

  it('supports IdP-initiated SSO (no InResponseTo) and still signs', async () => {
    const res = await fetch(`${ISS}/login?app=payroll`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    const rid = (res.headers.get('location') ?? '').split('/')[2].split('?')[0];
    const done = await (await api(`/sso/${T}/saml-interaction/${rid}/complete`, 'yanis-leroy', { decision: 'allow' })).json() as any;
    const xml = Buffer.from(done.samlResponse, 'base64').toString('utf8');
    assert.ok(xml.includes('urn:oasis:names:tc:SAML:2.0:status:Success'));
    assert.ok(!xml.includes('InResponseTo'));
    await makeSp().parseLoginResponse(await idpForSp(), 'post', { body: { SAMLResponse: done.samlResponse } });
  });

  it('decodes the issuer of a redirect-binding AuthnRequest', async () => {
    const idp = await idpForSp();
    const r = makeSp().createLoginRequest(idp, 'redirect', {}) as any;
    const req = new URL(typeof r === 'string' ? r : r.context).searchParams.get('SAMLRequest')!;
    assert.equal(decodeIssuer(req, true), PAYROLL_ENTITY);
  });

  it('closes again when the plugin is switched off', async () => {
    await reg.disable(T, 'saml-idp');
    assert.equal((await fetch(`${ISS}/metadata`)).status, 404);
    assert.equal((await fetch(`${ISS}/login?app=payroll`)).status, 404);
  });
});
