# Gallery persistence assertion synchronization

The push CI run 45070933616 for main 15823f8 built and booted the demo image, completed its health and sign-in checks, and passed popup/bootstrap checks. Its Gallery end-to-end test timed out at `scripts/gallery-e2e.mjs:41`, waiting for PeopleHub in Favourites after a reload.

The test clicked the star, waited for its optimistic DOM move, then immediately reloaded. A visible favourite is not acknowledgement of the asynchronous preferences PUT. A deterministic regression on the actual production Angular bundle holds that PUT: the old sequence sees the optimistic favourite, reloads, and reads the previous server preferences. The new helper installs its response waiter before the click and requires a successful completed PUT before proceeding. The same reload assertion remains. A failed PUT fails the helper, never retries or passes.

This proves a defective synchronization precondition in the test. The historical CI run did not retain a request trace proving the exact PUT/reload order, so this does not establish its unique cause. Its failure is different from the earlier mobile move timeout. No production application behavior is changed, no timeout is increased, and no assertion is removed.

The new actual-bundle regression runs beside the existing bootstrap test against the bundle copied from the same Docker image. Provider/API responses and identity are fictional local fixtures. No real account or website is changed. Exact-head CI and independent review remain required.
