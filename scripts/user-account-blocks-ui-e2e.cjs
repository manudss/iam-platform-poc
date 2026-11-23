// Built Angular UI with isolated fictional API responses. No live account, host or external service is changed.
const {chromium}=require('playwright-core');
const {pathToFileURL}=require('node:url');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../apps/web/dist/web/browser'),out=path.resolve(process.argv[2]||'/tmp/user-account-block-shots');fs.mkdirSync(out,{recursive:true});
const server=http.createServer((req,res)=>{let f=path.join(root,req.url.split('?')[0]);if(!path.extname(f))f=path.join(root,'index.csr.html');if(!fs.existsSync(f))f=path.join(root,'index.html');res.setHeader('Content-Type',{'.js':'text/javascript','.css':'text/css','.html':'text/html'}[path.extname(f)]||'application/octet-stream');res.end(fs.readFileSync(f));});
const users=['alice','bob','claire','draft'].map(id=>({id,display_name:id[0].toUpperCase()+id.slice(1)+' Example',department:'Fictional',email:id+'@example.invalid',manager_id:null,login_enabled:true,hasCredential:true}));
const labels={suspended:'Account suspended',disabled:'Account disabled',locked:'Account locked after too many failed attempts',pending_approval:'Account waiting for approval',pending_verification:'E-mail address not verified yet'};
(async()=>{const {generateTheme,themeCss}=await import(pathToFileURL(path.resolve(__dirname,'../apps/api/dist/branding/theme-engine.js')).href);const alternateCss=themeCss(generateTheme({primary:'#00695c',accent:'#4db6ac'}),{baseline:'',footer:''});await new Promise(r=>server.listen(14218,'127.0.0.1',r));const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome-stable',args:['--no-sandbox']});
try{for(const mobile of [false,true])for(const dark of [false,true]){
 const page=await browser.newPage({viewport:{width:mobile?390:1440,height:mobile?844:1100}}),errors=[],writes=[];
 page.on('pageerror',e=>errors.push(e.message));
 const stamp=Date.now();const block=(id,kind,extra={})=>({id,kind,message:'Fictional review: contact the administrator.',origin:'workflow',setBy:'fictional-onboarding',setAt:stamp-3600000,reference:'BLK-'+id,...extra});
 let blocks={alice:[block('a','suspended',{hold:true}),block('b','pending_approval',{hold:true})],bob:[block('c','locked',{until:stamp-1})],claire:[]};let denyState=false,allowManage=true;
 await page.addInitScript(()=>localStorage.setItem('iam.session','x.'+btoa(JSON.stringify({sub:'fictional-admin',tenant:'acme-demo',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600}))+'.x'));
 await page.route('**/api/**',async route=>{const req=route.request(),p=new URL(req.url()).pathname,m=req.method();let j={};
 if(m!=='GET'&&!p.endsWith('/workspace/personal'))writes.push({method:m,path:p,body:req.postDataJSON()});
 if(p.includes('/branding/')&&p.endsWith('.svg')){await route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg"/>'});return;}
 if(p.endsWith('/me/access'))j=allowManage?{admin:true,restricted:false,plugins:{},screenAccess:false}:{subject:'fictional-admin',admin:true,restricted:true,plugins:{},screenAccess:true,screens:['users']};
 else if(p.endsWith('/auth/me/admin-assurance'))j={ok:true,requiredLevel:0,currentLevel:0};
 else if(p.endsWith('/workspace/personal'))j={branch:'fictional-work',status:'reused'};
 else if(p.endsWith('/workspace'))j={diff:{rows:{total:0},tables:[]}};
 else if(p.endsWith('/versioning/branches'))j={branches:[{name:'main',commit:'a',protected:true,default:true,aheadOfDefault:0,behindDefault:0},{name:'fictional-work',commit:'b',protected:false,default:false,aheadOfDefault:1,behindDefault:0}]};
 else if(p.endsWith('/plugins/menu'))j={entries:[]};else if(p.endsWith('/plugins'))j={plugins:[]};
 else if(p.endsWith('/users-pictures'))j={pictures:{}};
 else if(p.endsWith('/directory-account-status')){
  if(denyState){await route.fulfill({status:503,json:{message:'Fixture status unavailable'}});return;}
  j={asOf:Date.now(),accounts:Object.fromEntries(users.map(u=>[u.id,{published:u.id!=='draft',loginEnabled:u.id!=='claire',hasCredential:true,blocks:(blocks[u.id]||[]).map(({kind,until,hold})=>({kind,until,hold}))}]))};
 }else if(p.endsWith('/account-blocks'))j={kinds:['suspended','disabled','locked','pending_approval'],labels,messageMax:300,accounts:Object.entries(blocks).map(([subject,blocks])=>({subject,blocks}))};
 else if(/\/accounts\/[^/]+\/blocks/.test(p)){
  const match=p.match(/\/accounts\/([^/]+)\/blocks(?:\/([^/]+))?/),id=match[1];
  if(m==='DELETE'){blocks[id]=blocks[id].filter(b=>b.id!==match[2]);j={lifted:true};}
  if(m==='POST'){const b=req.postDataJSON();blocks[id]=[...(blocks[id]||[]).filter(x=>x.kind!==b.kind),block('new',b.kind,b)];j={block:blocks[id].at(-1)};}
 }else if(p.endsWith('/users'))j={users};
 else if(p.endsWith('/profile'))j={values:{},fields:[],policy:'immediate',pending:[],sections:{roles:[],organizations:[]}};
 else if(p.includes('branding')){await route.fulfill({status:404,json:{}});return;}
 await route.fulfill({json:j});});
 const shot=async n=>{if(n==='filtered')await page.getByLabel('Active block type filter').scrollIntoViewIfNeeded();await page.screenshot({path:`${out}/${mobile?'mobile':'desktop'}-${dark?'dark':'light'}-${n}.png`,fullPage:false});};
 await page.goto('http://127.0.0.1:14218/users');await page.locator('#user-open-alice').waitFor();await page.locator('td.live-account-state').first().getByText('Blocked',{exact:true}).waitFor();
 if(mobile)await page.addStyleTag({content:alternateCss});await page.evaluate(dark=>{document.documentElement.dataset.theme=dark?'dark':'light';},dark);
 assert.match(await page.locator('tr',{has:page.locator('#user-open-alice')}).innerText(),/Suspended[\s\S]*Awaiting approval/);
 assert.match(await page.locator('tr',{has:page.locator('#user-open-bob')}).innerText(),/Not blocked/);
 assert.match(await page.locator('tr',{has:page.locator('#user-open-claire')}).innerText(),/Sign-in disabled/);
 await shot('list');
 await page.getByLabel('Live block filter').selectOption('blocked');await page.getByLabel('Active block type filter').selectOption('pending_approval');assert.equal(await page.locator('#user-open-alice').count(),1);assert.equal(await page.locator('#user-open-bob').count(),0);await shot('filtered');
 await page.getByLabel('Active block type filter').selectOption('locked');assert.equal(await page.locator('#users-table tbody tr').innerText(),'No users match.');
 await page.getByLabel('Live block filter').selectOption('');await page.getByLabel('Active block type filter').selectOption('');
 await page.locator('#user-open-alice').click();await page.locator('#user-account-blocks').getByText('2 active',{exact:false}).waitFor();
 await page.locator('#user-account-blocks').scrollIntoViewIfNeeded();await shot('drawer');
 assert.equal(await page.locator('#user-account-blocks input[name=subject]').count(),0,'no ID entry');
 await page.getByRole('button',{name:'Lift this block',exact:true}).first().click();assert.equal(writes.length,0,'no write before confirmation');await page.locator('#ub-confirm').click();await page.locator('#user-account-blocks').getByText('1 active',{exact:false}).waitFor();assert.equal(blocks.alice.length,1);assert.equal(blocks.alice[0].kind,'pending_approval','other block remains');
 await page.locator('#ub-kind').selectOption('suspended');await page.locator('#ub-message').fill('Fictional admin suspension');await page.locator('#ub-hold').check();await page.locator('#ub-block').click();await page.locator('#ub-confirm').waitFor();await page.locator('#ub-confirm').scrollIntoViewIfNeeded();await shot('confirmation');await page.locator('#ub-confirm').click();await page.locator('#user-account-blocks').getByText('2 active',{exact:false}).waitFor();assert.equal(writes.filter(w=>w.method==='POST').length,1);assert(writes.every(w=>w.path.includes('/accounts/alice/blocks')));
 await page.locator('#user-editor').getByRole('button',{name:'Cancel',exact:true}).click();
 await page.locator('#branch-picker-button').click();await page.locator('.brow',{hasText:'main'}).click();await page.locator('#user-open-alice').click();await page.locator('#user-readonly-note').waitFor();await page.locator('#user-account-blocks').getByText('2 active',{exact:false}).waitFor();assert.equal(await page.locator('#user-save').count(),0);assert.equal(await page.locator('#ub-block').isEnabled(),false,'empty reason prevents submit');assert.equal(await page.locator('#ub-message').isEnabled(),true,'live security independent of branch');await shot('main');
 await page.locator('#user-editor').getByRole('button',{name:'Close',exact:true}).click();denyState=true;await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('alert').filter({hasText:'Fixture status unavailable'}).waitFor();assert.equal(await page.locator('td.live-account-state').filter({hasText:'Not blocked'}).count(),0,'failure never means unblocked');
 denyState=false;allowManage=false;await page.reload();await page.goto('http://127.0.0.1:14218/users');try{await page.locator('#user-open-alice').click({timeout:5000});}catch(e){console.error('users-only',page.url(),await page.locator('body').innerText());await shot('permission-failure');throw e;}await page.locator('.user-live-status').getByText('Blocked',{exact:true}).waitFor();assert.equal(await page.locator('#user-account-blocks').count(),0,'users-only permission sees state but not reasons or controls');assert.equal(await page.getByText('Fictional admin suspension',{exact:true}).count(),0);assert.deepEqual(errors,[]);console.log('PASS',mobile?'mobile':'desktop',dark?'dark':'light','states, multi-type filters, expiry, scoped confirmation, lift-one, branch independence, state failure');await page.close();
}}finally{await browser.close();await new Promise(r=>server.close(r));}})().catch(e=>{console.error(e);process.exitCode=1});
