import assert from 'node:assert/strict';

/** Real pointer input needs visible, unobscured points. mouse.move() does not
 * scroll an offscreen handle into view as Locator.click() does. */
export async function dragGalleryCard(page, handle, target) {
  await handle.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const from = await handle.boundingBox(), to = await target.boundingBox();
  assert.ok(from && to, 'gallery drag source and target have layout boxes');
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const end = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
  for (const [name, locator, point] of [['handle', handle, start], ['target', target, end]]) {
    const hit = await locator.evaluate((node, point) => {
      const inside = point.x >= 0 && point.x < innerWidth && point.y >= 0 && point.y < innerHeight;
      const element = inside ? document.elementFromPoint(point.x, point.y) : null;
      return { inside, matches: !!element && (element === node || node.contains(element)), scrollY, viewport: { width: innerWidth, height: innerHeight }, point };
    }, point);
    assert.equal(hit.inside, true, 'gallery drag ' + name + ' is outside viewport: ' + JSON.stringify(hit));
    assert.equal(hit.matches, true, 'gallery drag ' + name + ' is obscured or stale: ' + JSON.stringify(hit));
  }
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  try { await page.mouse.move(end.x, end.y, { steps: 12 }); }
  finally { await page.mouse.up(); }
}
