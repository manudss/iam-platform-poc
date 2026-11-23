// Real plugin screen + host styles, fictional local responses. No remote calls or mail sends.
const { chromium } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const out = process.argv[2] || '/tmp/mail-template-tab-contrast';
fs.mkdirSync(out, { recursive: true });
const detail = {key:'workflow.notify', name:'Workflow notification', plugin:'workflows-iga', variables:[], effective:{subject:'Workflow notification',text:'Workflow finished.',html:'<p>Workflow finished.</p>'}};
(async () => {
  const {generateTheme,themeCss}=await import(require('node:url').pathToFileURL(path.join(root,'apps/api/dist/branding/theme-engine.js')).href);
  const alternate=themeCss(generateTheme({primary:'#00695c',accent:'#4db6ac'}),{baseline:'',footer:''});
  const browser = await chromium.launch({executablePath:'/usr/bin/google-chrome', args:['--no-sandbox']});
  try {
    for (const mobile of [false, true]) for (const theme of ['light', 'dark']) for(const accent of ['default','teal']) {
      const page = await browser.newPage({viewport:{width:mobile?390:1200,height:mobile?844:850}});
      const errors = [], calls = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', route => {
        const req = route.request(), url = new URL(req.url());
        calls.push({method:req.method(), path:url.pathname});
        if(req.method()==='GET') return route.fulfill({json:url.pathname.endsWith('/workflow.notify')?detail:[detail]});
        if(req.method()==='POST' && url.pathname.endsWith('/preview')) return route.fulfill({json:{html:'<p>Workflow finished.</p>'}});
        return route.abort();
      });
      await page.setContent('<main style="padding:16px"><plg-mail-templates></plg-mail-templates></main>');
      await page.addStyleTag({path:path.join(root,'apps/web/src/styles.css')});
      if(accent==='teal')await page.addStyleTag({content:alternate});
      await page.evaluate(t => {
        document.documentElement.dataset.theme=t;
        document.querySelector('plg-mail-templates').context={api:'https://fixture.invalid', token:'fictional', branch:'personal/fixture'};
      }, theme);
      await page.addScriptTag({type:'module',content:fs.readFileSync(path.join(root,'plugins/mail-templates/screens/templates.mjs'),'utf8')});
      await page.getByRole('button',{name:'Edit',exact:true}).click();
      await page.getByRole('tab',{name:'HTML',exact:true}).waitFor();
      const placement=await page.locator('.body-toolbar').evaluate(el=>{const bar=el.getBoundingClientRect(),body=document.querySelector('#mt-body').getBoundingClientRect();return {left:Math.abs(bar.left-body.left),right:Math.abs(bar.right-body.right),gap:Math.abs(bar.bottom-body.top)};});
      assert.ok(placement.left<1&&placement.right<1&&placement.gap<1,JSON.stringify(placement));
      const ratios=[];
      async function check() {
        const data=await page.locator('[role=tab]').evaluateAll(tabs => {
          const lum = color => {
            const a=color.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});
            return .2126*a[0]+.7152*a[1]+.0722*a[2];
          };
          return tabs.map(tab=>{const s=getComputedStyle(tab),a=lum(s.color),b=lum(s.backgroundColor);return {text:tab.textContent,selected:tab.getAttribute('aria-selected'),ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};});
        });
        for(const tab of data) assert.ok(tab.ratio>=4.5, JSON.stringify({theme,mobile,...tab}));
        assert.equal(data.filter(t=>t.selected==='true').length,1);
        ratios.push(...data.map(t=>Number(t.ratio.toFixed(2))));
      }
      await check();
      for (const name of ['Text', 'HTML']) {
        const tab=page.getByRole('tab',{name,exact:true});
        await tab.hover(); await check(); await tab.click(); await check();
        await page.keyboard.press('Tab');
        await tab.focus();
        const outline=await tab.evaluate(el=>getComputedStyle(el).outlineStyle);
        assert.notEqual(outline,'none');
        await page.screenshot({path:path.join(out,`${mobile?'mobile':'desktop'}-${theme}-${accent}-${name}.png`),fullPage:true});
      }
      assert.deepEqual(errors,[]);
      assert.ok(calls.every(c=>c.method==='GET'||c.path.endsWith('/preview')),JSON.stringify(calls));
      console.log('PASS',accent,mobile?'mobile':'desktop',theme,'normal/hover/selected/focus, minimum contrast',Math.min(...ratios),'no persistence or send');
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exit(1);});
