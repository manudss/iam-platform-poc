// Synthetic runner browser proof only. No production origin or credentials.
const fs=require('fs');
let fixedStage='browser-import',proofPage,proofOut,networkFailed=0,httpErrors=0,proofOrigin,resourceSummary={},hydrationReclicks=0;
const safeNames=new Set(['Error','TimeoutError','TypeError','ReferenceError','SyntaxError']);
function resource(request,status,failed){
 let sameOrigin=false,expectedDecorativeAbort=false;
 try{const u=new URL(request.url());sameOrigin=u.origin===proofOrigin;expectedDecorativeAbort=failed&&u.origin==='https://picsum.photos'}catch{}
 const known=new Set(['document','stylesheet','image','media','font','script','texttrack','xhr','fetch','eventsource','websocket','manifest','other']);
 const resourceType=known.has(request.resourceType())?request.resourceType():'other';
 const item={resourceType,status,sameOrigin,failed,expectedDecorativeAbort};const key=JSON.stringify(item);
 if(!resourceSummary[key])resourceSummary[key]={...item,count:0};resourceSummary[key].count++;
}
function counters(){return {networkIdleRequired:false,networkFailed,httpErrors,resources:Object.values(resourceSummary),hydrationReclicks}}
function diagnostic(error){
 let route='other';
 try{const p=new URL(proofPage.url()).pathname;route=p==='/login'?'login':(p==='/my-applications'||p==='/callback'||p.startsWith('/core/'))?'auth':'other'}catch{}
 return {fixedStage,errorClass:safeNames.has(error?.name)?error.name:'Other',cause:'synthetic-browser-step-failed',...counters(),route};
}
(async()=>{
 const [origin,out]=process.argv.slice(2);proofOut=out;proofOrigin=origin;
 if(!/^https:\/\/held-a\.localhost:18443$/.test(origin))throw Error('synthetic origin required');
 const {chromium}=require('playwright-core');fixedStage='browser-launch';
 const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',args:['--no-sandbox']});
 try{
  for(const [name,size]of Object.entries({desktop:{width:1440,height:1000},mobile:{width:390,height:844}})){
   fixedStage=name+'-context';
   const context=await browser.newContext({viewport:size});const page=await context.newPage();proofPage=page;
   page.on('requestfailed',request=>{networkFailed++;resource(request,0,true)});page.on('response',response=>{if(response.status()>=400)httpErrors++;resource(response.request(),response.status(),false)});
   // The demo's decorative image is unrelated to application usability and not needed.
   await page.route('https://picsum.photos/**',route=>route.abort());
   fixedStage=name+'-login-navigation';
   await page.goto(origin+'/login',{waitUntil:'domcontentloaded'});
   fixedStage=name+'-login-component';await page.waitForSelector('app-login');
   fixedStage=name+'-login-title';if(await page.title()!=='Sign in')throw Error('real SSR login title mismatch');
   fixedStage=name+'-methods-ready';await page.waitForFunction(()=>!document.querySelector('#signin-loading'));
   await page.screenshot({path:out+'/'+name+'-login.png',fullPage:true});
   fixedStage=name+'-method-click';const legacy=page.locator('#signin-browser');
   const method=await legacy.count()?legacy:page.getByRole('button',{name:/password/i}).first();
   await method.click();
   try{await page.waitForSelector('input[name="username"]',{timeout:5000})}catch{
    // One hydration-only re-click, before credentials or any authentication submit.
    if(!await page.locator('input[name="username"]').count()&&await method.isVisible()){
     fixedStage=name+'-method-hydration-reclick';hydrationReclicks++;await method.click();
    }else throw Error('credential form unavailable');
   }
   fixedStage=name+'-credential-form';
   await page.waitForSelector('input[name="username"]');await page.locator('input[name="username"]').fill('demo-alice');await page.locator('input[name="password"]').fill('demo-only-not-a-secret');
   fixedStage=name+'-credential-submit';await page.locator('button[type="submit"],input[type="submit"]').first().click();
   fixedStage=name+'-authenticated-route';await page.waitForURL('**/my-applications',{timeout:45000});await page.waitForFunction(()=>document.querySelector('nav')&&document.body.innerText.includes('My applications'));
   if(await page.locator('input[name="password"]').count())throw Error('authentication not complete');
   // No tokens, cookies, raw URLs, page text or request contents are exported.
   await page.screenshot({path:out+'/'+name+'-authenticated.png',fullPage:true});
   await context.close();
  }
  fs.writeFileSync(out+'/browser-proof.json',JSON.stringify({exactImageFixture:true,nativeTrustedTLS:true,desktop:true,mobile:true,authenticatedSyntheticUser:true,visualPixelInspectionPending:true,...counters()}));
 }catch(error){
  fs.writeFileSync(out+'/browser-failure-stage.json',JSON.stringify(diagnostic(error)));
  if(proofPage&&!proofPage.isClosed())await proofPage.screenshot({path:out+'/failure.png',fullPage:true}).catch(()=>{});
  throw error;
 }finally{await browser.close()}
})().catch(error=>{
 if(proofOut&&!fs.existsSync(proofOut+'/browser-failure-stage.json'))fs.writeFileSync(proofOut+'/browser-failure-stage.json',JSON.stringify(diagnostic(error)));
 console.error('fixed synthetic browser proof failure');process.exit(1);
});
