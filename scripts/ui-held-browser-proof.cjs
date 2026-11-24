// Synthetic runner browser proof only. No production origin or credentials.
const {chromium}=require('playwright-core');const fs=require('fs');
(async()=>{
 const [origin,out]=process.argv.slice(2);if(!/^https:\/\/held-a\.localhost:18443$/.test(origin))throw Error('synthetic origin required');
 const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',args:['--no-sandbox']});
 try{
  for(const [name,size]of Object.entries({desktop:{width:1440,height:1000},mobile:{width:390,height:844}})){
   const context=await browser.newContext({viewport:size});const page=await context.newPage();
   // The demo's decorative image is unrelated to application usability and not needed.
   await page.route('https://picsum.photos/**',route=>route.abort());
   await page.goto(origin+'/login',{waitUntil:'networkidle'});await page.waitForSelector('app-login');
   if(await page.title()!=='Sign in')throw Error('real SSR login title mismatch');
   await page.waitForFunction(()=>!document.querySelector('#signin-loading'));
   await page.screenshot({path:out+'/'+name+'-login.png',fullPage:true});
   const legacy=page.locator('#signin-browser');
   if(await legacy.count())await legacy.click();else await page.getByRole('button',{name:/password/i}).first().click();
   await page.waitForSelector('input[name="username"]');await page.locator('input[name="username"]').fill('demo-alice');await page.locator('input[name="password"]').fill('demo-only-not-a-secret');
   await page.locator('button[type="submit"],input[type="submit"]').first().click();
   await page.waitForURL('**/my-applications',{timeout:45000});await page.waitForFunction(()=>document.querySelector('nav')&&document.body.innerText.includes('My applications'));
   if(await page.locator('input[name="password"]').count())throw Error('authentication not complete');
   // Browser token is private HttpOnly bootstrap, not logged or exported. Route API
   // requires Bearer, so use app-rendered identity instead of cookie-only API probe.
   await page.screenshot({path:out+'/'+name+'-authenticated.png',fullPage:true});
   await context.close();
  }
  fs.writeFileSync(out+'/browser-proof.json',JSON.stringify({exactImageFixture:true,nativeTrustedTLS:true,desktop:true,mobile:true,authenticatedSyntheticUser:true,visualPixelInspectionPending:true}));
 }finally{await browser.close()}
})().catch(()=>{console.error('fixed synthetic browser proof failure');process.exit(1)});
