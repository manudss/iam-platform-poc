/**
 * saml-idp plugin: the platform acts as the SAML 2.0 Identity Provider for the SAML applications registered
 * in `app-connector` (entity_id, acs_url, attribute_mapping, allowed_roles). All protocol logic lives in this
 * folder; the core only mounts the engine and feeds it dependencies through `createSamlEngine(deps)`
 * (same deps contract as the oidc-provider plugin).
 *
 * The protocol is the embedded library samlify (MIT, pinned >= 2.15.1: earlier versions could accept a
 * response signed with an attacker's certificate). DEMONSTRATION GRADE, not production: AuthnRequests are
 * accepted unsigned (the registry holds no SP certificate), assertions are signed (RSA-SHA256) with a
 * per-process demo key unless the secret store provides one, and pending sign-in requests live in memory.
 * Sessions stay the console's: the user signs in with the normal authentication chain on /sso-saml/<rid>,
 * then consents; the browser posts the SAMLResponse to the application's ACS. Turning the plugin off removes
 * every /sso/:tenant/saml endpoint (404) without touching the registry.
 */
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { selfSignedCert } from './selfsigned.mjs';

// Self-contained copy of the access rule (same rule as the oidc-provider plugin; plugins never import each other).
const mayOpen = (app, u) => !!u && app.enabled && app.allowed_roles.some((r) => u.roles.includes(r));

// No top-level await: the loader and the core adapter sync-load this module with createRequire.
const require = createRequire(process.env.IAM_API_PACKAGE_JSON ?? new URL('../../apps/api/package.json', import.meta.url));
const samlify = require('samlify');
const { DOMParser } = require('@xmldom/xmldom');
const { BadRequestException, NotFoundException } = require('@nestjs/common');

export const SAML_PLUGIN = 'saml-idp';

// samlify >= 2.15 refuses to parse any SAML message until a schema validator is registered. The XSD validator it
// documents (@authenio/samlify-xsd-schema-validator) compiles a Java program at install, which neither this
// repository's CI nor the free demo container has. This structural check stands in for it at DEMONSTRATION grade:
// the message must be well-formed XML rooted in a SAML namespace. The security-bearing checks (signature against the
// IdP certificate, conditions, audience, replay) are samlify's own and still apply. A production deployment
// registers a real XSD validator instead.
const SAML_NS = ['urn:oasis:names:tc:SAML:2.0:protocol', 'urn:oasis:names:tc:SAML:2.0:assertion'];
samlify.setSchemaValidator({
  validate: async (xml) => {
    const root = new DOMParser().parseFromString(String(xml), 'text/xml')?.documentElement;
    if (!root || !SAML_NS.includes(root.namespaceURI ?? '')) throw new Error('not a SAML message');
  },
});
const BIND_REDIRECT = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';
const BIND_POST = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST';
const NID_EMAIL = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';
const NID_UNSPEC = 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified';
const STATUS_SUCCESS = 'urn:oasis:names:tc:SAML:2.0:status:Success';
const STATUS_RESPONDER = 'urn:oasis:names:tc:SAML:2.0:status:Responder';
const STATUS_DENIED = 'urn:oasis:names:tc:SAML:2.0:status:RequestDenied';
const ATTR_FORMAT_BASIC = 'urn:oasis:names:tc:SAML:2.0:attrname-format:basic';
const AUTHN_PASSWORD_PROTECTED = 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport';
const PENDING_TTL_MS = 10 * 60 * 1000;

const xe = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const newId = () => `_${randomBytes(16).toString('hex')}`;

/** The attributes and NameID an application receives: its `attribute_mapping` (attribute name -> profile key) applied to the live user. */
export function samlAttributesFor(app, u) {
  const from = { id: u.id, email: u.email, display_name: u.display_name, department: u.department, roles: u.roles };
  let nameID = u.id, nameIDFormat = NID_UNSPEC;
  const attributes = [];
  for (const [name, key] of Object.entries(app.attribute_mapping)) {
    if (!(key in from) || !/^[A-Za-z][\w:.-]{0,63}$/.test(name)) continue;
    const v = from[key];
    if (name === 'NameID') {
      if (typeof v === 'string' && v !== '') { nameID = v; nameIDFormat = key === 'email' ? NID_EMAIL : NID_UNSPEC; }
      continue;
    }
    const values = Array.isArray(v) ? v.filter((x) => x) : typeof v === 'string' && v !== '' ? [v] : [];
    if (values.length) attributes.push({ name, values });
  }
  return { nameID, nameIDFormat, attributes };
}

