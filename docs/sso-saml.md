# SAML 2.0 identity provider (plugin `saml-idp`)

Step 3 of the SSO plan (`sso-decision.md`, `sso-oidc.md` for the OIDC sibling): the platform acts as a SAML 2.0 identity
provider for the applications declared in `app-connector` (`protocol: 'saml'`, with `entity_id`, `acs_url`,
`attribute_mapping`, `allowed_roles`). The protocol is the embedded library **samlify** (MIT, pinned exactly at 2.15.1:
earlier versions could accept a response signed with an attacker's certificate).

**Demonstration grade, like the rest of the POC.** Not production:

- AuthnRequests are accepted unsigned (the registry holds no SP certificate);
- assertions are signed (RSA-SHA256) with a self-signed certificate generated per process (pure TypeScript, no openssl
  in the free container) unless the secret store provides `sso/<tenant>/saml-signing-key` (`cert` and `privateKey`, PEM).
  A restart without the secret store changes the key: applications must re-read the metadata;
- pending sign-in requests live in memory (10 min, single use);
- samlify requires a schema validator: the documented XSD validator compiles a Java program at install, which the free
  container does not have. A structural check (well-formed XML rooted in a SAML namespace) stands in for it; the
  security-bearing checks (signature against the IdP certificate, conditions, audience, replay) are samlify's own and
  stay active. A real deployment registers an XSD validator.

## Endpoints (tenant `acme-demo`, base = `IAM_SSO_BASE_URL` or the request's forwarded host)

| Endpoint | Binding | What it is |
| --- | --- | --- |
| `GET /sso/<tenant>/saml/metadata` | - | IdP metadata: entity id `<base>/sso/<tenant>/saml`, signing certificate, SSO endpoints |
| `GET /sso/<tenant>/saml/login?SAMLRequest=...&RelayState=...` | HTTP-Redirect | SP-initiated single sign-on |
| `POST /sso/<tenant>/saml/login` (form `SAMLRequest`, `RelayState`) | HTTP-POST | SP-initiated single sign-on |
| `GET /sso/<tenant>/saml/login?app=<id>` | - | IdP-initiated single sign-on (unsolicited response) |

All of them 404 when the plugin (or `app-connector`) is off: turning the plugin off removes the endpoints without
touching the application registry.

## Sign-in flow

1. The application sends the browser to `/login` with an AuthnRequest. The IdP finds the application by the request
   issuer (it must be a registered SAML `entity_id`), validates the request with samlify, and checks the
   `AssertionConsumerServiceURL` against the registered `acs_url`.
2. The browser is redirected to the console (`/sso-saml/<rid>`). The user signs in with the normal authentication
   chain, sees which application asks for what (attribute list in plain words), and allows or cancels. A user without
   an allowed role is told so and can only go back.
3. On **Allow**, the console receives a signed SAMLResponse (assertion signed, POST binding) and auto-posts it to the
   application's ACS URL, with the RelayState untouched. The NameID and attributes come from the application's
   `attribute_mapping` applied to the live user (`NameID` mapping picks the NameID and its format).
4. On **Cancel** (or no allowed role), the application still gets a well-formed, **signed** response with the
   `RequestDenied` status, so it can trust the refusal.

Events: `sso.login.succeeded`, `sso.login.denied` (reason), `sso.login.failed` (malformed request, unknown SP, ACS
mismatch), `sso.assertion.issued`.

## Demo data

The seed (`demo-data.service.ts`) enables `saml-idp` and declares **Payroll** (`payroll`): entity id
`https://payroll.example.invalid/saml/metadata`, ACS `https://payroll.example.invalid/saml/acs`, role `hr-partner`
(Yanis Leroy holds it; the demo accounts do not).

## Testing a service provider against it

Any SAML toolkit works. With samlify itself (what `apps/api/src/sso/saml.spec.ts` does):

```js
const sp = samlify.ServiceProvider({
  entityID: 'https://payroll.example.invalid/saml/metadata',
  assertionConsumerService: [{ Binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST', Location: 'https://payroll.example.invalid/saml/acs' }],
  wantAssertionsSigned: true,
});
const metadata = await (await fetch('<base>/sso/acme-demo/saml/metadata')).text();
const idp = samlify.IdentityProvider({ entityID: '<base>/sso/acme-demo/saml', signingCert: /* X509Certificate from the metadata */, singleSignOnService: [{ Binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect', Location: '<base>/sso/acme-demo/saml/login' }] });
const { context: url } = sp.createLoginRequest(idp, 'redirect', { relayState: 'anything' });
// open url in the browser, sign in, allow; the browser POSTs the SAMLResponse to the ACS URL
await sp.parseLoginResponse(idp, 'post', { body: req.body }); // verifies the signature, conditions, audience
```
