// Real Angular bundle; isolated API fixtures only. Requires playwright-core via NODE_PATH.
const {chromium}=require('playwright-core');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../apps/web/dist/web/browser'),out=path.resolve(process.argv[2]||'/tmp/workflow-visual-fixes');fs.mkdirSync(out,{recursive:true});
const server=http.createServer((req,res)=>{let f=path.join(root,req.url.split('?')[0]);if(!path.extname(f))f=path.join(root,'index.csr.html');if(!fs.existsSync(f)){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',f.endsWith('.js')?'text/javascript':f.endsWith('.css')?'text/css':f.endsWith('.svg')?'image/svg+xml':'text/html');res.end(fs.readFileSync(f));});
const tags=['hr','spike','webhook','finance','onboarding','long-tag-for-overflow','review','daily'];
const def=(id,name,ts)=>({id,name,description:'Test workflow',active:true,trigger:{event:'user.created'},tags:ts,steps:2,graph:{nodes:[{id:'a',type:'notify'},{id:'b',type:'notify'}],edges:[{from:'a',to:'b'}]},stats:null,updatedAt:'2026-11-12',createdBy:'tester',simulatedSteps:2,computedSteps:0,dataSteps:0});
(async()=>{await new Promise(r=>server.listen(14211,'127.0.0.1',r));const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',args:['--no-sandbox']});try{
for(const mobile of [false,true])for(const theme of ['light','dark']){
const page=await browser.newPage({viewport:{width:mobile?390:1440,height:mobile?844:1100}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(theme=>{localStorage.setItem('iam.session','x.'+btoa(JSON.stringify({sub:'demo-alice',tenant:'acme-demo',iat:Date.now()/1000,exp:Date.now()/1000+3600}))+'.x');localStorage.setItem('iam.theme',theme);},theme);
await page.route('**/api/**',async route=>{const p=new URL(route.request().url()).pathname;let j={};
if(p.endsWith('/me/access'))j={admin:true,restricted:false,plugins:{},screenAccess:false};
else if(p.endsWith('/workspace/personal'))j={branch:'demo-alice',status:'reused'};
else if(p.endsWith('/workspace'))j={diff:{rows:{total:0},tables:[]}};
else if(p.endsWith('/versioning/branches'))j={branches:[{name:'main'},{name:'demo-alice'}]};
else if(p.endsWith('/plugins/menu'))j={entries:[]};
else if(p.endsWith('/plugins'))j={plugins:[{id:'workflows-iga',enabled:true}]};
else if(p.endsWith('/workflows'))j={definitions:[def('one','HR intake',tags),def('two','Joiner',['hr','joiner']),def('three','Leaver',['hr','leaver'])]};
else if(p.endsWith('/workflow-runs'))j={runs:[]};
else if(p.endsWith('/workflow-blocks'))j={blocks:[{type:'if',label:'If (condition)',family:'Logic',simulated:true,category:'computed',provider:'workflows-iga',providerActive:true,fields:[{key:'left',label:'Left value',type:'string'},{key:'op',label:'Operator',type:'select',options:['equals'],default:'equals'},{key:'right',label:'Right value',type:'string'}]}]};
else if(p.endsWith('/workflows-events'))j={events:[{type:'user.created',label:'User created',payload:['subject','department']}]};
else if(p.endsWith('/workflows/wf-test'))j={definition:{id:'wf-test',name:'Placeholder hover',description:'',active:false,tags:[],trigger:{event:'user.created'},graph:{nodes:[{id:'condition',name:'If (condition)',type:'if',config:{left:'',op:'equals',right:''}}],edges:[]}}};
else if(p.includes('branding')||p.includes('demo-sheet')){await route.fulfill({status:404,json:{}});return;}
await route.fulfill({json:j});});
await page.goto('http://127.0.0.1:14211/workflows');await page.locator('.wlc-card').first().waitFor();await page.waitForTimeout(100);
const row=page.locator('.wlc-card').first().locator('.tag-row');await row.getByRole('button',{name:/Show .* more tags/}).click();await row.locator('.tip').waitFor();
await page.keyboard.press('Escape');await row.locator('.tip').waitFor({state:'hidden'});
await page.mouse.move(1,1);await row.getByRole('button',{name:/Show .* more tags/}).hover();await row.locator('.tip').getByRole('button',{name:'#daily',exact:true}).hover();await row.locator('.tip').waitFor();
await page.getByRole('searchbox',{name:'Search workflows'}).click();await row.locator('.tip').waitFor({state:'hidden'});
await row.getByRole('button',{name:/Show .* more tags/}).click();await row.locator('.tip').waitFor();
const layout=await row.evaluate(e=>{const chips=[...e.querySelectorAll(':scope > button,:scope > .more > button')];return chips.map(c=>({top:c.getBoundingClientRect().top,bottom:c.getBoundingClientRect().bottom,right:c.getBoundingClientRect().right}));});assert.equal(new Set(layout.map(c=>Math.round(c.top))).size,1,'chips one row');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no overflow');
await page.screenshot({path:path.join(out,`${mobile?'mobile':'desktop'}-${theme}-tags.png`),fullPage:true});await row.locator('.tip').getByRole('button',{name:'#daily',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.wlc-card').length===1);assert.equal(await page.locator('.wlc-card').count(),1,'hidden tag still filters');
await page.goto('http://127.0.0.1:14211/workflows/edit/wf-test');await page.locator('.wf-node.computed').waitFor();await page.locator('.wf-node.computed').click();const field=page.locator('input[name=g-left]');await field.fill('');await field.focus();const chip=page.locator('.ph-chip').filter({hasText:'event.subject'}).first();await chip.hover();
const colors=await chip.evaluate(e=>({fg:getComputedStyle(e).color,bg:getComputedStyle(e).backgroundColor,text:e.textContent}));assert.notEqual(colors.fg,colors.bg);assert.ok(colors.text.includes('event.subject'));
await page.screenshot({path:path.join(out,`${mobile?'mobile':'desktop'}-${theme}-placeholder-hover.png`),fullPage:true});await chip.click();assert.equal(await field.inputValue(),'{{event.subject}}','placeholder inserted');assert.deepEqual(errors,[]);console.log('PASS',mobile?'mobile':'desktop',theme,'single row, overflow tooltip/filter, hover colors and insertion');await page.close();
}
}finally{await browser.close();await new Promise(r=>server.close(r));}})().catch(e=>{console.error(e);process.exit(1)});
