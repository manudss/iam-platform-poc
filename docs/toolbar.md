# Toolbar, changes and review page

Goal (validated mockup): one thin bar with the title, the session timer, the branch pill (colour dot: main grey read only, own branch green, others orange), a Review & Apply icon with a badge, a menu and the user. Branch creation only in "Manage branches". No UI library, plain HTML/CSS.

## What the bar does
- Header: title, branch pill (colour dot: main grey read only, your own branch green, others orange), Review & Apply icon with a badge of changed ROWS, a "..." menu, the user. Tooltips explain each control. The pill is a native select (keyboard and e2e friendly); a search box is not done yet.
- "..." menu: Test sign-in, Stable test link, Manage branches.
- "Manage branches" panel (only place to create or rename a branch): create from main, rename your personal branch, stable links with Revoke, help folded behind "?".
- Review & Apply opens the modification list (rows per table) with a link to the full diff page `/review`.
- API: `GET /versioning/diff` and `GET /workspace` carry ROW counts (`rows`, per table and total) from `dolt_diff_stat`.
- `/review`: every change of the working branch against main, like a PR "Files changed" tab: per table, per row, before red, after green, changed cells underlined, schema changes.
- No UI library. The session timer `<app-session-timer />` (PR session timeout) goes next to the user in this header: when both PRs are merged, add that one line to `shell.html` if the merge does not.
- Browser scripts use `scripts/branch-ui.mjs` (`openManage`, `openMenu`) to reach the panels.

## Limits
- Branch search in the pill is not done. Panels open below the bar, not as floating popovers (the menu floats).
- Not run locally: the browser e2e scripts need Dolt, so they run in CI.
