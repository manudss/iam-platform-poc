import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertGalleryLaunchPopup } from './lib/gallery-launch-popup.mjs';
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
