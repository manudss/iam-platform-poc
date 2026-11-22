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


/** Bounded DOM-only diagnostics for fictional Gallery tests. No input values,
 * auth data, request bodies or application private state are collected. */
export async function installGalleryPointerTrace(page) {
  const install = () => {
    if (window.__galleryPointerTrace) return;
    const trace = window.__galleryPointerTrace = { format: 1, document: performance.timeOrigin, events: [] };
    let source, pointerId, active = false;
    const describe = node => node instanceof Element ? { tag: node.tagName, card: node.closest('[data-app]')?.getAttribute('data-app'), handle: node.matches('.lp-handle') } : null;
    const record = (phase, e, observedSource = source) => {
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      trace.events.push({ phase, at: performance.now(), type: e.type, trusted: e.isTrusted, button: e.button, defaultPrevented: e.defaultPrevented, pointerId: e.pointerId, pointerType: e.pointerType, buttons: e.buttons, x: e.clientX, y: e.clientY,
        target: describe(e.target), hit: describe(hit), sourceConnected: !!observedSource?.isConnected, captured: !!observedSource?.hasPointerCapture(e.pointerId),
        sourceRect: observedSource?.isConnected ? observedSource.getBoundingClientRect().toJSON() : null,
        draggingCard: document.querySelector('.lp-dragging')?.getAttribute('data-app') ?? null,
        editing: !!document.querySelector('#lp-save'), branch: document.querySelector('#branch-picker-button')?.textContent?.trim() ?? null,
        order: [...document.querySelectorAll('[aria-label="Other applications"] .lp-card')].map(n => n.getAttribute('data-app')),
        scrollY, viewport: [innerWidth, innerHeight] });
      if (trace.events.length > 200) trace.events.shift();
    };
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture']) {
      document.addEventListener(type, e => {
        if (type === 'pointerdown') { source = e.target?.closest?.('.lp-handle'); active = !!source; pointerId = active ? e.pointerId : undefined; }
        if (e.pointerId === pointerId && (active || type.endsWith('pointercapture'))) record('capture', e);
      }, true);
      document.addEventListener(type, e => {
        if (e.pointerId !== pointerId || (!active && !type.endsWith('pointercapture'))) return;
        record('bubble', e);
        if (type === 'pointerup' || type === 'pointercancel') { active = false; const observedSource = source; requestAnimationFrame(() => record('after-render', e, observedSource)); }
      });
    }
  };
  await page.addInitScript(install);
  await page.evaluate(install);
  const documents = new Map();
  return { async capture() {
    const trace = await page.evaluate(() => window.__galleryPointerTrace);
    if (trace) documents.set(trace.document, trace);
    return { format: 1, evidence: 'DOM/event observations, not application private pointer state', documents: [...documents.values()] };
  } };
}
