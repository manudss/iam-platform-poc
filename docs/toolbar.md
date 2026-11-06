# Toolbar, changes and review page

Goal (validated mockup): one thin bar with the title, the session timer, the branch pill (colour dot: main grey read only, own branch green, others orange), a Review & Apply icon with a badge, a menu and the user. Branch creation only in "Manage branches". No UI library, plain HTML/CSS.

## Done in this PR so far
- API: `GET /versioning/diff` and `GET /workspace` now carry ROW counts (`rows`: added, modified, removed, total, and per table), from `dolt_diff_stat`. The badge counts rows, not tables.
- Web: page `/review` ("Review changes"): every change of the working branch against main, like a pull request "Files changed" tab. One block per table, one line per row, before in red and after in green, changed cells underlined, schema changes at the end.
- The existing Review & Apply panel shows the row counts per table and links to the full diff.

## Still to do
- The compact bar itself (replaces the workspace bar), the branch pill with search, the discreet Review & Apply icon with tooltip and badge, the "..." menu and the "Manage branches" panel. The e2e scripts select `[name=globalBranch]`, `[name=workspaceNewBranch]`, `#review-apply`, `#test-signin`, `#stable-link`, `#rename-personal` and others, so those scripts are updated in the same step.
- The session timer `<app-session-timer />` stays in the bar.