/** Fills the samlify default response template. InResponseTo=null (IdP-initiated) removes the attribute entirely. */
export function fillResponseTemplate(template, v) {
  let x = template;
  if (v.InResponseTo) x = x.replaceAll('{InResponseTo}', xe(v.InResponseTo));
  else x = x.replaceAll(' InResponseTo="{InResponseTo}"', '');
  for (const [k, val] of Object.entries(v)) if (k !== 'InResponseTo' && val !== null) x = x.replaceAll(`{${k}}`, k === 'AuthnStatement' || k === 'AttributeStatement' ? String(val) : xe(String(val)));
  return x;
}

function readBody(req) {
  return new Promise((resolve, reject) => { let d = ''; req.on('data', (c) => { d += c; if (d.length > 1e6) reject(new Error('body too large')); }); req.on('end', () => resolve(d)); req.on('error', reject); });
}
/** Reads the SP entity id out of a raw AuthnRequest (redirect binding is DEFLATEd, post binding is plain base64). */
export function decodeIssuer(samlRequest, deflated) {
  const raw = deflated ? inflateRawSync(Buffer.from(samlRequest, 'base64')).toString('utf8') : Buffer.from(samlRequest, 'base64').toString('utf8');
  const m = raw.match(/<[\w-]*:?Issuer[^>]*>([^<]+)</);
  if (!m) throw new Error('no issuer');
  return m[1].trim();
}

