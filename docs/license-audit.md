# Dependency license audit

Date: 2026-11-07. Method: `license-checker-rseidelsohn --production` on installed
node_modules, and the crates.io API for every package in `core/Cargo.lock`.
Re-run when dependencies change. Purpose: the project is proprietary (see LICENSE);
this audit supports the third-party attributions kept in NOTICE, which the
permissive licenses of the dependencies require.

## Result

Every production dependency, transitive included, is under a permissive license
compatible with either MIT or Apache-2.0 for the project. Nothing forces copyleft.

## npm — apps/api (production tree, 309 packages)

| License | Packages |
|---|---|
| MIT | 225 |
| Apache-2.0 | 36 |
| BSD-3-Clause | 19 |
| ISC | 17 |
| Apache-2.0 AND MIT | 2 |
| BSD-2-Clause, Unlicense | 2 each |
| CC-BY-4.0, MIT-0, 0BSD, Public Domain, MIT* | 1 each |
| UNLICENSED (own package `apps/api`) | 1 |

Direct dependencies and their licenses:

| Package | License |
|---|---|
| @grpc/grpc-js, @grpc/proto-loader, nats, reflect-metadata, rxjs | Apache-2.0 |
| @modelcontextprotocol/sdk, @nestjs/* (common, core, platform-express), @temporalio/*, @xmldom/xmldom, mysql2, oidc-provider, pg, samlify | MIT |
| nodemailer | MIT-0 |

Flagged, resolved:
- `caniuse-lite` is CC-BY-4.0: data, not code; attribution kept in this NOTICE chain.
  Acceptable under any candidate license.
- `xml-escape` is marked `MIT*` (MIT with a non-standard license file text). Acceptable.
- `apps/api` itself reports UNLICENSED: no `license` field yet — set when the license
  is chosen.

## npm — apps/web (production tree, 26 packages)

14 MIT, 8 ISC, 1 BSD-3-Clause, 1 Apache-2.0, 1 0BSD, plus the own `web` package
(UNLICENSED until chosen). Angular packages are MIT; `tslib` is 0BSD; `ngx-vflow` is MIT.

## Rust — core workspace (438 external crates in Cargo.lock)

All permissive: 200 MIT OR Apache-2.0, 63 MIT, 39 Apache-2.0 OR MIT, plus
Apache-2.0 (15), Apache-2.0 WITH LLVM-exception (31+14 combined forms), Unicode-3.0 (18,
the `icu`/unicode data crates), BSD-2/3-Clause, ISC, Zlib, BSL-1.0 (Boost, permissive),
Unlicense, 0BSD-style.

Flagged, resolved (dual/multi-licensed, a permissive option is taken):
- `ittapi`, `ittapi-sys`: GPL-2.0-only **OR** BSD-3-Clause — the BSD-3-Clause option applies.
- `r-efi`: MIT OR Apache-2.0 OR LGPL-2.1-or-later — the MIT/Apache-2.0 option applies.

Direct dependencies worth noting: `cedar-policy` Apache-2.0; `wasmtime`/`wat`
Apache-2.0 WITH LLVM-exception; `tokio`, `axum`, `tonic`, `prost` MIT/Apache-2.0;
`ed25519-dalek` BSD-3-Clause; `async-nats` Apache-2.0.

## Conclusion

No GPL-only, LGPL-only, SSPL or proprietary dependency in any production tree.
All dependencies are permissive (MIT/Apache-2.0/BSD/ISC-style): their only
obligations are notice retention, satisfied by the NOTICE file. They do not affect
the project's proprietary, all-rights-reserved status.
