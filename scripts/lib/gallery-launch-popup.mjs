import assert from 'node:assert/strict';

/** Test the gallery's keyboard/new-tab contract, not an external demo host's uptime.
 * Playwright emits popup only once its initial navigation responds. A cold/slow
 * Render app can therefore time out even when the browser opened the tab correctly.
 * Context routing (not page routing) also covers a popup's very first request.
 */
export async function assertGalleryLaunchPopup(page, link, { timeout = 5000 } = {}) {
  const source = page.url();
  const destination = await link.evaluate(anchor => anchor.href);
  assert.match(destination, /^https?:\/\//, 'launch link has an HTTP(S) destination');
  assert.notEqual(destination, source, 'launch link points to an application');
  const context = page.context();
  const matches = url => url.href === destination;
  const respond = route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><title>Gallery launch fixture</title><p id="launch-destination">Application opened</p>',
  });
  let tab;
  await context.route(matches, respond);
  try {
    // Keep the real href and real Enter activation. Only the response is local.
    const popup = page.waitForEvent('popup', { timeout });
    [tab] = await Promise.all([popup, link.press('Enter')]);
    await tab.waitForSelector('#launch-destination', { timeout });
    assert.equal(tab.url(), destination, 'the selected application opens in the new tab');
    assert.equal(page.url(), source, 'launchpad stays in the current tab');
  } finally {
    if (tab) await tab.close();
    await context.unroute(matches, respond);
  }
}
