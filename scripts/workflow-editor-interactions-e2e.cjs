// Real Angular UI, local API fixtures. No live data, connector calls, credentials or workflow runs.
const {chromium}=require('playwright-core');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../apps/web/dist/web/browser'),out=path.resolve(process.argv[2]||'/tmp/workflow-editor-interactions');fs.mkdirSync(out,{recursive:true});
const server=http.createServer((req,res)=>{let f=path.join(root,req.url.split('?')[0]);if(!path.extname(f))f=path.join(root,'index.csr.html');if(!fs.existsSync(f)){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',f.endsWith('.js')?'text/javascript':f.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(f));});
const def=(id)=>({id,name:id==='one'?'First workflow':'Second workflow',description:'Local fixture',active:false,tags:[],trigger:{event:'user.created'},graph:{nodes:Array.from({length:id==='one'?12:2},(_,i)=>({id:'step'+i,name:'Step '+i,type:'notify',config:{recipient:'demo',message:'Fixture only'}})),edges:Array.from({length:id==='one'?11:1},(_,i)=>({from:'step'+i,to:'step'+(i+1)}))}});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',args:['--no-sandbox']});try{
for(const mobile of [false,true])for(const theme of ['light','dark']){
const page=await browser.newPage({viewport:{width:mobile?390:1440,height:mobile?844:1050}}),errors=[],writes=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{localStorage.setItem('wf-workbench-tabs',JSON.stringify([{kind:'workflow',id:'one',label:'First workflow'},{kind:'workflow',id:'two',label:'Second workflow'}]));});
await page.route('**/session/bootstrap',route=>route.fulfill({json:{id_token:'x.'+Buffer.from(JSON.stringify({sub:'demo-alice',tenant:'acme-demo',exp:Date.now()/1000+3600})).toString('base64url')+'.x'}}));
await page.route('**/api/**',async route=>{const p=new URL(route.request().url()).pathname;let j={};if(route.request().method()!=='GET'&&!p.endsWith('/workspace/personal'))writes.push(p);
if(p.endsWith('/me/access'))j={admin:true,restricted:false,plugins:{},screenAccess:false};
else if(p.endsWith('/auth/me/admin-assurance'))j={ok:true,requiredLevel:0,currentLevel:0};
else if(p.endsWith('/workspace/personal'))j={branch:'personal/demo-alice',status:'reused'};
else if(p.endsWith('/workspace'))j={diff:{rows:{total:0},tables:[]}};
else if(p.endsWith('/versioning/branches'))j={branches:[{name:'main'},{name:'personal/demo-alice'}]};
else if(p.endsWith('/plugins/menu'))j={entries:[]};
else if(p.endsWith('/plugins'))j={plugins:[{id:'workflows-iga',enabled:true}]};
else if(p.endsWith('/workflow-blocks'))j={blocks:[{type:'notify',label:'Notify',family:'Core',simulated:true,category:'simulated',provider:'workflows-iga',providerActive:true,fields:[]}]};
else if(p.endsWith('/workflows-events'))j={events:[{type:'user.created',label:'User created',payload:['subject']}]};
else if(/\/workflows\/(one|two)$/.test(p))j={definition:def(p.endsWith('/one')?'one':'two')};
else if(p.endsWith('/workflow-connections'))j={connections:[]};
else if(p.includes('branding')){await route.fulfill({status:404,json:{}});return;}
await route.fulfill({json:j});});
await page.goto(origin+'/workflows/edit/one');await page.getByRole('button',{name:'Configure start trigger',exact:true}).waitFor();await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
await page.waitForFunction(()=>{const e=document.querySelector('.wf-trigger')?.getBoundingClientRect();return e&&e.top>150&&e.bottom<innerHeight-80});const triggerBox=await page.getByRole('button',{name:'Configure start trigger',exact:true}).boundingBox();await page.mouse.click(triggerBox.x+triggerBox.width/2,triggerBox.y+triggerBox.height/2);await page.getByRole('heading',{name:'Start trigger',exact:true}).waitFor();
assert.equal(await page.locator('select[name=wfTrigger]').inputValue(),'user.created');
await page.getByRole('button',{name:'Done',exact:true}).click();if(mobile)await page.getByRole('button',{name:'Back to canvas',exact:true}).click();
const positions=await page.evaluate(()=>{const e=ng.getComponent(document.querySelector('app-workflow-edit'));return e.vfNodes().map(n=>n.point());});
assert.equal(new Set(positions.map(p=>p.x)).size,mobile?1:3);assert.ok(new Set(positions.map(p=>p.y)).size>=4,'long chain wraps');
await page.screenshot({path:path.join(out,`${mobile?'mobile':'desktop'}-${theme}-wrapped.png`),fullPage:true});
await page.getByRole('textbox',{name:'Workflow name',exact:true}).fill('Unsaved first draft');
await page.getByRole('tab',{name:'Second workflow Close Second workflow',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.wb-name')?.value==='Second workflow');
assert.equal(new URL(page.url()).pathname,'/workflows/edit/two');assert.equal(await page.locator('.wf-node:not(.wf-trigger)').count(),2);
await page.getByRole('tab',{name:'First workflow Close First workflow',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.wb-name')?.value==='Unsaved first draft');
await page.getByRole('button',{name:'Configure start trigger',exact:true}).focus();await page.keyboard.press('Enter');await page.getByRole('heading',{name:'Start trigger',exact:true}).waitFor();
await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
await page.screenshot({path:path.join(out,`${mobile?'mobile':'desktop'}-${theme}-trigger.png`),fullPage:true});
assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);console.log('PASS',mobile?'mobile':'desktop',theme,'trigger pointer/keyboard, wrapped layout, tab navigation and graph identity, no writes');await page.close();
}
}finally{await browser.close();await new Promise(r=>server.close(r));}})().catch(e=>{console.error(e);process.exit(1)});
