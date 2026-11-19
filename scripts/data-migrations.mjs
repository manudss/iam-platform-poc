#!/usr/bin/env node
// Verify every immutable version and prevent a PR from rewriting released history.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, relative } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const sha = text => createHash('sha256').update(text).digest('hex');
const manifestPath = 'data/migrations/manifest.json';
if (process.argv.includes('--initialize-v1')) {
  const files = ['data/migrations/0001-initial.sql', ...readdirSync(resolve(root,'apps/api/src/migrations/v0001')).filter(f=>f.endsWith('.ts')).map(f=>'apps/api/src/migrations/v0001/'+f)].sort();
  const checksums = Object.fromEntries(files.map(f => [f, sha(readFileSync(resolve(root,f)))]));
  writeFileSync(resolve(root,manifestPath), JSON.stringify({format:1,versions:[{id:'0001',name:'Complete initial demo baseline',files:checksums,checksum:sha(JSON.stringify(checksums))}]},null,2)+'\n', {flag:'wx'});
}
const m = JSON.parse(readFileSync(resolve(root,manifestPath)));
if(m.format!==1 || !m.versions.length) throw Error('invalid manifest');
for (let i=0;i<m.versions.length;i++) {
  const v=m.versions[i];
  if(v.id!==String(i+1).padStart(4,'0') || !v.name || !Object.keys(v.files).length || sha(JSON.stringify(v.files))!==v.checksum) throw Error('invalid version');
  for(const [f,h] of Object.entries(v.files)) {
    if(relative(root,resolve(root,f))!==f || sha(readFileSync(resolve(root,f)))!==h) throw Error('immutable migration source changed: '+f);
  }
}
const baseIndex=process.argv.indexOf('--base');
if(baseIndex>=0){
 const base=process.argv[baseIndex+1];
 const found=execFileSync('git',['ls-tree',base,'--',manifestPath],{cwd:root,encoding:'utf8'}).trim();
 if(found){
  const prior=JSON.parse(execFileSync('git',['show',`${base}:${manifestPath}`],{cwd:root,encoding:'utf8'}));
  for(let i=0;i<prior.versions.length;i++) if(JSON.stringify(m.versions[i])!==JSON.stringify(prior.versions[i])) throw Error('released migration history was changed');
 }
}
console.log(`Verified ${m.versions.length} immutable data migration version(s)`);
