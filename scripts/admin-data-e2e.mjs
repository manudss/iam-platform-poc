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
const GATE = { IAM_AUTH_GATE_ADDR: '127.0.0.1:3000', IAM_AUTH_GATE_TOKEN: 'local-gate-token-demo' }; // sign-in goes through the plugin gate (API on :3000)
const ADMIN_TOKEN = 'local-demo-plugin-admin-token';
run(join(root, 'core/target/debug/iam-core'), [], { cwd: join(root, 'core'), env: { ...process.env, ...GATE } });
run('node', ['dist/main.js'], { cwd: join(root, 'apps/api'), env: { ...process.env, IAM_PLUGIN_STORE:'dolt', IAM_DIRECTORY_AUTH:'1', IAM_CREDENTIAL_FILE:join(dir,'credentials.json'), IAM_CORE_URL: 'http://127.0.0.1:8081', IAM_ISSUER: 'http://127.0.0.1:8081', IAM_AUTH_GATE_TOKEN: GATE.IAM_AUTH_GATE_TOKEN, IAM_API_ADMIN_TOKEN: ADMIN_TOKEN } });
run('npx', ['ng', 'serve', '--host', '127.0.0.1', '--port', '4200'], { cwd: join(root, 'apps/web') });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser;
try {
  for(let i=0;i<120;i++){try{if((await fetch('http://127.0.0.1:4200/api/health')).ok)break;}catch{}await sleep(500);}
  browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox','--host-resolver-rules=MAP localhost 127.0.0.1, MAP *picsum.photos ~NOTFOUND']});
  const page=await browser.newPage({viewport:{width:1440,height:1050}}); const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  const BASE='http://localhost:4200';
  const verifier='dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const a=await fetch(BASE+'/core/authorize',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_id:'demo-web',redirect_uri:BASE+'/callback',code_challenge:'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',username:'demo-alice',password:'demo-only-not-a-secret'})});assert.equal(a.status,200);
  const {code}=await a.json();const tok=await(await fetch(BASE+'/core/token',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code,code_verifier:verifier,client_id:'demo-web',redirect_uri:BASE+'/callback'})})).json();
  const call=(method,path,body,auth=true,admin=true)=>fetch('http://127.0.0.1:3000/tenants/acme-demo'+path,{method,headers:{'content-type':'application/json',...(auth?{authorization:'Bearer '+tok.id_token}:{}),...(admin?{'x-api-admin-token':ADMIN_TOKEN}:{})},body:body?JSON.stringify(body):undefined});
  assert.equal((await call('GET','/users',undefined,false)).status,401);assert.equal((await call('GET','/users',undefined,true,false)).status,403);
  assert.equal((await call('POST','/users',{id:'invalid',password:'short'})).status,400);
  const secretSql=await call('POST','/versioning/sql',{ref:'main',sql:'select * from mysql.user'});assert.equal(secretSql.status,400);
  assert.equal((await call('POST','/versioning/branches',{name:'guarded-test',from:'main'})).status,201);
  assert.equal((await call('POST','/versioning/sql',{ref:'guarded-test',mode:'write',sql:'delete from plugin_runtime_state',confirmDestructive:true})).status,400);

  const login=async(id='demo-alice',pw='demo-only-not-a-secret')=>{await page.goto(BASE+'/login');await page.click('#signin-browser');await page.waitForSelector('input[name=username]');await page.fill('input[name=username]',id);await page.fill('input[name=password]',pw);await page.click('button[type=submit]');await page.waitForSelector('details.token');await page.locator('details.token').evaluate(e=>e.open=true);await page.fill('[name=admintoken]',ADMIN_TOKEN);};
  const nav=async(path)=>{await page.locator(`nav a[data-nav="${path}"]`).click();};
  await login();await nav('/users');await page.waitForSelector('#users-table');
  await page.getByRole('button',{name:'Create user',exact:true}).click();await page.screenshot({path:join(out,'user-editor-desktop.png'),fullPage:true});await page.fill('[name=uid]','demo-charlie');await page.fill('[name=displayName]','Charlie Demo');await page.fill('[name=department]','engineering');await page.fill('[name=userPassword]','fictional-charlie-only');await page.click('#user-save');await page.waitForSelector('#user-editor',{state:'detached'});assert.match(await page.textContent('#users-table'),/demo-charlie/);
  await page.locator('#users-table tr').filter({hasText:'demo-charlie'}).getByRole('button',{name:'Edit',exact:true}).click();await page.fill('[name=displayName]','Charlie Updated');await page.click('#user-save');await page.waitForSelector('#user-editor',{state:'detached'});await page.waitForFunction(()=>document.querySelector('#users-table')?.textContent.includes('Charlie Updated'));assert.match(await page.textContent('#users-table'),/Charlie Updated/);await page.screenshot({path:join(out,'users-desktop.png'),fullPage:true});
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await login('demo-charlie','fictional-charlie-only');await nav('/users');await page.waitForFunction(()=>document.querySelector('#users-table')?.textContent.includes('Charlie Updated'));assert.match(await page.textContent('#users-table'),/Charlie Updated/);
  await nav('/plugins');await page.locator('[data-plugin="org-manager"] button').click();
  await page.check('[name=gi]');await page.click('#plugin-install');await page.waitForSelector('#plugin-enable');await page.click('#plugin-enable');await page.waitForSelector('#plugin-disable');await page.fill('[data-field="maxDepth"] input','8');await page.click('#plugin-save');await page.waitForFunction(()=>document.querySelector('#plugin-note')?.textContent.includes('Settings saved'));
  await nav('/database/data');await page.getByRole('button',{name:'plugin_runtime_state',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.data-grid')?.textContent.includes('org-manager'));assert.match(await page.textContent('.data-grid'),/org-manager/);await page.getByRole('button',{name:'View row',exact:true}).first().click();await page.screenshot({path:join(out,'plugins-storage-desktop.png'),fullPage:true});
  assert.equal((await call('POST','/versioning/tables/plugin_runtime_state/rows',{branch:'guarded-test',ops:[{op:'delete',key:{tenant:'acme-demo',plugin:'org-manager'}}]})).status>=400,true);
  // All fields view, typed editor, commit then re-read on a real Dolt branch.
  await nav('/database/branches');await page.selectOption('select[name=nfd]','none');await page.fill('[name=nb]','admin-table-test');await page.getByRole('button',{name:'Create branch',exact:true}).click();await page.waitForFunction(()=>document.body.textContent.includes('Branch admin-table-test created'));
  await nav('/database/data');await page.selectOption('[name=dr]','admin-table-test');await page.getByRole('button',{name:'identities',exact:true}).click();await page.waitForSelector('.data-grid');await page.locator('.data-grid tr').filter({hasText:'demo-charlie'}).getByRole('button',{name:'Edit',exact:true}).click();await page.fill('[data-edit-field="display_name"] textarea','Charlie Branch');await page.evaluate(()=>window.scrollTo(0,0));await page.waitForTimeout(250);await page.screenshot({path:join(out,'field-editor-viewport-top.png')});await page.locator('.field-editor').scrollIntoViewIfNeeded();await page.waitForTimeout(250);await page.screenshot({path:join(out,'field-editor-viewport-scroll.png')});await page.getByRole('button',{name:'Commit change',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.data-grid')?.textContent.includes('Charlie Branch'));
  await page.locator('.data-grid tr').filter({hasText:'demo-charlie'}).getByRole('button',{name:'View row',exact:true}).click();await page.screenshot({path:join(out,'table-detail-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.waitForFunction(()=>getComputedStyle(document.querySelector('aside')).position==='fixed');await page.waitForTimeout(250);await page.screenshot({path:join(out,'table-detail-mobile.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no mobile horizontal page overflow');
  // Persisted state is reloaded by a fresh registry after API restart, same real Dolt and credential file.
  const api=procs[2];process.kill(-api.pid,'SIGTERM');await new Promise(r=>api.once('exit',r));
  run('node',['dist/main.js'],{cwd:join(root,'apps/api'),env:{...process.env,IAM_PLUGIN_STORE:'dolt',IAM_DIRECTORY_AUTH:'1',IAM_CREDENTIAL_FILE:join(dir,'credentials.json'),IAM_CORE_URL:'http://127.0.0.1:8081',IAM_ISSUER:'http://127.0.0.1:8081',IAM_AUTH_GATE_TOKEN:GATE.IAM_AUTH_GATE_TOKEN,IAM_API_ADMIN_TOKEN:ADMIN_TOKEN}});
  for(let i=0;i<60;i++){try{if((await fetch('http://127.0.0.1:3000/health')).ok)break;}catch{}await sleep(250);}
  await page.setViewportSize({width:1440,height:1050});await page.reload();await page.waitForURL(/\/login/);await login('demo-charlie','fictional-charlie-only');await nav('/plugins');await page.locator('[data-plugin="org-manager"] button').click();await page.waitForSelector('#plugin-disable');assert.equal(await page.inputValue('[data-field="maxDepth"] input'),'8');
  await nav('/users');await page.locator('#users-table tr').filter({hasText:'demo-charlie'}).getByRole('button',{name:'Edit',exact:true}).click();await page.uncheck('[name=enabled]');await page.click('#user-save');await page.waitForSelector('#user-editor',{state:'detached'});await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.click('#signin-browser');await page.fill('[name=username]','demo-charlie');await page.fill('[name=password]','fictional-charlie-only');await page.click('button[type=submit]');await page.getByText('Wrong user or password.').waitFor();
  assert.deepEqual(errors,[]);console.log('PASS: directory create/update/login/disable; Dolt row field editor and read-back; plugin install/enable/settings persisted in DB and reloaded after API restart; desktop/mobile screenshots; no browser errors.');
}finally{await browser?.close();await stopAll();rmSync(dir,{recursive:true,force:true});}
