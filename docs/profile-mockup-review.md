# Profile mockup review, PR #65

Review checkpoint: 2026-11-10. Reference: the three validated boards (Profile configuration, My profile, user sheet and plugin lifecycle). This is a gap register, not a claim of full fidelity or production readiness.

## Changes made after the critical review

- Visibility controls now use segmented radio buttons rather than selects, for fields and components. Labels describe the distinct self-service and administrator actions.
- Same-name field sections are grouped once. A section can be added, renamed, moved up/down, or dissolved without deleting its fields. Fields can be dropped onto a section. Core and authority field restrictions remain enforced.
- Section action layout and compact component radio labels were adjusted for narrow screens. Pixel verification of the final deployed revision is still required.
- Branch test sign-in now offers a dedicated test-account signup route. A valid branch ticket is required; main is refused; only test-* IDs are allowed; the route is disabled with branch testing; each ticket is capped at 20 accounts. Regular signup protections were not removed.
- Password authentication uses the tested branch's directory for a branch test. Live authentication still defaults to main. This fixes an end-to-end defect where signup succeeded but the new account could not sign in.
- Added controller and authentication regression coverage: 6 local tests pass. Production-like end-to-end verification remains a separate check.

## Design and usability findings

- The segmented radios make visibility choices directly comparable. Keep their labels readable rather than forcing a dense table to fit every viewport. A horizontal scroll region is acceptable on mobile only if every column can be reached and the page itself does not overflow.
- Section operations must remain separate from field deletion. Dissolve moves fields to Other; it must never delete core fields or plugin values.
- Sections now use an explicit ordered list in the branch-versioned profile configuration, including empty sections. Validation rejects duplicate or malformed names. Save/reload coverage has been added; deployed verification is still required.
- Installed-but-inactive fields now have an informational list, excluded from effective forms and editing. The selected-field panel still lacks the board's per-plugin settings block. This is a structural gap, not a cosmetic difference.
- The TOTP enrollment now renders its QR locally from the fresh URI, with no third-party request, only on the self-service surface. The password lock-state block is still missing. Do not display invented enrollment or lock states to imitate the board.
- All final layouts need side-by-side pixel inspection in light, dark, and 390px width. Screenshots from earlier revisions do not establish the last revision's fidelity.

## Code and functional recommendations

- Section metadata is stored in the typed, branch-versioned profile configuration with explicit order, empty sections and uniqueness checks. Older configurations without sections retain their field-order fallback. Keep the reload and malformed-input tests in CI.
- Add a full browser regression that creates a branch-only account, signs in to that branch, verifies the test banner and restricted navigation, and confirms that main rejects the account. A navigation element alone is not proof of successful authentication because the login layout has navigation too.
- Test accounts are ordinary branch records and can be carried into main by Apply. Remove them before Apply. A future improvement should add an explicit temporary-account cleanup workflow rather than implying automatic expiry.
- Existing component statistics are enrollment counts, not the full statistical breakdown pictured on the board. Keep that distinction visible.
- The two PIN instances in the demo inventory need instance-aware labels, not a silent merge of distinct plugin instances.
- Before calling the PR complete: finish the structural gaps above, verify core/authority restrictions server-side and after reload, inspect all plugin lifecycle states, and run CI plus the deployed signup/login isolation check.

## Delivery state

Draft only. No Ready transition and no merge. Emmanuel reviews and merges himself.
