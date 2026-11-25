import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const yaml=readFileSync(new URL('../docker-compose.dev.yml',import.meta.url),'utf8');
const app=yaml.slice(yaml.indexOf('  app:\n'),yaml.indexOf('  web:\n'));
const web=yaml.slice(yaml.indexOf('  web:\n'),yaml.indexOf('\nvolumes:\n'));
const cache=s=>s.match(/- ([a-z-]+):\/root\/\.npm/)[1];
test('concurrent API and web npm installs never share the mutable npm cache',()=>{
 assert.notEqual(cache(app),cache(web));
 for(const c of [cache(app),cache(web)])assert(yaml.includes('  '+c+': {}'));
});
test('cache isolation does not disable dependency integrity or cold installs',()=>{
 assert(web.includes('npm ci --no-audit --no-fund'));
 assert(web.includes('cmp -s package-lock.json node_modules/.dev-install-stamp'));
 assert(!web.includes('--force'));assert(!web.includes('npm install'));
});
