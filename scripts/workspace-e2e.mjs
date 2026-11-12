// Real-browser UI end-to-end (local only): starts Dolt, the Rust core, the NestJS API and `ng serve`, then drives the Angular administration (sidebar pages, deep links, refresh, mobile) with headless Chrome through playwright-core, and saves screenshots. Binds to 127.0.0.1 only.
// console with headless Chrome through playwright-core, and saves screenshots. Binds to 127.0.0.1 only.
// Needs: DOLT_BIN, CHROME_BIN, playwright-core resolvable (npm i playwright-core), built core and API (core/target/debug/iam-core, apps/api/dist).
// Usage: DOLT_BIN=... CHROME_BIN=... node scripts/ui-e2e.mjs [outDir]
import { spawn, spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { openManage } from './branch-ui.mjs';
const { chromium } = createRequire(import.meta.url)('playwright-core'); // honours NODE_PATH

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? join(tmpdir(), 'iam-ui-shots'));
mkdirSync(out, { recursive: true });
const dolt = process.env.DOLT_BIN, chrome = process.env.CHROME_BIN;
if (!dolt || !chrome) { console.log('SKIPPED: DOLT_BIN and CHROME_BIN are required'); process.exit(0); }
const dir = mkdtempSync(join(tmpdir(), 'iam-ui-')), home = join(dir, 'h'), data = join(dir, 'd');
mkdirSync(home); mkdirSync(data);
const env = { ...process.env, HOME: home };
for (const [k, v] of [['user.name', 'poc'], ['user.email', 'poc@example.invalid']]) spawnSync(dolt, ['config', '--global', '--add', k, v], { env });
assert.equal(spawnSync(dolt, ['sql'], { cwd: data, env, input: readFileSync(join(root, 'data/demo/01-schema.sql')) }).status, 0);
const procs = [];
// Each child starts in its OWN process group (detached) so the whole tree (npx -> ng serve, node, ...) can be stopped by group, never by a name pattern.
const run = (cmd, args, opts) => procs.push(spawn(cmd, args, { stdio: 'ignore', detached: true, ...opts }));
const portOpen = (port) => new Promise((ok) => { const c = connect(port, '127.0.0.1'); c.once('connect', () => { c.destroy(); ok(true); }); c.once('error', () => ok(false)); });
// Descendants of the children we started, snapshotted BEFORE stopping anything (`ng serve` moves its server into its own session, so a group kill alone misses it).
const descendants = (roots) => {
  const rows = spawnSync('ps', ['-e', '-o', 'pid=,ppid=']).stdout.toString().trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
  const kids = new Map(); for (const [pid, ppid] of rows) kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
  const out = []; const walk = (pid) => { for (const k of kids.get(pid) ?? []) { walk(k); out.push(k); } }; roots.forEach(walk);
  return out; // leaves first
};
const stopAll = async () => {
  const tree = descendants(procs.map((p) => p.pid));
  for (const pid of tree) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  for (const p of procs) { try { process.kill(-p.pid, 'SIGTERM'); } catch { /* already gone */ } }
  for (let i = 0; i < 40 && ((await portOpen(4200)) || (await portOpen(8081)) || (await portOpen(3000)) || (await portOpen(3307))); i++) {
    if (i === 20) { for (const pid of tree) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL'); } catch { /* gone */ } } }
    await new Promise((r) => setTimeout(r, 250));
  }
  for (const port of [4200, 8081, 3000, 3307]) if (await portOpen(port)) console.log('WARNING: port ' + port + ' still in use after cleanup');
};
run(dolt, ['sql-server', '--host', '127.0.0.1', '--port', '3307', '--data-dir', data], { cwd: data, env });
const GATE = {IAM_CORE_ADMIN_TOKEN:'local-core-token-demo', IAM_AUTH_GATE_ADDR: '127.0.0.1:3000', IAM_AUTH_GATE_TOKEN: 'local-gate-token-demo' }; // sign-in goes through the plugin gate (API on :3000)
const ADMIN_TOKEN = 'local-demo-plugin-admin-token';
const NATS = process.env.NATS_SERVER_BIN ?? process.env.NATS_BIN;
assert.ok(NATS, 'NATS_SERVER_BIN is required');
run(NATS, ['-c', join(root, 'conf/nats-local.conf')]);
await new Promise(r => setTimeout(r, 1000));
Object.assign(GATE, { IAM_CORE_NATS_URL: '127.0.0.1:4222', IAM_CORE_NATS_PASSWORD: 'core-dev' });
const startCore=()=>{run(join(root,'core/target/debug/iam-core'),[],{cwd:join(root,'core'),env:{...process.env,...GATE,IAM_CORE_STATE_DIR:join(dir,'core-state')}});return procs.at(-1);};let core=startCore();
run('node', ['dist/main.js'], { cwd: join(root, 'apps/api'), env: { ...process.env, IAM_BUS_NATS_URL:'127.0.0.1:4222',IAM_BUS_NATS_USER:'api-host',IAM_BUS_NATS_PASSWORD:'api-host-dev',IAM_CORE_ADMIN_TOKEN:GATE.IAM_CORE_ADMIN_TOKEN,IAM_WORKSPACE_MODE:'1',IAM_PLUGIN_STORE:'dolt', IAM_DIRECTORY_AUTH:'1', IAM_CREDENTIAL_FILE:join(dir,'credentials.json'), IAM_CORE_URL: 'http://127.0.0.1:8081', IAM_ISSUER: 'http://127.0.0.1:8081', IAM_AUTH_GATE_TOKEN: GATE.IAM_AUTH_GATE_TOKEN, IAM_API_ADMIN_TOKEN: ADMIN_TOKEN } });
run('npx', ['ng', 'serve', '--host', '127.0.0.1', '--port', '4200'], { cwd: join(root, 'apps/web') });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser, page;
try {
 for(let i=0;i<120;i++){try{if((await fetch('http://127.0.0.1:4200/api/health')).ok)break;}catch{}await sleep(500);}
 browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox','--host-resolver-rules=MAP localhost 127.0.0.1, MAP *picsum.photos ~NOTFOUND']});page=await browser.newPage({viewport:{width:1440,height:1050}});page.on('dialog',d=>d.accept());
 const BASE='http://localhost:4200';
 const login=async(id='demo-alice',pw='demo-only-not-a-secret',success=true)=>{await page.goto(BASE+'/login');await page.click('#signin-browser');await page.fill('[name=username]',id);await page.fill('[name=password]',pw);await page.click('button[type=submit]');if(success){await page.waitForSelector('[name=globalBranch]');await page.locator('details.token').evaluate(e=>e.open=true);await page.fill('[name=admintoken]',ADMIN_TOKEN);await openManage(page); await page.getByRole('button',{name:'Refresh branches',exact:true}).click();}else await page.getByText('Wrong user or password.').waitFor();};
 const nav=async(path)=>{if(await page.locator('.burger').isVisible())await page.locator('.burger').click();await page.locator(`nav a[data-nav="${path}"]`).click();};
 const createBranch=async(name)=>{await openManage(page); await page.fill('[name=workspaceNewBranch]',name);await page.getByRole('button',{name:'Create & select',exact:true}).click();await page.waitForFunction(n=>document.querySelector('[name=globalBranch]')?.value===n,name);await page.waitForTimeout(150);};
 const verifier='dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
 const auth=await(await fetch(BASE+'/core/authorize',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_id:'demo-web',redirect_uri:BASE+'/callback',code_challenge:'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',username:'demo-alice',password:'demo-only-not-a-secret'})})).json();
 const tok=await(await fetch(BASE+'/core/token',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:auth.code,code_verifier:verifier,client_id:'demo-web',redirect_uri:BASE+'/callback'})})).json();
 const call=(method,path,body,branch,admin=true)=>fetch('http://127.0.0.1:3000/tenants/acme-demo'+path,{method,headers:{'content-type':'application/json',authorization:'Bearer '+tok.id_token,...(branch?{'x-iam-branch':branch}:{}),...(admin?{'x-api-admin-token':ADMIN_TOKEN}:{})},body:body?JSON.stringify(body):undefined});
 assert.equal((await call('GET','/users')).status,400,'branch required server-side');
 assert.equal((await call('POST','/users',{id:'nope',password:'fictional-password'},'main')).status,403,'main immutable');
 assert.equal((await call('POST','/changes/anything/merge',{},'main')).status,403,'legacy merge blocked');
 assert.equal((await call('POST','/activations',{},'main')).status,403,'legacy publish blocked');
 assert.equal((await call('POST','/activation-workflows',{},'main')).status,403,'workflow publish blocked');
 assert.equal((await call('POST','/workspace/apply',{confirm:true},'main')).status,403,'cannot apply main');
 assert.equal((await call('POST','/versioning/branches',{name:'sod-test',from:'main'},'main')).status,201);
 assert.equal((await call('POST','/workspace/assignment',{identity:'demo-bob',role:'payment-approver'},'sod-test')).status,201);
 const sod=await call('POST','/workspace/apply',{confirm:true},'sod-test');assert.equal(sod.status,409,'SoD blocks Apply');
 assert.equal((await call('POST','/versioning/branches',{name:'conflict-a',from:'main'},'main')).status,201);
 assert.equal((await call('POST','/versioning/branches',{name:'conflict-b',from:'main'},'main')).status,201);
 assert.equal((await call('PUT','/users/demo-bob',{display_name:'Conflict A'},'conflict-a')).status,200);
 assert.equal((await call('PUT','/users/demo-bob',{display_name:'Conflict B'},'conflict-b')).status,200);
 assert.equal((await call('POST','/workspace/apply',{confirm:true},'conflict-a')).status,201);
 assert.equal((await call('POST','/workspace/apply',{confirm:true},'conflict-b')).status,409,'conflicting Apply refused');
 const mainUsers=await(await call('GET','/users',undefined,'main')).json();assert.equal(mainUsers.users.find(x=>x.id==='demo-bob').display_name,'Conflict A');
 const asg=await(await call('GET','/assignments',undefined,'main')).json();assert.equal(asg.some(x=>x.identity_id==='demo-bob'&&x.role_id==='payment-approver'),false,'main unchanged after refused Apply');
 assert.equal((await call('POST','/versioning/sql',{ref:'sod-test',mode:'write',sql:'delete from plugin_runtime_state'},'sod-test')).status,400,'runtime state cannot bypass plugin admin');
 assert.equal((await call('POST','/versioning/tables/roles/edit',{branch:'sod-test',ops:[{op:'insert',values:{id:'bad',label:'bad'}}]},'other-selected')).status,403,'cannot write a branch different from globally selected');

 assert.equal((await call('POST','/versioning/branches',{name:'connector-work',from:'main'},'main')).status,201);
 const csv='identity_id,display_name,manager_id,department,role_id\ndemo-import,Imported,,Test,payment-approver';
 const csvResult=await call('POST','/connectors/csv',{csv},'connector-work');assert.equal(csvResult.status,201,await csvResult.text());
 const scimResult=await call('POST','/connectors/scim',{Resources:[{userName:'demo-scim',displayName:'SCIM Person',roles:[{value:'payment-approver'}]}]},'connector-work');assert.equal(scimResult.status,201,await scimResult.text());
 const mainBeforeImport=await(await call('GET','/users',undefined,'main')).json();assert.ok(!mainBeforeImport.users.some(x=>['demo-import','demo-scim'].includes(x.id)),'connectors isolated from main');
 assert.equal((await call('POST','/versioning/branches',{name:'permission-work',from:'main'},'main')).status,201);
 const decide=()=>fetch('http://127.0.0.1:3000/access/check',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+tok.id_token},body:JSON.stringify({action:'Action::"approve"',resource:'Request::"test"'})}).then(x=>x.json());
 // Baseline live snapshot from first successful Apply denies Alice, who has no approver role.
 assert.equal((await decide()).allow,false,'baseline permission denied');
 assert.equal((await call('POST','/workspace/assignment',{identity:'demo-alice',role:'payment-approver'},'permission-work')).status,201);
 assert.equal((await decide()).allow,false,'branch assignment does not change live permission');
 const permissionApply=await call('POST','/workspace/apply',{confirm:true},'permission-work');const permissionOut=await permissionApply.json();assert.equal(permissionOut.applied,true,JSON.stringify(permissionOut));assert.equal(permissionOut.activation.state,'applied');
 const liveAfter=await decide();console.log('PERMISSION',JSON.stringify({liveAfter,permissionOut}));assert.equal(liveAfter.allow,true,'Apply publishes actual Rust role permission');
 assert.equal((await call('POST','/versioning/branches',{name:'retry-work',from:'main'},'main')).status,201);
 assert.equal((await call('PUT','/users/demo-bob',{department:'Retry Test'},'retry-work')).status,200);
 process.kill(-core.pid,'SIGTERM');await new Promise(r=>core.once('exit',r));
 const partial=await(await call('POST','/workspace/apply',{confirm:true},'retry-work')).json();assert.equal(partial.merged,true);assert.equal(partial.applied,false);assert.equal(partial.retryRequired,true);
 core=startCore();for(let i=0;i<50;i++){try{if((await fetch('http://127.0.0.1:8081/jwks.json')).ok)break;}catch{}await sleep(100);}
 // New IdP signing key: acquire a fresh token. The API must accept its refreshed JWKS.
 const newAuth=await(await fetch(BASE+'/core/authorize',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_id:'demo-web',redirect_uri:BASE+'/callback',code_challenge:'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',username:'demo-alice',password:'demo-only-not-a-secret'})})).json();
 const newTok=await(await fetch(BASE+'/core/token',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:newAuth.code,code_verifier:verifier,client_id:'demo-web',redirect_uri:BASE+'/callback'})})).json();tok.id_token=newTok.id_token;
 const retried=await(await call('POST','/workspace/apply',{confirm:true},'retry-work')).json();assert.equal(retried.applied,true,JSON.stringify(retried));assert.equal(retried.commit,partial.commit,'retry reuses merged commit');assert.equal(retried.activation.state,'applied');

 await login();await page.waitForFunction(()=>document.querySelector('[name=globalBranch]')?.value==='demo-alice');await openManage(page);assert.equal(await page.inputValue('[name=personalBranchName]'),'demo-alice');await openManage(page); await page.fill('[name=personalBranchName]','work-alpha');await page.click('#rename-personal');await page.waitForFunction(()=>document.querySelector('[name=globalBranch]')?.value==='work-alpha');await nav('/users');await page.waitForSelector('#users-table');
 await page.getByRole('button',{name:'Create user',exact:true}).click();await page.fill('[name=uid]','demo-charlie');await page.fill('[name=displayName]','Charlie Staged');await page.fill('[name=userPassword]','fictional-charlie-only');await page.click('#user-save');await page.waitForFunction(()=>document.querySelector('#users-table')?.textContent.includes('demo-charlie'));
 await page.selectOption('[name=globalBranch]','main');await page.waitForSelector('#users-table');assert.doesNotMatch(await page.textContent('#users-table'),/demo-charlie/);
 await page.selectOption('[name=globalBranch]','work-alpha');await nav('/plugins');await page.locator('[data-plugin="org-manager"] button').click();await page.waitForSelector('#plugin-form');await page.check('[name=gi]');await page.click('#plugin-install');await page.waitForSelector('#plugin-enable');await page.click('#plugin-enable');await page.waitForSelector('#plugin-disable');
 await page.selectOption('[name=globalBranch]','main');await page.locator('[data-plugin="org-manager"] button').click();await page.waitForSelector('#plugin-install');
 await page.getByRole('button',{name:'Sign out',exact:true}).click();await login('demo-charlie','fictional-charlie-only',false);await login();await page.selectOption('[name=globalBranch]','work-alpha');await page.click('#review-apply');await page.waitForSelector('#workspace-apply');await page.screenshot({path:join(out,'review-desktop.png')});const stale=await call('POST','/workspace/apply',{confirm:true,expectedHead:'stale'},'work-alpha');assert.equal(stale.status,409);await page.click('#workspace-apply');await page.locator('app-apply-dialog dialog[open]').getByRole('button',{name:'Apply to main',exact:true}).click();await page.waitForFunction(()=>document.body.textContent.includes('Applied work-alpha into main:'));
 await page.getByRole('button',{name:'Sign out',exact:true}).click();await login('demo-charlie','fictional-charlie-only');await page.selectOption('[name=globalBranch]','main');await nav('/plugins');await page.locator('[data-plugin="org-manager"] button').click();await page.waitForSelector('#plugin-disable');
 await createBranch('work-beta');await nav('/users');await page.locator('#users-table tr').filter({hasText:'demo-charlie'}).getByRole('button',{name:'Edit',exact:true}).click();await page.fill('[name=displayName]','Charlie Beta');await page.fill('[name=userPassword]','fictional-new-password');await page.click('#user-save');await page.waitForSelector('#user-editor',{state:'detached'});
 await page.getByRole('button',{name:'Sign out',exact:true}).click();await login('demo-charlie','fictional-charlie-only');await page.selectOption('[name=globalBranch]','work-beta');await nav('/users');await page.waitForFunction(()=>document.querySelector('#users-table')?.textContent.includes('Charlie Beta'));await page.setViewportSize({width:390,height:844});await page.waitForTimeout(250);await page.screenshot({path:join(out,'workspace-mobile.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.setViewportSize({width:1440,height:1050});await page.click('#review-apply');await page.click('#workspace-apply');await page.locator('app-apply-dialog dialog[open]').getByRole('button',{name:'Apply to main',exact:true}).click();await page.waitForFunction(()=>document.body.textContent.includes('Applied work-beta into main:'));await page.getByRole('button',{name:'Sign out',exact:true}).click();await login('demo-charlie','fictional-charlie-only',false);await login('demo-charlie','fictional-new-password');
 console.log('PASS workspace: global branch required; user and plugin branch edits absent from main; pre-Apply login denied; explicit Apply publishes user/plugin; staged password rotation does not change live auth until Apply; then old password denied; mobile no overflow.');
}catch(e){await page?.screenshot?.({path:join(out,'failure.png'),fullPage:true}).catch(()=>{});throw e;}finally{await browser?.close();await stopAll();rmSync(dir,{recursive:true,force:true});}
