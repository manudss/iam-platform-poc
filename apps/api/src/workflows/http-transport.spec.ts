import { it, describe } from 'node:test';
import assert from 'node:assert/strict';
const {safeHttp,publicAddress,withinConnection} = await import(new URL('../../../../plugins/workflow-connectors/http-transport.mjs', import.meta.url).href);
describe('outbound HTTP connection policy', () => {
  it('blocks private, loopback, link-local, mapped and documentation networks', () => {
    for (const ip of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.0.1','169.254.169.254','100.64.0.1','0.0.0.0','224.0.0.1','198.18.0.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1','2001:db8::1','2002:7f00:1::']) assert.equal(publicAddress(ip),false,ip);
    assert.equal(publicAddress('8.8.8.8'),true); assert.equal(publicAddress('2606:4700:4700::1111'),true);
  });
  it('enforces origin and slash-delimited path scopes', () => {
    for (const url of ['https://example.com/api-other','https://other.invalid/api','https://example.com/api%2f../private','https://example.com/api/%252e%252e/private']) assert.equal(withinConnection('https://example.com/api',url), false);
    for (const url of ['https://example.com/api','https://example.com/api/rows?x=1']) assert.equal(withinConnection('https://example.com/api',url),true);
  });
  it('fails before request for local targets, plaintext, embedded credentials or custom ports', async () => {
    for (const url of ['http://example.com','https://u:p@example.com','https://example.com:444','https://127.0.0.1','https://169.254.169.254']) await assert.rejects(()=>safeHttp(url));
  });
});
