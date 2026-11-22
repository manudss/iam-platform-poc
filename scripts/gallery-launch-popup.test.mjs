import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertGalleryLaunchPopup } from './lib/gallery-launch-popup.mjs';
import { dragGalleryCard } from './lib/gallery-pointer.mjs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright-core');

test('keyboard popup check does not depend on the destination responding', async () => {
  let destinationRequests = 0;
  const server = createServer((req, res) => {
    if (req.url === '/unavailable-app') { destinationRequests++; return; } // Deliberately never responds.
    res.setHeader('content-type', 'text/html');
    res.end('<a class="lp-launch" href="/unavailable-app" target="_blank" rel="noopener noreferrer">Open app</a>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await assertGalleryLaunchPopup(page, page.locator('.lp-launch'));
    assert.equal(destinationRequests, 0, 'no request reaches the unavailable app');
    assert.equal(page.context().pages().length, 1, 'fixture tab is closed after assertion');
    // The local fixture must not hide an actual regression to same-tab navigation.
    await page.locator('.lp-launch').evaluate(a => a.target = '_self');
    await assert.rejects(assertGalleryLaunchPopup(page, page.locator('.lp-launch'), { timeout: 500 }), /Timeout/);
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

// This isolates the browser-input precondition, not the full Angular application.
// It does not establish the unique cause of a historical Gallery CI timeout.
const pointerFixture = `<!doctype html><title>Fictional Gallery pointer fixture</title>
<style>body{font:18px sans-serif}#cards{display:flex;gap:30px;margin-top:900px}article{position:relative;width:240px;height:240px;border:2px solid teal;padding:12px}button{position:absolute;bottom:15px;left:15px;width:90px;height:44px;touch-action:none}output{position:fixed;top:12px;right:12px;background:#dff5e9;padding:12px}</style>
<h1>Fictional pointer fixture</h1><p>Only local browser input. No application or user account.</p>
<output id=result>0</output><div id=cards><article id=target data-app=target>Drop here</article><article id=source data-app=source>Source card<button id=handle>Drag</button></article></div>
<script>let active=false;const handle=document.querySelector('#handle');handle.addEventListener('pointerdown',e=>{active=true;handle.setPointerCapture(e.pointerId)});handle.addEventListener('pointerup',e=>{if(active&&document.elementFromPoint(e.clientX,e.clientY)?.closest('#target'))document.querySelector('#result').textContent=String(Number(document.querySelector('#result').textContent)+1);active=false});</script>`;
test('real pointer drag scrolls an offscreen handle and still requires a real drop', async () => {
  const browser=await chromium.launch({executablePath:process.env.CHROME_BIN,args:['--no-sandbox']});
  try {
    const page=await browser.newPage({viewport:{width:900,height:600}});await page.setContent(pointerFixture);
    const handle=page.locator('#handle'),target=page.locator('#target');const from=await handle.boundingBox(),to=await target.boundingBox();
    assert.ok(from.y>600,'fixture deliberately starts with the drag handle below viewport');
    // Original coordinate-only sequence: no auto-scroll, therefore no real pointerdown on the handle.
    await page.mouse.move(from.x+from.width/2,from.y+from.height/2);await page.mouse.down();await page.mouse.move(to.x+to.width/2,to.y+to.height/2,{steps:12});await page.mouse.up();
    assert.equal(await page.locator('#result').textContent(),'0');
    await dragGalleryCard(page,handle,target);
    assert.equal(await page.locator('#result').textContent(),'1','a real pointer capture/drop occurred');
    if(process.env.GALLERY_POINTER_SHOTS){await mkdir(process.env.GALLERY_POINTER_SHOTS,{recursive:true});await page.screenshot({path:resolve(process.env.GALLERY_POINTER_SHOTS,'pointer-fixture.png')});}
  } finally {await browser.close();}
});
test('an obscured drag target fails rather than clicking through an overlay', async () => {
  const browser=await chromium.launch({executablePath:process.env.CHROME_BIN,args:['--no-sandbox']});
  try {
    const page=await browser.newPage({viewport:{width:900,height:600}});await page.setContent(pointerFixture);
    await page.evaluate(()=>{const cover=document.createElement('div');cover.style.cssText='position:fixed;inset:0;z-index:100;background:rgba(0,0,0,.1)';document.body.append(cover)});
    await assert.rejects(dragGalleryCard(page,page.locator('#handle'),page.locator('#target')),/obscured or stale/);
    assert.equal(await page.locator('#result').textContent(),'0');
  } finally {await browser.close();}
});
