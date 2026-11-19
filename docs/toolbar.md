# Toolbar, changes and review page

Goal (validated mockup): one thin bar with the title, the session timer, the branch pill (colour dot: main grey read only, own branch green, others orange), a Review & Apply icon with a badge, a menu and the user. Branch creation only in "Manage branches". No UI library, plain HTML/CSS.

## What the bar does
- Header: title, branch pill (colour dot: main grey read only, your own branch green, others orange), a Review & Apply chip with the count of pending changes, a "..." menu, the user. Tooltips explain each control. The pill opens a branch picker (search, refresh on open, "New branch", "Manage branches"); the native select stays in the DOM, visually hidden and synchronized, so browser scripts keep reading and setting it.
- "..." menu: Test sign-in, Stable test link, Manage branches.
- "Manage branches" panel: create from main, rename your personal branch, stable links with Revoke, help folded behind "?". Also reachable from the branch picker.
- Review & Apply: the same chip opens and closes the review panel, which floats above the page (close with the chip, its ✕, Escape or a click outside) and lists the modifications (rows per table) with a link to the full diff page `/review`. The chip is quiet when nothing waits and highlighted as soon as changes are pending.
- Pending-merge hint: each accepted write on a branch refreshes the counter (the real branch diff, so an edit that cancels another brings it back to 0), briefly flashes a banner at the top of the page (never sticky, it fades out by itself) and flies a dot toward the chip, which pulses. A failed API call never triggers it; the flash only fires for writes that can leave rows pending (users, roles, profile fields, staged assignments, plugin enable/disable/settings/install, application connectors, workflows, explorer SQL — never simulations, probes, sessions, tokens, enrollments, profile reviews, activations or branch bookkeeping), only while the re-read diff truly has something pending. Reduced-motion settings disable the animation. The hook is `ApiClient.onDataMutation`; the session counts accepted writes in `branchWrites` as a trigger, the counter itself always comes from `GET /workspace`.
- API: `GET /versioning/diff` and `GET /workspace` carry ROW counts (`rows`, per table and total) from `dolt_diff_stat`.
- `/review`: every change of the working branch against main, like a PR "Files changed" tab: per table, per row, before red, after green, changed cells underlined, schema changes.
- No UI library. The session timer `<app-session-timer />` (PR session timeout) goes next to the user in this header: when both PRs are merged, add that one line to `shell.html` if the merge does not.
- Browser scripts use `scripts/branch-ui.mjs` (`openManage`, `openMenu`) to reach the panels.

## Limits
- The "Manage branches" panel still opens inline below the bar (the picker, the menu and the review panel float).
- Not run locally: the browser e2e scripts need Dolt, so they run in CI.

## Personal branch state (branch pill)

Opening the personal branch never shows a banner or a "Choose your working branch" card while it works. The state lives in the branch pill of the top bar:

- **Opening**: spinner and "Opening your branch…"; the page loads normally.
- **Ready**: green dot and the branch name. The message ("Your personal branch … is ready. Changes stay on it until Apply." or "Back on your personal branch …") is the pill tooltip (hover or keyboard focus) and is also announced once to screen readers (`role="status"`).
- **Error** (or admin capability token missing): red pill "Branch unavailable" with **Retry**; the detail is in the tooltip, the message bar and the "Choose your working branch" card stay as the visible fallback.

My applications needs no branch and renders without waiting for it.
