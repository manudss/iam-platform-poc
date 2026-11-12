// Real built Angular UI + isolated API fixtures. No user account or external service is contacted.
const {chromium}=require('playwright-core');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../apps/web/dist/web/browser'),out=path.resolve(process.argv[2]||'/tmp/profile-priorities-shots');fs.mkdirSync(out,{recursive:true});
const server=http.createServer((req,res)=>{let f=path.join(root,req.url.split('?')[0]);if(!path.extname(f))f=path.join(root,'index.csr.html');if(!fs.existsSync(f))f=path.join(root,'index.html');res.setHeader('Content-Type',f.endsWith('.js')?'text/javascript':f.endsWith('.css')?'text/css':f.endsWith('.svg')?'image/svg+xml':'text/html');res.end(fs.readFileSync(f));});
(async()=>{await new Promise(r=>server.listen(14211,'127.0.0.1',r));const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome-stable',args:['--no-sandbox']});try{for(const mobile of [false,true])for(const theme of ['light','dark']){
const page=await browser.newPage({viewport:{width:mobile?390:1440,height:mobile?844:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(({theme})=>{localStorage.setItem('iam.session','x.'+btoa(JSON.stringify({sub:'demo-alice',tenant:'acme-demo',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600}))+'.x');localStorage.setItem('iam.theme',theme);},{theme});
const PHOTO='profile-picture.picture',PHONE='hr-attributes.phone';let values={[PHONE]:'old phone',[PHOTO]:null},coreSaves=0,fieldSaves=0,failFields=true;
const fields=[{key:PHONE,label:'Phone',type:'phone',editable:true,visible:true,section:'Contact'},{key:PHOTO,label:'Picture',type:'image',editable:true,visible:true,section:'Identity'}];
const user={id:'alex',display_name:'Alex Demo',department:'it',email:'alex@example.invalid',manager_id:null,login_enabled:true,hasCredential:true};
const catalogue=[{fullKey:PHONE,plugin:'hr-attributes',label:'Phone',type:'phone',klass:'profile',storage:'table',section:'Contact',order:10}];
await page.route('**/api/**',async route=>{const req=route.request(),u=new URL(req.url()),p=u.pathname;let j={};
if(p.includes('/branding/')&&p.endsWith('.svg')){await route.fulfill({contentType:'image/svg+xml',body:fs.readFileSync(path.resolve(__dirname,'../apps/web/public/lyam-logo-horizontal-'+(p.includes('dark')?'dark':'light')+'.svg'),'utf8')});return;}
if(p.endsWith('/me/access'))j={admin:true,restricted:false,plugins:{},screenAccess:false};
else if(p.endsWith('/workspace/personal'))j={branch:'demo-alice',status:'reused'};
else if(p.endsWith('/workspace'))j={diff:{rows:{total:0},tables:[]}};
else if(p.endsWith('/versioning/branches'))j={branches:[{name:'main'},{name:'demo-alice'}]};
else if(p.endsWith('/plugins/menu'))j={entries:[]};else if(p.endsWith('/plugins'))j={plugins:[]};
else if(p.endsWith('/me/profile')){if(req.method()==='PATCH')values={...values,...req.postDataJSON().values};j={values,fields,policy:'review',pending:[],sections:{roles:[],organizations:[]}};}
else if(p.endsWith('/profile-components'))j={components:[]};
else if(p.endsWith('/profile-fields'))j={catalogue,working:{config:{fields:{},sections:['Contact']},settings:{}},live:{config:{}}};
else if(p.endsWith('/profile-schema'))j={fields};
else if(p.endsWith('/profile-components-inventory'))j={components:[]};
else if(p.endsWith('/auth/enrollment-stats'))j={instances:{}};
else if(p.endsWith('/signup/delivery-status'))j={mode:'real',source:'live'};
else if(p.endsWith('/signup/requests'))j={requests:[]};
else if(p.endsWith('/profile-reviews'))j={policy:'review',reviews:[{subject:'alex',changes:[{key:PHONE,label:'Phone',from:'old phone',to:'new phone'}]}]};
else if(p.endsWith('/users/alex/profile')){if(req.method()==='PATCH'){fieldSaves++;if(failFields){await route.fulfill({status:400,json:{message:'Fixture validation refused'}});return;}}j={fields:fields.filter(f=>f.key!==PHOTO),values};}
else if(p.endsWith('/users/alex')){coreSaves++;j=user;}
else if(p.endsWith('/users'))j={users:[user]};
else if(p.includes('branding')){await route.fulfill({status:404,json:{}});return;}
await route.fulfill({json:j});});
const shot=async name=>{await page.screenshot({path:`${out}/${mobile?'mobile':'desktop'}-${theme}-${name}.png`,fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow on '+name);};
await page.goto('http://127.0.0.1:14211/my-profile');await page.getByRole('textbox',{name:'Phone',exact:true}).fill('my unsaved phone');
await page.locator('input[type=file]').setInputFiles({name:'picture.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64')});
await page.locator('#mp-note').filter({hasText:'Picture change sent for validation'}).waitFor();assert.equal(await page.getByRole('textbox',{name:'Phone',exact:true}).inputValue(),'my unsaved phone');await shot('photo-preserved');
await page.goto('http://127.0.0.1:14211/profile-fields');await page.getByRole('tab',{name:'Fields',exact:true}).waitFor();await page.locator('#pf-table').waitFor();await page.locator('input[name="pf-ns"]').fill('Extra section');await page.locator('#pf-add-section').click();await page.getByRole('tab',{name:'Preview',exact:true}).click();await page.locator('#pf-preview-unsaved').waitFor();await shot('saved-preview');
await page.getByRole('tab',{name:'Publish & sign-up',exact:true}).click();await page.locator('#pf-delivery').filter({hasText:'real delivery configured'}).waitFor();await shot('live-delivery');
await page.goto('http://127.0.0.1:14211/profile-reviews');await page.getByRole('button',{name:'Accept & publish to main'}).waitFor();await shot('publication');
await page.goto('http://127.0.0.1:14211/users');await page.locator('button').filter({hasText:'Edit'}).first().click();await page.locator('#user-editor').waitFor();await page.getByLabel('Phone',{exact:true}).fill('admin draft');await page.locator('#user-save').click();await page.locator('#user-partial-save').waitFor();await shot('partial-save');assert.equal(coreSaves,1);failFields=false;await page.locator('#user-save').click();await page.locator('#user-editor').waitFor({state:'detached'});assert.equal(coreSaves,1);assert.equal(fieldSaves,2);
assert.deepEqual(errors,[]);console.log('PASS',mobile?'mobile':'desktop',theme,'photo preserve, saved preview, live notifier, publish effect, partial save + safe retry');await page.close();
}}finally{await browser.close();await new Promise(r=>server.close(r));}})().catch(e=>{console.error(e);process.exit(1)});
