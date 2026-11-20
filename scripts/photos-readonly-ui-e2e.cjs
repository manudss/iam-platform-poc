// Real built Angular UI + isolated API fixtures (fictional people only, nothing external is contacted).
// Proves: the same photo shows in the users list and the user sheet (on a working branch AND on main), the list falls back to
// initials for a person without a photo, and on main the sheet opens read only (no Save). Desktop and mobile screenshots.
const {chromium}=require('playwright-core');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../apps/web/dist/web/browser'),out=path.resolve(process.argv[2]||'/tmp/photos-readonly-shots');fs.mkdirSync(out,{recursive:true});
const PIC='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',KEY='profile-picture.picture';
const server=http.createServer((req,res)=>{let f=path.join(root,req.url.split('?')[0]);if(!path.extname(f))f=path.join(root,'index.csr.html');if(!fs.existsSync(f))f=path.join(root,'index.html');res.setHeader('Content-Type',{'.js':'text/javascript','.css':'text/css','.html':'text/html'}[path.extname(f)]||'application/octet-stream');res.end(fs.readFileSync(f));});
const users=[{id:'demo-alice',display_name:'Alice Demo',department:'it',email:'alice@example.invalid',manager_id:null,login_enabled:true,hasCredential:true},{id:'demo-bob',display_name:'Bob Demo',department:'hr',email:'bob@example.invalid',manager_id:null,login_enabled:true,hasCredential:true}];
const fields=[{key:KEY,label:'Picture',type:'image',editable:false,visible:true,section:'Identity'}];
(async()=>{await new Promise(r=>server.listen(14212,'127.0.0.1',r));const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome-stable',args:['--no-sandbox']});
try{for(const mobile of [false,true]){
const page=await browser.newPage({viewport:{width:mobile?390:1440,height:mobile?844:1000}}),errors=[],writes=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{localStorage.setItem('iam.session','x.'+btoa(JSON.stringify({sub:'demo-alice',tenant:'acme-demo',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600}))+'.x');});
await page.route('**/api/**',async route=>{const req=route.request(),p=new URL(req.url()).pathname;let j={};
if(req.method()!=='GET'&&!p.endsWith('/workspace/personal'))writes.push(req.method()+' '+p);
if(p.includes('/branding/')&&p.endsWith('.svg')){await route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg"/>'});return;}
if(p.endsWith('/me/access'))j={admin:true,restricted:false,plugins:{},screenAccess:false};
else if(p.endsWith('/workspace/personal'))j={branch:'demo-alice',status:'reused'};
else if(p.endsWith('/workspace'))j={diff:{rows:{total:0},tables:[]}};
else if(p.endsWith('/versioning/branches'))j={branches:[{name:'main',commit:'a',protected:true,default:true,aheadOfDefault:0,behindDefault:0},{name:'demo-alice',commit:'b',protected:false,default:false,aheadOfDefault:1,behindDefault:0}]};
else if(p.endsWith('/plugins/menu'))j={entries:[]};else if(p.endsWith('/plugins'))j={plugins:[]};
else if(p.endsWith('/me/profile'))j={values:{[KEY]:PIC},fields,policy:'immediate',pending:[],sections:{roles:[],organizations:[]}};
else if(p.endsWith('/users-pictures'))j={pictures:{'demo-alice':PIC}};
else if(p.endsWith('/users/demo-alice/profile'))j={fields,values:{[KEY]:PIC},sections:{roles:[],organizations:[]}};
else if(p.endsWith('/users'))j={users};
else if(p.includes('branding')){await route.fulfill({status:404,json:{}});return;}
await route.fulfill({json:j});});
const shot=async n=>{await page.screenshot({path:`${out}/${mobile?'mobile':'desktop'}-${n}.png`,fullPage:true});};
const listCheck=async()=>{await page.locator('#user-open-demo-alice').waitFor();
 const row=page.locator('tr',{has:page.locator('#user-open-demo-alice')});await row.locator('app-avatar img').waitFor();assert.equal(await row.locator('app-avatar img').getAttribute('src'),PIC,'photo in the list');
 const bob=page.locator('tr',{has:page.locator('#user-open-demo-bob')});assert.equal(await bob.locator('app-avatar img').count(),0,'no photo, no image');assert.match(await bob.locator('app-avatar').innerText(),/BD/,'initials fallback');};
await page.goto('http://127.0.0.1:14212/users');await listCheck();await shot('users-branch');
await page.locator('#user-open-demo-alice').click();await page.locator('#user-editor').waitFor();await page.locator('#user-editor img').first().waitFor();assert.equal(await page.locator('#user-editor img').first().getAttribute('src'),PIC,'photo in the sheet (branch)');assert.equal(await page.locator('#user-save').count(),1);await shot('sheet-branch');
await page.getByRole('button',{name:'Cancel'}).click();
await page.locator('#branch-picker-button').click();await page.locator('.brow',{hasText:'main'}).click();
await page.locator('#user-open-demo-alice').waitFor();await listCheck();await shot('users-main');
await page.locator('#user-open-demo-alice').click();await page.locator('#user-editor').waitFor();await page.locator('#user-readonly-note').waitFor();await page.locator('#user-editor img').first().waitFor();assert.equal(await page.locator('#user-editor img').first().getAttribute('src'),PIC,'photo in the sheet (main)');
assert.equal(await page.locator('#user-save').count(),0,'no Save on main');assert.equal(await page.locator('#user-editor fieldset.ro-set').evaluate(e=>e.disabled),true,'fields disabled on main');await shot('sheet-main-readonly');
assert.deepEqual(writes,[],'nothing written');assert.deepEqual(errors,[]);console.log('PASS',mobile?'mobile':'desktop','photo in list and sheet, branch and main, read-only sheet on main');await page.close();
}}finally{await browser.close();await new Promise(r=>server.close(r));}})().catch(e=>{console.error(e);process.exit(1)});
