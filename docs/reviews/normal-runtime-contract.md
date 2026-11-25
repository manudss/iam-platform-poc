# Normal two-network launcher contract for review

Status: implementation draft normal-runtime.py exists, NOT installed, NOT Docker-qualified. No release guard is lifted. Review this contract before considering the draft executable.

## Topology and scope

Operator prepared backend network ID 00a7a1e4f7506188bc339984239c7f62e281e88a8b66ca22641027d8a52f8183, name lyam-backend-prepared, internal bridge, IPv6 off. Front network ID 65c9e7a538091e3b54145ff61cc2d1ab9e41f16b4f8742d9e9eab142e053fe69, name lyam-front-prepared, noninternal bridge, IPv6 off. These remain leads until directly inspected at each launch. PG/Bao need backend aliases pg/bao and pinned container IDs/IPs. They must have no other network or published port. No existing production companion is moved by the launcher.

The app is connected to both networks while it is only a shell blocked on a fresh FIFO. It has restart=no, all capabilities dropped, noNewPrivileges, IPv6 disabled, no Docker socket, a single exact /data mount and only 127.0.0.1:PORT:8080 published. Config, image digest/image ID/revision, helper and environment must be protected/hash-bound. Actual container environment is compared to image defaults plus exact env bytes; HOLD must be absent and seed=never. No TLS bypass.

## First application instruction

The controller creates the container with a FIFO entrypoint, connects the second network, records container ID, PID and network namespace inode, checks identity before every namespace command, then applies IPv4/IPv6 OUTPUT policy. There is no docker start path to an unguarded app. A later docker start blocks on a new FIFO. Unknown container/PID/namespace remains closed.

Allowed IPv4: loopback 127.0.0.1, return traffic in conntrack REPLY direction, exact PG:5432 and Bao:8200, Docker DNS 127.0.0.11 TCP/UDP53 with conntrack original destination binding, and TCP443 to global public IPv4. Private/shared/link-local/metadata/host/multicast/reserved IPv4 is rejected before the public443 rule. All other ports/protocols reject. IPv6 is disabled and OUTPUT drops except ::1 and replies, final reject. Public HTTPS is broad by IP, not a domain allowlist; operator confirmed it fits current Google/GitHub/Sheets/Jira/Resend restoration. SMTP is not needed. Ollama is not implicitly reachable; restoring that local companion requires an exact separate exception and proof, never broad LAN access.

Before FIFO release, direct probes in the exact app namespace must establish: PG/Bao aliases and exact endpoints; public DNS resolution and certificate-verified HTTPS; rejects for host gateways, LAN/private/link-local/metadata, public80/SMTP, own nonloopback IP and UDP/ICMP, with dedicated reject counters so absent destinations are not mistaken for enforcement; IPv6 inactive plus drop; capability effective/bounding sets zero and noNewPrivs; exact mounts/ports/networks/environment. Probe failure stops only this newly created container and keeps access closed. No old-image restart, no restore, no automatic retry.

Recheck protected files, topology, namespace identity and exact rule sets immediately before writing start-normal into the FIFO. Return a private controller-produced observation binding config/image/env/container/PID/namespace/rules/probes. It is not an approval or a release verdict. Direct postcheck repeats identity and rules before any access gate opens.

## Shared callers and effect boundary

Release writes its durable normal-start-committed marker before HOLD removal or calling this launcher. Updater must call the same installed launcher, not synthesize docker run. Boot must never plain-start the normal container; if stopped it enters a separately audited same-image path that invokes the launcher behind access gates and cold preservation. A live existing normal namespace can be inspected, not restarted. Each caller retains its real updater lock and journals subprocess identities. Future ordered updates preserve the same topology and policies.

## Evidence and limits

Unit tests are below the release threshold. Required before executable use: reviewer-approved contract, complete implementation, adversarial Docker tests on a disposable runner, isolated rehearsal with three synthetic stores and fixture-only credentials/upstreams, and operator validation of exact live namespace before first normal effect. A JSON proof file does not establish these facts. Current release preflight remains unconditionally refusing.

## Accepted review corrections and remaining integration

Two durable markers: normal-start-committed is intent before container creation. The launcher calls its installed parent to persist effects-released immediately before FIFO write. If this callback raises, FIFO is not written but its persistence may have landed, so the container is stopped and retained as ambiguous. A failure before invoking the callback stops/removes only the fresh FIFO container; application initialization never began. No automatic retry is implemented. Reviewed retry must first establish exact container absence and that no effects marker was written.

PG and Bao use static backend IPv4 addresses 172.19.0.10 and 172.19.0.11 (operator choice), with IPAMConfig static-address inspection at every launch and postcheck. Before every gate opening, repeat direct identity, namespace, topology, rule and environment inspection. A companion ID or IP change is a failed health state, not permission to connect to a reused address. A future periodic host supervisor must close gates and stop the app on that drift; it is not implemented in this draft.

Every normal start, including updater rollback and normal host boot, must use this same launcher. The existing updater/boot still have legacy normal-start paths. They are NOT yet wired to the new launcher and must remain unavailable for a released E5 until that integration is reviewed and tested. The release adapter now invokes this launcher in the unreachable body after its unconditional preflight refusal; this does not enable release.

Boot policy agreed with operator: only a committed normal journal, no pause, no intent, no operator-stopped flag, and proved orderly shutdown may enter the audited same-image path through cold preservation and this launcher. Ambiguous app failure or unclean host shutdown is report-only, gated, not a replay. Missing boot implementation must remain a visible service failure, not a claim of durable automatic restoration. No restart=no-only final state is proposed as complete.

The env is read/hash-checked once and supplied to Docker via a sealed anonymous descriptor. Later path rechecks detect drift but cannot substitute the bytes passed to create. DNS and public443 permit data to leave to arbitrary public destinations, including DNS tunneling. This is a residual risk accepted for current service restoration, not a data-confinement guarantee. A domain-filtering proxy can tighten it later.

The draft tests are local doubles except real sealed-descriptor checks. Seven tests pass, including sealed env bytes, private-before443 ordering, FIFO entrypoint, pre-effect failure cleanup, marker-before-FIFO ordering and ambiguous callback failure. Dedicated negative counter logic, real Docker DNS/NAT behavior and routing remain unqualified. No successful test on real Docker has been run here.

## Review follow-up and first real Docker route

prepare() now performs read-only topology, file and image validation before the held container can be removed. launch() independently proves real exclusive lock descriptors and propagates them to all children. Companion transition may allow exactly one additional named/ID-bound internal IPv4 network, validated directly; the app never joins that old network. Operator order: add the new static backend endpoints to unchanged companions while held still works, inspect/verify stores, prepare, then stop held behind proven gates and launch. Remove old endpoints only after complete qualification, not beforehand.

OCI host DNS was observed as 169.254.169.254. The draft normal profile therefore requires explicit public --dns upstreams (one or two global IPv4 addresses), exact TCP/UDP53 rules only for them, and keeps metadata80/443 rejected. 1.1.1.1 and 9.9.9.9 are the proposed tested-fixture values. Real Docker DNS forwarding must pass before any normal app initialization. This is not yet a successful claim. Added tests for private172/private192, alternate resolver denial and 192.88.99/24 exclusion.

The first Docker workflow uses GitHub-hosted ubuntu only, exact existing81aeb image, fresh prefix-owned two networks, fake TCP PG/Bao, empty /data and seednever. It refuses effects in the callback after actual namespace probes, so app startup is never permitted. Output is a bounded stage/verdict, not raw logs or env. This tests network plumbing only, not a three-store rehearsal. It will be triggered through the draft PR and must complete before further host testing.
