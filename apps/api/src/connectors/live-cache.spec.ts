import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RevisionCache } from './app-connector.js';

describe('revision-keyed cache (the live registry read behind My applications)', () => {
  it('serves the remembered value while the revision stands and recomputes when it moves', async () => {
    const cache = new RevisionCache<string>();
    let reads = 0;
    const compute = async () => `read-${++reads}`;
    assert.equal(await cache.get('tenant', 'head-1', compute), 'read-1');
    assert.equal(await cache.get('tenant', 'head-1', compute), 'read-1');
    assert.equal(reads, 1);
    assert.equal(await cache.get('tenant', 'head-2', compute), 'read-2');
    assert.equal(await cache.get('tenant', 'head-1', compute), 'read-3', 'going back recomputes too');
  });
  it('scopes entries to their key', async () => {
    const cache = new RevisionCache<string>();
    let reads = 0;
    const compute = async () => `read-${++reads}`;
    assert.equal(await cache.get('a', 'head-1', compute), 'read-1');
    assert.equal(await cache.get('b', 'head-1', compute), 'read-2');
    assert.equal(await cache.get('a', 'head-1', compute), 'read-1');
  });
  it('never caches without a revision', async () => {
    const cache = new RevisionCache<string>();
    let reads = 0;
    const compute = async () => `read-${++reads}`;
    assert.equal(await cache.get('tenant', null, compute), 'read-1');
    assert.equal(await cache.get('tenant', null, compute), 'read-2');
  });
  it('does not remember a failed read', async () => {
    const cache = new RevisionCache<string>();
    let reads = 0;
    const compute = async () => { reads++; if (reads === 1) throw new Error('dolt unreachable'); return 'ok'; };
    await assert.rejects(cache.get('tenant', 'head-1', compute));
    assert.equal(await cache.get('tenant', 'head-1', compute), 'ok');
  });
});
