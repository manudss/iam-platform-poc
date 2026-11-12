// Real Angular bundle; isolated API fixtures only. Requires playwright-core via NODE_PATH.
const {chromium}=require('playwright-core');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../apps/web/dist/web/browser'),out=path.resolve(process.argv[2]||'/tmp/workflow-logic-ports');fs.mkdirSync(out,{recursive:true});
const server=http.createServer((req,res)=>{let f=path.join(root,req.url.split('?')[0]);if(!path.extname(f))f=path.join(root,'index.csr.html');if(!fs.existsSync(f)){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',f.endsWith('.js')?'text/javascript':f.endsWith('.css')?'text/css':f.endsWith('.svg')?'image/svg+xml':'text/html');res.end(fs.readFileSync(f));});
(async()=>{await new Promise(r=>server.listen(14211,'127.0.0.1',r));const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',args:['--no-sandbox']});try{
for(const mobile of [false,true])for(const theme of ['light','dark']){
const page=await browser.newPage({viewport:{width:mobile?390:1440,height:mobile?844:1100}});let fixtureKind='switch',saved=null;const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(theme=>{localStorage.setItem('iam.session','x.'+btoa(JSON.stringify({sub:'demo-alice',tenant:'acme-demo',iat:Date.now()/1000,exp:Date.now()/1000+3600}))+'.x');localStorage.setItem('iam.theme',theme);},theme);
await page.route('**/api/**',async route=>{const p=new URL(route.request().url()).pathname;let j={};
if(p.endsWith('/workflows/wf-test')&&route.request().method()==='PUT')saved=route.request().postDataJSON();
if(p.endsWith('/me/access'))j={admin:true,restricted:false,plugins:{},screenAccess:false};
else if(p.endsWith('/workspace/personal'))j={branch:'demo-alice',status:'reused'};
else if(p.endsWith('/workspace'))j={diff:{rows:{total:0},tables:[]}};
else if(p.endsWith('/versioning/branches'))j={branches:[{name:'main'},{name:'demo-alice'}]};
else if(p.endsWith('/plugins/menu'))j={entries:[]};
else if(p.endsWith('/plugins'))j={plugins:[{id:'workflows-iga',enabled:true}]};

else if(p.endsWith('/workflow-runs'))j={runs:[]};
else if(p.endsWith('/workflow-blocks'))j={blocks:[{type:'if',label:'If (condition)',family:'Logic',simulated:true,category:'computed',provider:'workflows-iga',providerActive:true,fields:[{key:'left',label:'Left value',type:'string'},{key:'op',label:'Operator',type:'select',options:['equals'],default:'equals'},{key:'right',label:'Right value',type:'string'}]}]};
else if(p.endsWith('/workflows-events'))j={events:[{type:'user.created',label:'User created',payload:['subject','department']}]};
else if(p.endsWith('/workflows/wf-test'))j={definition:{id:'wf-test',name:'Logic branches',description:'',active:false,tags:[],trigger:{event:'user.created'},graph:{nodes:[{id:'switch',name:'Department',type:'switch',config:{value:'{{event.department}}',cases:'HR\nIT'}},{id:'hr',name:'Provision HR',type:'notify',config:{}},{id:'it',name:'Provision IT',type:'notify',config:{}},{id:'review',name:'Request review',type:'notify',config:{}},{id:'merge',name:'Merge candidates',type:'merge',config:{}}],edges:[{from:'switch',to:'hr',label:'HR'},{from:'switch',to:'it',label:'IT'},{from:'switch',to:'review',label:'default'},{from:'hr',to:'merge'},{from:'it',to:'merge'},{from:'review',to:'merge'}]}}};
else if(p.includes('branding')||p.includes('demo-sheet')){await route.fulfill({status:404,json:{}});return;}
if(p.endsWith('/workflows/wf-test')&&fixtureKind!=='switch'){j.definition.graph.nodes[0].type=fixtureKind;j.definition.graph.nodes[0].config=fixtureKind==='if'?{left:'a',op:'equals',right:'b'}:{items:'[]',maxItems:5};j.definition.graph.edges=j.definition.graph.edges.filter(e=>e.from!=='switch'||e.label!=='default');j.definition.graph.edges.forEach(e=>{if(e.from==='switch')e.label=fixtureKind==='if'?(e.label==='HR'?'true':'false'):(e.label==='HR'?'each':'done');});}
await route.fulfill({json:j});});
await page.goto('http://127.0.0.1:14211/workflows/edit/wf-test');await page.locator('.wf-node.logic').first().waitFor();await page.waitForTimeout(500);
const sw=page.locator('app-wf-node').filter({has:page.locator('.wf-node-name',{hasText:'Department'})});
const merge=page.locator('app-wf-node').filter({has:page.locator('.wf-node-name',{hasText:'Merge candidates'})});
assert.equal(await sw.locator('.wf-outputs handle').count(),3,'3 explicit switch outputs');assert.equal(await merge.locator('.wf-inputs handle').count(),3,'3 explicit merge inputs');
assert.ok(await sw.textContent().then(t=>t.includes('Case: HR')&&t.includes('Case: IT')&&t.includes('Default')));
assert.ok(await merge.textContent().then(t=>t.includes('Provision HR')&&t.includes('Provision IT')&&t.includes('Request review')));
assert.equal(await page.locator('select.wb-edge-label').count(),0,'no permanent main-flow selectors');
await page.screenshot({path:path.join(out,`${mobile?'mobile':'desktop'}-${theme}-logic.png`),fullPage:true});
if(!mobile){await page.getByRole('combobox',{name:'Jump to step'}).selectOption('switch');await page.waitForTimeout(150);await page.screenshot({path:path.join(out,`desktop-${theme}-focused-ports.png`),fullPage:true});}
if(mobile){await sw.getByRole('button',{name:'Connect output Case: HR',exact:true}).click();await page.getByRole('button',{name:'Edit link to Provision HR',exact:true}).click();}else await page.locator('.wb-link-chip').filter({hasText:'Case: HR'}).click();await page.locator('select.wb-edge-label').selectOption('IT');
await page.waitForFunction(()=>[...document.querySelectorAll('.wb-link-chip')].filter(e=>e.textContent.includes('Case: IT')).length===2);
await page.getByRole('button',{name:'Close',exact:true}).click();await sw.getByRole('button',{name:'Connect output Case: HR',exact:true}).click();await page.getByRole('combobox',{name:'Target step',exact:true}).selectOption('hr');await page.getByRole('button',{name:'Connect',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.wb-link-chip').length===7);
await page.getByRole('combobox',{name:'Jump to step'}).selectOption('merge');await page.waitForTimeout(150);await page.screenshot({path:path.join(out,`${mobile?'mobile':'desktop'}-${theme}-merge-inputs.png`),fullPage:true});
await merge.getByRole('button',{name:'Edit input from Provision HR',exact:true}).click();await page.getByRole('button',{name:'Delete link',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.wb-link-chip').length===6);await page.keyboard.press('Control+z');await page.waitForFunction(()=>document.querySelectorAll('.wb-link-chip').length===7);assert.equal(await merge.locator('.wf-inputs handle').count(),3,'undo restores all merge inputs');
await page.getByRole('button',{name:'Save',exact:true}).click();await page.waitForTimeout(100);assert.ok(saved,'saved through the real editor client');assert.equal(saved.graph.edges.length,7);assert.ok(saved.graph.edges.every(e=>Object.keys(e).every(k=>['from','to','label'].includes(k))),'presentation handles never enter persisted schema');
for(const kind of ['if','loop']){fixtureKind=kind;await page.goto('http://127.0.0.1:14211/workflows/edit/wf-test');await page.locator('.wf-node.logic').first().waitFor();await page.waitForTimeout(100);assert.equal(await sw.locator('.wf-outputs handle').count(),2,kind+' has two typed outputs');const t=await sw.textContent();assert.ok(kind==='if'?t.includes('True')&&t.includes('False'):t.includes('Each')&&t.includes('Done'));}
assert.deepEqual(errors,[]);console.log('PASS',mobile?'mobile':'desktop',theme,'ports, provenance, link editing');await page.close();
}
}finally{await browser.close();await new Promise(r=>server.close(r));}})().catch(e=>{console.error(e);process.exit(1)});
