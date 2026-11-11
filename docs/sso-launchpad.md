# Launchpad: the signed-in user's home

Every signed-in user lands on **My applications** (`/launchpad`): the list of the applications they may actually open,
with one-click sign-on into each.

## What it shows

`GET /sso/:tenant/launchpad` (console session) answers the **live** enabled applications the user's roles open - the
same closed-by-default decision as the protocols themselves (`enabled` + at least one `allowed_role`), so the list can
never show an application the sign-on would then refuse. Each entry carries the name, description, protocol, and the
URL that opens it:

- **SAML**: the IdP-initiated single sign-on address (`GET /sso/<tenant>/saml/login?app=<id>`, docs/sso-saml.md) - the
  application receives an unsolicited, signed response;
- **OIDC**: the application's **launch URL**, registered on the application (Applications screen). The application
  starts its own code+PKCE flow; with the SSO session alive (docs/sso-oidc.md, session persistence) no credentials are
  asked again.

An application without a way in (SAML is always launchable; OIDC needs its launch URL) is listed as unavailable rather
than linked. The launchpad is the console's default route after sign-in; the admin sections stay where they were.

## Events

`sso.launchpad.viewed` (payload: `subject`, `apps` count) - in the workflow trigger catalogue and the decision audit.
