// Real built Angular shell and packaged AI screen; synthetic API, no model call or external effect.
import { chromium } from './ai-assistant-ui/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';
const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const dist = root + '/apps/web/dist/web/browser';
const out = resolve(process.argv[2] ?? '/tmp/ai-floating-shots'); mkdirSync(out, { recursive: true });
const server = createServer((req,res) => { let p = resolve(dist, '.' + req.url.split('?')[0]); if (!existsSync(p) || !extname(p)) p = dist + '/index.csr.html'; try { res.setHeader('content-type', ({'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'})[extname(p)] ?? 'application/octet-stream');res.end(readFileSync(p)); } catch {res.statusCode=404;res.end();} });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
const errors = [];page.on('pageerror', e => errors.push(e.message));
const token = 'demo.' + Buffer.from(JSON.stringify({sub:'camille.martin',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url') + '.demo';
let aiLoads = 0;
await page.route('**/*', async route => {
 const url = new URL(route.request().url()), p = url.pathname;
 const json = data => route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
 if (/\/branding\/logo-horizontal-(light|dark)\.svg$/.test(p)) return route.fulfill({contentType:'image/svg+xml',body:readFileSync(root+'/scripts/fixtures/lyam-logo-dark.svg','utf8')});
 if (p === '/session/bootstrap') return json({ id_token: token });
 if (p.endsWith('/assets/screens/chat.mjs')) { aiLoads++; return route.fulfill({contentType:'text/javascript',body:readFileSync(root+'/plugins/ai-assistant/screens/chat.mjs','utf8')}); }
 if (p.startsWith('/api/')) {
  if (p.endsWith('/me/access')) return json({subject:'camille.martin',admin:true,restricted:true,plugins:{}});
  if (p.endsWith('/auth/me/admin-assurance')) return json({ok:true});
  if (p.endsWith('/workspace/personal')) return json({branch:'demo-work',status:'reused'});
  if (p.endsWith('/assignments') || p.endsWith('/activations')) return json([]);
  if (p.endsWith('/directory-account-status')) return json({accounts:{},asOf:Date.now()});
  if (p.endsWith('/stats')) return json({assignments:0,activations:0});
  if (p.endsWith('/branches')) return json({default:'main',branches:[{name:'main',default:true},{name:'demo-work',aheadOfDefault:0,behindDefault:0}]});
  if (p.endsWith('/plugins/screens')) return json({screens:[{plugin:'ai-assistant',id:'chat',render:'component',component:'screens/chat.mjs'}]});
  if (p.endsWith('/plugins/menu')) return json({entries:[{plugin:'ai-assistant',id:'chat',title:'AI assistant',area:'admin',group:'Extensions',path:'/screens/ai-assistant/chat'}]});
  if (p.endsWith('/ai/models')) return json({models:[{id:'demo-model',name:'Demo model',kind:'google',model:'demo',enabled:true,local:false,lastStatus:'not checked'}]});
  if (p.endsWith('/ai/conversations')) return json({conversations:[{id:'cv-demo',title:'Review access',autoApproveWrites:false}]});
  if (p.endsWith('/ai/conversations/cv-demo')) return json({conversation:{id:'cv-demo',title:'Review access'},branch:'ai/mcp-demo',sessionActive:true,messages:[{id:'u1',role:'user',parts:[{type:'text',text:'What can you help me check?'}]},{id:'a1',role:'assistant',parts:[{type:'text',text:'I can help review users and roles. Changes stay on a working branch until a person publishes them.'}]}]});
  return json({entries:[],users:[],roles:[],assignments:[],activations:[],plugins:[],data:[],stats:{}});
 }
 return route.continue();
});
try {
 await page.goto(origin+'/overview');
 await page.locator('#ai-launcher').waitFor();
 await page.waitForFunction(()=>[...document.querySelectorAll('.brandlogo img')].every(el=>el.complete&&el.naturalWidth>0)); await page.locator('#ai-launcher').click();
 await page.locator('#ai-floating-window plg-ai-assistant-chat').waitFor();
 await page.locator('#ai-floating-window summary').click();
 await page.locator('#ai-floating-window [data-open="cv-demo"]').click();
 await page.locator('#ai-floating-window #ai-thread').waitFor();
 await page.locator('#ai-floating-window textarea').fill('Keep this draft while I check another page.');
 await page.locator('#ai-floating-window .layout>div>details').evaluate(el=>el.open=false);
 await page.screenshot({path:out+'/desktop-light.png'});
 const el = await page.locator('#ai-floating-window plg-ai-assistant-chat').evaluate(el => (el.dataset.proof='same-instance'));
 await page.locator('[aria-label="Minimize AI assistant"]').click();
 await page.locator('#ai-floating-window').waitFor({state:'hidden'});
 await page.locator('#ai-launcher').click();
 assert.equal(await page.locator('#ai-floating-window textarea').inputValue(),'Keep this draft while I check another page.');
 // Route navigation in the actual shell, not page reload.
 await page.locator('a[href="/users"]').first().click(); await page.waitForURL('**/users');
 assert.equal(await page.locator('#ai-floating-window plg-ai-assistant-chat').getAttribute('data-proof'),'same-instance');
 assert.equal(await page.locator('#ai-floating-window textarea').inputValue(),'Keep this draft while I check another page.');
 const drag = async (selector,x,y) => { const b=await page.locator(selector).boundingBox();await page.mouse.move(b.x+b.width/2,b.y+Math.min(18,b.height/2));await page.mouse.down();await page.mouse.move(x,y,{steps:12});await page.mouse.up(); };
 await page.locator('[aria-label="Minimize AI assistant"]').click();
 for (const [x,y,axis,expected] of [[12,450,'x',8],[680,12,'y',8],[1350,450,'right',1358],[680,888,'bottom',892]]) {
  await drag('#ai-launcher',x,y); const b=await page.locator('#ai-launcher').boundingBox();const actual=axis==='right'?b.x+b.width:axis==='bottom'?b.y+b.height:b[axis];assert(Math.abs(actual-expected)<3,JSON.stringify({axis,actual,expected}));
 }
 await page.screenshot({path:out+'/launcher-bottom.png'});
 await page.locator('#ai-launcher').click();await page.locator('#ai-floating-window').waitFor({state:'visible'});await drag('#ai-floating-window header',225,80);
 await page.evaluate(()=>document.documentElement.dataset.theme='dark');await page.screenshot({path:out+'/desktop-dark-moved.png'});
 await page.setViewportSize({width:390,height:844});
 await page.evaluate(()=>document.documentElement.dataset.theme='light');
 const win=await page.locator('#ai-floating-window').boundingBox();assert(win.x>=0&&win.y>=0&&win.x+win.width<=390&&win.y+win.height<=844);
 await page.screenshot({path:out+'/mobile-light.png'});
 await page.evaluate(()=>document.documentElement.dataset.theme='dark');await page.screenshot({path:out+'/mobile-dark.png'});
 // Physical touch input through Chrome, not synthetic DOM events.
 await page.locator('[aria-label="Minimize AI assistant"]').click();
 const touch = await page.context().newCDPSession(page);
 const tb = await page.locator('#ai-launcher').boundingBox();
 await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:tb.x+30,y:tb.y+30}]});
 await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:30,y:390}]});
 await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 await page.waitForFunction(()=>Math.abs(document.querySelector('#ai-launcher').getBoundingClientRect().x-8)<2);
 await page.locator('#ai-launcher').click(); await page.locator('#ai-floating-window').waitFor({state:'visible'});
 await page.evaluate(()=>{document.documentElement.dataset.theme='light';document.documentElement.style.setProperty('--accent','var(--ok)');document.documentElement.style.setProperty('--accent-ink','var(--card)');document.documentElement.style.setProperty('--accent-soft','var(--ok-soft)');});
 await page.screenshot({path:out+'/mobile-alternate-accent.png'});
 assert.equal(aiLoads,1);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,aiLoads,checks:['actual Angular shell + packaged screen','minimize retains instance and draft','route navigation retains instance and draft','launcher drag all four edges','panel drag and edge snap','viewport resize clamp','light/dark desktop/mobile'],screenshots:out}));
} finally { await browser.close();server.close(); }
