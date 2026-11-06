// Shared by the browser scripts: the compact bar keeps branch creation, rename and stable links in the
// "Manage branches" panel (docs/toolbar.md), opened from the "..." menu. These helpers open them when needed.
export async function openManage(page) {
  if (await page.locator('#branch-panel').count()) return;
  if (!(await page.locator('#manage-branches').isVisible())) await page.click('#more-menu');
  await page.click('#manage-branches');
  await page.waitForSelector('#branch-panel');
}
export async function openMenu(page) {
  if (!(await page.locator('#more-panel').count())) await page.click('#more-menu');
  await page.waitForSelector('#more-panel');
}
