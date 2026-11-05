// Unit tests for the MCP gateway registry helpers: no database, no network.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateUpstreamUrl, validUpstreamName, sealToken, openToken, redact, authHeader } from './upstream.service.js';
import { relayedName, jsonSchemaToZodShape } from './proxy.js';

describe('upstream URL validation (SSRF protection: only the admin registers a target)', () => {
  it('accepts https and loopback http, refuses the rest', () => {
    assert.equal(validateUpstreamUrl('https://mcp.atlassian.net/v1/sse'), 'https://mcp.atlassian.net/v1/sse');
    assert.equal(validateUpstreamUrl('http://127.0.0.1:4100'), 'http://127.0.0.1:4100/');
    assert.equal(validateUpstreamUrl('http://localhost:4100/mcp'), 'http://localhost:4100/mcp');
    assert.throws(() => validateUpstreamUrl('http://169.254.169.254/latest'), /loopback/); // cloud metadata: refused
    assert.throws(() => validateUpstreamUrl('http://internal.corp.example/mcp'), /loopback/);
    assert.throws(() => validateUpstreamUrl('ftp://example.com'), /http/);
    assert.throws(() => validateUpstreamUrl('not-a-url'), /absolute/);
    assert.throws(() => validateUpstreamUrl('https://user:pw@example.com/mcp'), /credentials/);
  });
  it('honors the IAM_MCP_UPSTREAM_HOSTS allowlist when set', () => {
    process.env.IAM_MCP_UPSTREAM_HOSTS = 'mcp.atlassian.net, example.com';
    try {
      assert.ok(validateUpstreamUrl('https://mcp.atlassian.net/x'));
      assert.throws(() => validateUpstreamUrl('https://other.example/'), /IAM_MCP_UPSTREAM_HOSTS/);
    } finally { delete process.env.IAM_MCP_UPSTREAM_HOSTS; }
  });
});

describe('upstream names and token sealing', () => {
  it('names are slugs usable as a tool prefix', () => {
    for (const ok of ['jira', 'fake-jira-2']) assert.ok(validUpstreamName(ok), ok);
    for (const bad of ['', 'Jira', '-jira', 'jira_prod', 'a'.repeat(33), 42, null]) assert.ok(!validUpstreamName(bad), String(bad));
  });
  it('seal/open round-trips and detects tampering', () => {
    const sealed = sealToken('secret-upstream-token');
    assert.ok(!sealed.includes('secret-upstream-token'));
    assert.equal(openToken(sealed), 'secret-upstream-token');
    assert.throws(() => openToken(sealed.slice(0, -4) + 'AAAA'));
  });
  it('redact removes the token from any text before logging', () => {
    assert.equal(redact('call failed with token abc123 in header', 'abc123'), 'call failed with token [redacted] in header');
  });
});

describe('upstream auth schemes (P3: bearer and Atlassian-style basic)', () => {
  it('bearer sends the raw token', () => {
    assert.equal(authHeader('bearer', null, 'tok-123'), 'Bearer tok-123');
    assert.equal(authHeader('bearer', 'ignored@example.com', 'tok-123'), 'Bearer tok-123');
  });
  it('basic sends base64(user:token), like an Atlassian API token', () => {
    const h = authHeader('basic', 'alice@example.com', 'ATATT-token');
    assert.equal(h, `Basic ${Buffer.from('alice@example.com:ATATT-token', 'utf8').toString('base64')}`);
    assert.ok(h.startsWith('Basic '));
    assert.ok(!h.includes('ATATT-token'), 'the raw token is not in clear in the header');
  });
  it('basic without a user is refused', () => {
    assert.throws(() => authHeader('basic', null, 'x'), /auth user/);
    assert.throws(() => authHeader('basic', '', 'x'), /auth user/);
  });
  it('redact covers the derived basic credential too, not only the raw token', () => {
    const basic = authHeader('basic', 'alice@example.com', 'ATATT-token');
    const b64 = Buffer.from('alice@example.com:ATATT-token', 'utf8').toString('base64');
    for (const leak of ['ATATT-token', b64, basic]) assert.equal(redact(`upstream answered with ${leak} inside`, leak), 'upstream answered with [redacted] inside');
  });
});

describe('relayed tool names and schemas', () => {
  it('names are <upstream>__<tool>, sanitized, unique, within 64 chars', () => {
    const taken = new Set<string>();
    assert.equal(relayedName('jira', 'getJiraIssue', taken), 'jira__getJiraIssue');
    assert.equal(relayedName('jira', 'get issue.v2', taken), 'jira__get_issue_v2');
    assert.equal(relayedName('jira', 'getJiraIssue', taken), 'jira__getJiraIssue-2'); // collision resolved
    assert.equal(relayedName('jira', 'getJiraIssue', taken), 'jira__getJiraIssue-3');
    assert.equal(relayedName('jira', 'getJiraIssue', taken), null); // gives up after 3
    const long = relayedName('jira', 'x'.repeat(100), taken);
    assert.ok(long !== null && long.length <= 64);
    for (const n of taken) assert.match(n, /^[a-zA-Z0-9_-]{1,64}$/);
  });
  it('jsonSchemaToZodShape maps primitives, enums, required and descriptions', () => {
    const shape = jsonSchemaToZodShape({ type: 'object', properties: {
      query: { type: 'string', description: 'text' }, n: { type: 'integer' }, flag: { type: 'boolean' },
      kind: { enum: ['a', 'b'] }, weird: { type: 'funky' } }, required: ['query'] });
    assert.ok(shape);
    const keys = Object.keys(shape!);
    assert.deepEqual(keys, ['query', 'n', 'flag', 'kind', 'weird']);
    // required field rejects undefined, optional accepts it
    assert.equal(shape!.query.safeParse(undefined).success, false);
    assert.equal(shape!.n.safeParse(undefined).success, true);
    assert.equal(shape!.kind.safeParse('a').success, true);
    assert.equal(shape!.kind.safeParse('c').success, false);
    assert.equal(shape!.weird.safeParse({ anything: true }).success, true);
  });
  it('jsonSchemaToZodShape returns undefined without an object property map', () => {
    assert.equal(jsonSchemaToZodShape(undefined), undefined);
    assert.equal(jsonSchemaToZodShape({ type: 'string' }), undefined);
  });
});
