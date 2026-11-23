// Actual plugin and host CSS, in-memory local save responses. Never connects to the demo.
const {chromium}=require('playwright-core');
const fs=require('node:fs'), path=require('node:path'), assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'), out=process.argv[2]||'/tmp/mail-template-text-only';
fs.mkdirSync(out,{recursive:true});
(async()=>{
  const {generateTheme,themeCss}=await import(require('node:url').pathToFileURL(path.join(root,'apps/api/dist/branding/theme-engine.js')).href);
  const alternate=themeCss(generateTheme({primary:'#00695c',accent:'#4db6ac'}),{baseline:'',footer:''});
  const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});
  try {
    for(const mobile of [false,true]) for(const theme of ['light','dark']) for(const secret of [false,true]) for(const accent of ['default','teal']) {
      let detail={key:'custom.fixture',name:secret?'Temporary access fixture':'Text notification fixture',plugin:'mail-templates',owned:true,customized:true,variables:secret?[{name:'password',type:'temporary-password',required:true},{name:'expiry',type:'text',required:true}]:[],effective:{subject:'Your access',text:secret?'Access {{password}} expires {{expiry}}.':'Hello, your workflow finished.'}};
      detail.effective.text += '\n\nAccount: sample-account\nLiteral <script>alert(1)</script> & <b>not HTML</b>.\n'+'long-line-'.repeat(40);
      const original=detail.effective.text, saves=[], errors=[], calls=[];
      const page=await browser.newPage({viewport:{width:mobile?390:1200,height:mobile?844:850}});
      page.on('pageerror',e=>errors.push(e.message));
      await page.route('**/*',async route=>{
        const req=route.request(), url=new URL(req.url()); calls.push(req.method()+' '+url.pathname);
        if(req.method()==='GET') return route.fulfill({json:url.pathname.endsWith('/custom.fixture')?detail:[detail]});
        if(req.method()==='PUT' && url.pathname.endsWith('/custom.fixture')) {
          const body=req.postDataJSON(); saves.push(body); detail={...detail,effective:{subject:body.subject,text:body.text,...(body.html?{html:body.html}:{})}};
          return route.fulfill({json:detail});
        }
        if(req.method()==='POST' && url.pathname.endsWith('/preview')) {const body=req.postDataJSON();return route.fulfill({json:{text:body.override?.text??detail.effective.text}});}
        return route.abort();
      });
      await page.setContent('<main style="padding:16px"><plg-mail-templates></plg-mail-templates></main>');
      await page.addStyleTag({path:path.join(root,'apps/web/src/styles.css')});
      if(accent==='teal')await page.addStyleTag({content:alternate});
      await page.evaluate(t=>{document.documentElement.dataset.theme=t;document.querySelector('plg-mail-templates').context={api:'https://fixture.invalid',token:'fictional',branch:'personal/fixture'};},theme);
      await page.addScriptTag({type:'module',content:fs.readFileSync(path.join(root,'plugins/mail-templates/screens/templates.mjs'),'utf8')});
      const galleryPreview=page.frameLocator('iframe[data-prev]').locator('pre');
      await galleryPreview.waitFor();
      assert.equal(await galleryPreview.textContent(),detail.effective.text);
      await page.getByRole('button',{name:'Edit',exact:true}).click();
      await page.getByRole('tab',{name:'Text',exact:true}).waitFor();
      assert.equal(await page.getByRole('tab',{name:'Text',exact:true}).getAttribute('aria-selected'),'true');
      assert.equal(await page.locator('#mt-body').inputValue(),original);
      if(secret) {assert.equal(await page.getByRole('button',{name:'Send test',exact:true}).count(),0);assert.equal(await page.locator('[data-var=password]').isDisabled(),true);}
      async function saveLocal() {
        await Promise.all([page.waitForResponse(r=>r.request().method()==='PUT'), page.getByRole('button',{name:'Save on this branch',exact:true}).click()]);
        await page.waitForFunction(()=>!document.querySelector('#mt-note').textContent);
      }
      // Saving immediately must retain the original text and omit empty HTML.
      await saveLocal();
      assert.equal(saves.length,1);assert.equal(saves[0].text,original);assert.equal('html' in saves[0],false);
      // Switching to empty HTML and saving also must not erase text.
      await page.getByRole('tab',{name:'HTML',exact:true}).click();
      assert.equal(await page.locator('#mt-body').inputValue(),'');
      await saveLocal();
      assert.equal(saves.length,2);assert.equal(saves[1].text,original);assert.equal('html' in saves[1],false);
      await page.getByRole('tab',{name:'Text',exact:true}).click();
      const edited=original+' Reviewed.';
      await page.locator('#mt-body').fill(edited);
      await page.getByRole('tab',{name:'HTML',exact:true}).click();
      await page.getByRole('tab',{name:'Text',exact:true}).click();
      assert.equal(await page.locator('#mt-body').inputValue(),edited);
      await saveLocal();
      assert.equal(saves.length,3);assert.equal(saves[2].text,edited);assert.equal('html' in saves[2],false);
      await page.locator('#mt-big').waitFor();
      await page.getByRole('button',{name:'← All templates',exact:true}).click();
      await page.getByRole('button',{name:'Edit',exact:true}).click();
      await page.getByRole('tab',{name:'Text',exact:true}).waitFor();
      assert.equal(await page.locator('#mt-body').inputValue(),edited);
      assert.equal(await page.getByRole('tab',{name:'Text',exact:true}).getAttribute('aria-selected'),'true');
      // A late preview response can replace srcdoc. Retry only the detached-frame read.
      for(let attempt=0;;attempt++) {
        try {
          const preview=page.frameLocator('#mt-big').locator('pre');
          await preview.waitFor();
          assert.equal(await preview.textContent(),edited);
          assert.equal(await preview.evaluate(el=>getComputedStyle(el).whiteSpace),'pre-wrap');
          assert.equal(await page.frameLocator('#mt-big').locator('script,b').count(),0);
          assert.equal(await preview.evaluate(el=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);
          break;
        } catch(e) {if(attempt>=2||!String(e).includes('Execution context was destroyed'))throw e;}
      }
      await page.locator('#mt-big').scrollIntoViewIfNeeded();
      await page.screenshot({path:path.join(out,`${mobile?'mobile':'desktop'}-${theme}-${accent}-${secret?'secret':'ordinary'}.png`),fullPage:true});
      assert.deepEqual(errors,[]);assert.ok(calls.every(c=>!c.includes('send-test')),JSON.stringify(calls));
      console.log('PASS',accent,mobile?'mobile':'desktop',theme,secret?'secret':'ordinary','text default, 3 local saves preserve body, reopen');
      await page.close();
    }
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
