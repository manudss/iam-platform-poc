// Shared by the browser scripts: the compact bar keeps branch creation, rename and stable links in the
// "Manage branches" panel (docs/toolbar.md), opened from the branch picker. These helpers open them when needed.
export async function openManage(page) {
  if (await page.locator('#branch-panel').count()) return;
  await openMenu(page);
  await page.click('#picker-manage');
  await page.waitForSelector('#branch-panel');
}
export async function openMenu(page) {
  if (!(await page.locator('#branch-picker').count())) await page.click('#branch-picker-button');
  await page.waitForSelector('#branch-picker');
}
