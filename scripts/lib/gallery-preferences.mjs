import assert from 'node:assert/strict';

/** The star moves optimistically. Its visible destination is not a persistence acknowledgement.
 * Install the response waiter before clicking and require the actual PUT to complete successfully.
 * This is test synchronization, not a retry or a weaker assertion about persisted preferences. */
export async function confirmGalleryPreferencesWrite(page, action) {
  const response = page.waitForResponse(r => r.request().method() === 'PUT' && new URL(r.url()).pathname.endsWith('/launchpad/preferences'));
  await action();
  const r = await response;
  assert.ok(r.ok(), `Gallery preferences PUT failed: HTTP ${r.status()}`);
  assert.equal(await r.finished(), null, 'Gallery preferences PUT response completed');
}
