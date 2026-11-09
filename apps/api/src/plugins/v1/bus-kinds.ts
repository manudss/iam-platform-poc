/**
 * Which blocking hooks travel on the event bus, and how. Kept in a dependency-free module so a lightweight
 * spec (bus-routing-coverage.spec.ts) can assert the catalogue coverage without importing the NATS host:
 * a blocking hook missing from BOTH sets (and not a documented in-process exception) is unroutable - its
 * callers (callSlot/control/queryHook) throw `bus-unavailable` and the request ends in a 500. That is the
 * PR #66 preview bug: `auth.enroll` was declared by the passkey plugin and called by the self-service
 * controller, but listed nowhere, so the hosted profile enrollment returned "Internal server error".
 */

/** Blocking kinds that travel on the bus as mandatory controls (step 3, auth migration): the serving plugin
 * answers `plugin.<id>.call`, the core merges the verdict, a silent mandatory subscriber denies (fail closed)
 * and the caller refuses when nobody answered at all. ui.screens and access.decide stay in process (decision 8). */
export const BUS_CONTROL_KINDS = new Set(['auth.authenticate', 'auth.challenge', 'risk.score', 'notify.capability',
  // The mail renderer (mail-templates): slot-targeted blocking call before a delivery (docs/mail-templates.md).
  'notify.render',
  // The sign-in method hooks (step 2): slot-targeted blocking calls (callSlot wraps the slot in the payload).
  'auth.prepare', 'auth.verify', 'auth.interact', 'auth.verification',
  // The self-service enrollment ceremony of a method (passkey options + attestation check): same slot-targeted
  // blocking call, orchestrated by the self-service controller.
  'auth.enroll',

  'directory.user.validate', 'directory.fields.validateDecls', 'directory.fields.catalogue', 'directory.fields.parseConfig',
  'directory.fields.validateConfig', 'directory.fields.effectiveSchema', 'directory.fields.checkValue', 'directory.effects.compute']);
/** Blocking kinds that travel on the bus as merged QUERIES (step 3): every active plugin answers with the
 * fields it owns, the core merges the objects; a silent or disabled plugin simply does not appear. */
export const BUS_QUERY_KINDS = new Set(['profile.enrich']);