/** Builds the IdP engine. One instance per process (the core adapter holds it). */
export function createSamlEngine(deps) {
  const env = deps.env ?? process.env;
  const warn = deps.warn ?? (() => {});
  const idps = new Map();
  const keys = new Map();
  const pending = new Map();

  function base(req) {
    const pinned = env.IAM_SSO_BASE_URL; if (pinned) return pinned.replace(/\/+$/, '');
    const proto = String(req?.headers?.['x-forwarded-proto'] ?? req?.protocol ?? 'http').split(',')[0].trim(), host = String(req?.headers?.['x-forwarded-host'] ?? req?.headers?.host ?? 'localhost').split(',')[0].trim();
    return `${proto}://${host}`;
  }
  async function active(t) { return (await deps.pluginActive(t, SAML_PLUGIN)) && (await deps.pluginActive(t, 'app-connector')); }

  /** Signing key: from the secret store (`sso/<tenant>/saml-signing-key`, fields `cert` and `privateKey`, PEM) so it survives restarts; else a self-signed one generated for this process (demo). */
  async function keyMaterial(t) {
    let k = keys.get(t); if (k) return k;
    try { const s = await deps.secretGet(`sso/${t}/saml-signing-key`); if (s?.cert && s?.privateKey) k = { certPem: String(s.cert), privateKeyPem: String(s.privateKey) }; } catch (e) { warn(`signing key not read from the secret store: ${e.message}`); }
    if (!k) { k = selfSignedCert(`IAM POC SAML IdP (${t})`); warn(`saml-idp: no signing key in the secret store, a self-signed one was generated for this process (demo); a restart invalidates the metadata`); }
    keys.set(t, k); return k;
  }
  async function idp(t, baseUrl) {
    const entityID = `${baseUrl}/sso/${t}/saml`, k = `${t}|${entityID}`;
    let e = idps.get(k); if (e) return e;
    const { certPem, privateKeyPem } = await keyMaterial(t);
    const i = samlify.IdentityProvider({
      entityID, signingCert: certPem, privateKey: privateKeyPem,
      singleSignOnService: [{ Binding: BIND_REDIRECT, Location: `${entityID}/login` }, { Binding: BIND_POST, Location: `${entityID}/login` }],
      nameIDFormat: [NID_EMAIL, NID_UNSPEC],
      wantAuthnRequestsSigned: false, // demo: the registry holds no SP certificate, AuthnRequests are accepted unsigned
    });
    e = { idp: i, entityID }; idps.set(k, e); return e;
  }
  function spFor(app) {
    const { entity_id, acs_url } = app;
    if (!entity_id || !acs_url) throw new BadRequestException('the application has no SAML entity id or ACS URL');
    return samlify.ServiceProvider({
      entityID: entity_id, authnRequestsSigned: false, wantAssertionsSigned: true,
      assertionConsumerService: [{ Binding: BIND_POST, Location: acs_url }],
    });
  }
  async function samlApp(t, id) { return (await deps.liveApps(t)).find((x) => x.id === id && x.protocol === 'saml'); }
  async function samlAppByEntity(t, entityId) { return (await deps.liveApps(t)).find((x) => x.protocol === 'saml' && x.entity_id === entityId); }

  /** Raw endpoints: metadata and login (SP-initiated via a SAMLRequest, IdP-initiated via ?app=<id>). */
  async function route(req, res) {
    const t = String(req.params.tenant ?? '');
    const fail = (code, error, message) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error, message })); };
    if (!/^[a-z0-9-]{1,32}$/.test(t) || !(await active(t))) return fail(404, 'not_found', 'the saml-idp plugin is not enabled');
    const sub = String(req.path ?? '');
    if (sub === '/metadata' && req.method === 'GET') {
      const { idp: i } = await idp(t, base(req));
      res.setHeader('content-type', 'application/samlmetadata+xml; charset=utf-8'); res.end(i.getMetadata()); return;
    }
    if (sub !== '/login' || (req.method !== 'GET' && req.method !== 'POST')) return fail(404, 'not_found', 'unknown saml endpoint');

    // Nest's parser may have read the urlencoded body already; only read the raw stream when it has not.
    const body = req.method === 'POST' ? (req.body && typeof req.body === 'object' ? req.body : Object.fromEntries(new URLSearchParams(await readBody(req)))) : {};
    const q = { ...req.query, ...body };
    let app, requestId = null;
    if (q.SAMLRequest) {
      // SP-initiated: find the application by the request issuer, then parse and validate the request with the library.
      let issuer = '';
      try { issuer = decodeIssuer(q.SAMLRequest, req.method === 'GET'); } catch { return fail(400, 'invalid_request', 'the SAMLRequest cannot be decoded'); }
      app = await samlAppByEntity(t, issuer);
      if (!app) { deps.emit('sso.login.failed', t, { app: issuer.slice(0, 80), subject: '', reason: 'unknown-service-provider' }); return fail(400, 'invalid_request', 'unknown service provider'); }
      const { idp: i } = await idp(t, base(req));
      let info;
      try { info = await i.parseLoginRequest(spFor(app), req.method === 'GET' ? 'redirect' : 'post', req.method === 'GET' ? { query: req.query } : { body }); }
      catch (e) { deps.emit('sso.login.failed', t, { app: app.id, subject: '', reason: String(e.message).slice(0, 80) }); return fail(400, 'invalid_request', 'the SAMLRequest is not valid'); }
      const r = info?.extract?.request ?? {};
      requestId = r.id ?? null;
      const reqAcs = r.assertionConsumerServiceUrl ?? r.assertionConsumerServiceURL ?? r.acsUrl;
      if (reqAcs && reqAcs !== app.acs_url) { deps.emit('sso.login.failed', t, { app: app.id, subject: '', reason: 'acs-mismatch' }); return fail(400, 'invalid_request', 'the AssertionConsumerServiceURL is not the registered one'); }
    } else if (typeof q.app === 'string') {
      app = await samlApp(t, q.app); // IdP-initiated (unsolicited response)
      if (!app) return fail(400, 'invalid_request', 'unknown application');
    } else return fail(400, 'invalid_request', 'a SAMLRequest or an app parameter is required');
    if (!app.enabled) { deps.emit('sso.login.denied', t, { app: app.id, subject: '', reason: 'application-disabled' }); return fail(400, 'access_denied', 'the application is disabled'); }
    if (!app.entity_id || !app.acs_url) return fail(400, 'invalid_request', 'the application has no SAML configuration');

    const rid = randomBytes(16).toString('hex');
    pending.set(rid, { tenant: t, appId: app.id, base: base(req), requestId, relayState: typeof q.RelayState === 'string' ? q.RelayState : undefined, at: Date.now() });
    res.statusCode = 302; res.setHeader('location', `/sso-saml/${rid}?tenant=${encodeURIComponent(t)}`); res.end();
  }

  function take(rid, tenant, remove) {
    for (const [k, p] of pending) if (p.at + PENDING_TTL_MS < Date.now()) pending.delete(k);
    const p = pending.get(rid);
    if (!p || p.tenant !== tenant) throw new NotFoundException('unknown or expired sign-in request');
    if (remove) pending.delete(rid);
    return p;
  }

  /** What the console shows after the user signed in: which application asks for what, and whether the user may open it. */
  async function details(t, rid, sub) {
    if (!(await active(t))) throw new NotFoundException('the saml-idp plugin is not enabled');
    const p = take(rid, t, false);
    const app = (await samlApp(t, p.appId)); const u = await deps.directoryUser(t, sub);
    const mapped = samlAttributesFor(app, u ?? { id: sub, display_name: '', email: '', department: '', roles: [] });
    const names = mapped.attributes.map((a) => a.name);
    if ('NameID' in app.attribute_mapping) names.unshift('NameID'); // the account identifier itself is shared too
    return { app: { id: app.id, name: app.name, description: app.description }, attributes: names, user: { sub, name: u?.display_name || sub }, allowed: mayOpen(app, u) };
  }

  /** The signed-in user answers. Returns the auto-POST payload the console sends to the application's ACS URL. */
  async function complete(t, rid, sub, decision) {
    if (decision !== 'allow' && decision !== 'deny') throw new BadRequestException("decision: 'allow' or 'deny'");
    if (!(await active(t))) throw new NotFoundException('the saml-idp plugin is not enabled');
    const p = take(rid, t, true); // single use
    const app = (await samlApp(t, p.appId)); const u = await deps.directoryUser(t, sub);
    const acs = app.acs_url;
    if (!acs || !app.entity_id) throw new BadRequestException('the application has no SAML configuration');
    const { idp: i, entityID } = await idp(t, p.base); // the same public base the metadata and the request used
    if (!mayOpen(app, u) || decision === 'deny') {
      const reason = !mayOpen(app, u) ? 'not-allowed' : 'user-declined';
      deps.emit('sso.login.denied', t, { app: app.id, subject: sub, reason });
      return { acsUrl: acs, samlResponse: await deniedResponse(entityID, acs, p.requestId, t), relayState: p.relayState };
    }
    const { nameID, nameIDFormat, attributes } = samlAttributesFor(app, u);
    const requestInfo = p.requestId ? { extract: { request: { id: p.requestId } } } : {};
    const responseId = newId(), sessionIndex = newId(), now = new Date(), later = new Date(now.getTime() + 5 * 60000);
    const attrXml = attributes.length
      ? `<saml:AttributeStatement>${attributes.map((a) => `<saml:Attribute Name="${xe(a.name)}" NameFormat="${ATTR_FORMAT_BASIC}">${a.values.map((v) => `<saml:AttributeValue xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xs="http://www.w3.org/2001/XMLSchema" xsi:type="xs:string">${xe(v)}</saml:AttributeValue>`).join('')}</saml:Attribute>`).join('')}</saml:AttributeStatement>`
      : '';
    const authnXml = `<saml:AuthnStatement AuthnInstant="${now.toISOString()}" SessionIndex="${sessionIndex}"><saml:AuthnContext><saml:AuthnContextClassRef>${AUTHN_PASSWORD_PROTECTED}</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>`;
    const res = await i.createLoginResponse(spFor(app), requestInfo, 'post', { email: nameID }, {
      relayState: p.relayState,
      customTagReplacement: (template) => ({
        id: responseId,
        context: fillResponseTemplate(template, {
          ID: responseId, AssertionID: newId(), Destination: acs, Issuer: entityID, IssueInstant: now.toISOString(),
          StatusCode: STATUS_SUCCESS, NameIDFormat: nameIDFormat, NameID: nameID,
          SubjectConfirmationDataNotOnOrAfter: later.toISOString(), SubjectRecipient: acs,
          ConditionsNotBefore: now.toISOString(), ConditionsNotOnOrAfter: later.toISOString(), Audience: app.entity_id ?? '',
          AuthnStatement: authnXml, AttributeStatement: attrXml, InResponseTo: p.requestId,
        }),
      }),
    });
    deps.emit('sso.assertion.issued', t, { app: app.id, subject: sub });
    deps.emit('sso.login.succeeded', t, { app: app.id, subject: sub });
    return { acsUrl: res.entityEndpoint ?? acs, samlResponse: res.context, relayState: res.relayState };
  }

  /** A signed error response (RequestDenied) for a refusal, so the application still gets a well-formed SAML answer. */
  async function deniedResponse(entityID, acsUrl, requestId, t) {
    const { certPem, privateKeyPem } = await keyMaterial(t);
    const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${newId()}" Version="2.0" IssueInstant="${new Date().toISOString()}" Destination="${xe(acsUrl)}"${requestId ? ` InResponseTo="${xe(requestId)}"` : ''}><saml:Issuer>${xe(entityID)}</saml:Issuer><samlp:Status><samlp:StatusCode Value="${STATUS_RESPONDER}"><samlp:StatusCode Value="${STATUS_DENIED}"/></samlp:StatusCode></samlp:Status></samlp:Response>`;
    const certBody = certPem.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''); // constructSAMLSignature wants the bare base64 body
    return samlify.SamlLib.constructSAMLSignature({ rawSamlMessage: xml, privateKey: privateKeyPem, signingCert: certBody, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', isMessageSigned: true }); // already base64
  }

  return { route, details, complete };
}

// No bus hooks: the plugin serves HTTP through the engine the core adapter mounts.
export default {};
