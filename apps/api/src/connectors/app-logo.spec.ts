import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { build, appConnectorConfig, DEMO_APP_CONNECTORS } from './app-connector.js';
const svg = (s: string) => 'data:image/svg+xml;base64,' + Buffer.from(s).toString('base64');
const body = { name: 'Logo app', protocol: 'oidc', redirect_uris: ['https://app.example/cb'] };
describe('application artwork stored in versioned configuration', () => {
  it('round trips inert SVG, supports removing it and preserves it on unrelated edits', () => {
    const logo = svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M1 1L9 9" stroke="currentColor"/></svg>');
    const a = build('test', { ...body, logo });
    assert.equal(JSON.parse(appConnectorConfig(a)).logo, logo);
    assert.equal(build('test', { name: 'Changed' }, a).logo, logo);
    assert.equal(build('test', { logo: null }, a).logo, null);
  });
  it('refuses scripts, events, external references, styles, entities, malformed XML, non-images and oversized data', () => {
    for (const source of ['<svg><script/></svg>', '<svg onload="alert(1)"/>', '<svg><image href="https://evil.invalid/a"/></svg>', '<svg style="color:red"/>', '<!DOCTYPE svg><svg/>', '<svg><path></svg>', '<svg><path fill="url(https://evil.invalid)"/></svg>']) {
      assert.throws(() => build('test', { ...body, logo: svg(source) }));
    }
    for (const logo of ['https://app.example/logo.svg', 'data:text/html;base64,AAAA', 'data:image/png;base64,AAAA', svg('x'.repeat(66000))]) assert.throws(() => build('test', { ...body, logo }));
  });
  it('embeds a validated seed asset for every existing app', () => {
    assert.equal(DEMO_APP_CONNECTORS.length, 13);
    for (const a of DEMO_APP_CONNECTORS) assert.match(build(a.id, { ...a }).logo!, /^data:image\/svg\+xml;base64,/);
  });
});
