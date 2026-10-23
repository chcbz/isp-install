# SM-C1 Runtime fixture provenance and invariant migration

Task: `SKILL-MANAGEMENT-RUNTIME-20261023`, checked 2026-10-23.
Source baseline: `cbc1050825a40378313f283e9f25dc46d44c1ea4`, tree
`4fa8a81432bc9bc8d16d1fc12ab3c065f8d1979a`. The delivery commit identifies the
implementation candidate; these are not deployment records.

## Frozen bytes (do not edit independently)

Source root: `/home/isp/wsps/cyf/specs/juyiting-skill-execution/`.
The original `evidence/management-contract-20261023/contract-lock.json` is copied
here unchanged. `skill-management-wire.test.mjs` verifies each source SHA and
consumes all 79 schema examples and six domain-digest vectors.

| Original under source root | Runtime copy | SHA-256 |
| --- | --- | --- |
| `fixtures/management-contract-v1.schema.json` | `../../../schemas/management-contract-v1.schema.json` | `9b66ef04627fc67c50fb28cfa52805df83478c89416cd9a195446159a6119f8a` |
| `fixtures/management-contract-v1.examples.json` | this directory, same name | `b9e48e96fc431b4920af44a437097d6479a61d7c2ccb076ad6be266db133171e` |
| `fixtures/management-contract-v1.behavior.json` | this directory, same name | `dcd4b7ae53c539b343480fe11b639fcf47bcd6c14b100b139f10fa24302a8edf` |

The adjacent `../skill-management-fixture.mjs` builds isolated real ZIP bytes and
commands from the shared command example. It is a test input helper, not a
substitute installer, registry, lock, extractor or wire implementation. Existing
W08 and SE2 archives are still consumed at their original fixture paths.

## Old-invariant → replacement tests

All test-name prefixes below are literal searchable names. Unless stated
otherwise they are in `test/skill-install-manager.test.mjs`. The old schema1
wire/inbox expectations are retired, **not** their safety/recovery invariants.

| Original invariant / regression | Replacement test prefix and real boundary |
| --- | --- |
| Default off; strict target/path/size; no API key | `management disabled, strict target/path/hash/size`; `same-origin TLS/loopback` (no fetch/ACK on invalid command) |
| Exact download length, digest, origin, MIME, session proof | `download exact length/hash/content-type/redirect` (short/long stream, mismatched header/hash, foreign final URL, incomplete proof) |
| ZIP traversal, symlinks, special files, duplicates and prefix collisions | `real ZIP traversal, symlink/special files, duplicate/prefix` (actual yauzl extraction) |
| Unicode normalization/case/ancestor aliases | same ZIP test: NFC, final-sigma case-fold, case and ancestor-case subtests |
| Bounded frontmatter and expansion/count/per-file limits | `bounded frontmatter identities and archive expansion/entry limits` |
| Original six W08 metadata.version packages | `frozen six W08 metadata.version packages` (original archives and scoped marker identity) |
| Executable identity, manifest, local-script entrypoint; instruction not executable | `executable malformed manifest`; `prepared real SE2 archives`; `SM-C1 real ZIP PREPARE` (four original SE2 packages, measured dependency checks, no provider execution) |
| Atomic activation; no Codex/task/worktree installer fallback | `SM-C1 real ZIP PREPARE`; `retired task-shaped SKILL_INSTALL` in `agent-client.test.mjs`; real-host test below |
| ACK after durable receive; work.result independent durable fact | `ACK follows durable receive`; `cross-boot deliveryEpoch fencing`; real-host tests below |
| Same-command changed fence/hash rejected; no reinstall | `cross-boot deliveryEpoch fencing`; `same-revision conflicting policy intent` |
| Durable installation/owner/tenant/client/profile/API origin binding | `identity is durably installation/owner/tenant/client/profile/origin bound across boots` |
| Crossboot exact result/ACK replay; original execution boot retained | `cross-boot deliveryEpoch fencing`; `ACK follows durable receive` (actual executing boot after receive-only restart) |
| Receipt crash, correlation and acknowledged-evidence tampering | `cross-boot deliveryEpoch fencing`; `lost failure-result persistence stays UNKNOWN` |
| Stable connection drains more than one bounded result batch | `33+ immutable results drain bounded batches` (34 real durable results) |
| Interrupted PREPARE/publication/result save and lost FAILED persistence | `PREPARED / activation intent / switched view / persisted result crashes`; `lost failure-result persistence stays UNKNOWN` |
| UNKNOWN never autoexecutes, installs, switches or calls provider | same crash tests; `READ can prove a formerly UNKNOWN switch`; `startup and READ do not recreate a missing discovery parent`; `POLICY intent and switched-view crashes` |
| Live/legacy/dead/incomplete lock generations, release byte fence | `installer locks reject live/legacy owners` (Linux renameat2 and exact owner bytes) |
| Concurrent stale reclaim never archives/deletes winner | `concurrent stale reclaim loser` (real winning generation injected at exchange) |
| Target and parent inode race preserves foreign content | `publication target/parent inode races` (no replace, UNKNOWN rather than refundable false failure) |
| Concurrent incoming delivery/receipt cannot release async lock or lose journal | `concurrent local delivery and result receipt queue` (blocked real download + same-message replay + receipt + direct lock reentry) |
| Real identity/session change cancels publication; equal binding remains valid | `real authenticated session loss during download`; authenticated refresh/reconnect in real-host test |
| Canonical HOME/state, journal hardlinks, forged marker/manifest and arbitrary HOME package rejection | `HOME/state symlink aliases and journal hardlinks`; `retained manifest/marker/hardlink/symlink tampering` |
| Equal/nested/aliased profile roots (existing whole-host validator) | unchanged `reject equal/nested/state/host/alias/ancestor-alias writable root collision` in `conf/cyf-agent-runtime-v1/test/runtime-host.test.mjs` |
| Old task exact package/manifest/permissions and result recovery after upgrade/disable | `upgrade and policy keep old tasks on exact immutable installation/package/permissions` (real registry + executeSkill; committed result recovery never reruns runner) |
| Preparation failure preserves old; explicit attempt retry; disabled upgrade stays disabled | `failed upgrade preparation preserves old exact view`; `upgrading a disabled skill preserves disabled discovery/policy` |
| Staging/disabled instructions are outside actual skills discovery | `POLICY intent and switched-view crashes`; `cross-parent upgrade exchange treats package owner.json` (no hidden staging packages under skills/) |
| Full public codec, duplicate/raw number/Unicode rejection, original snapshot digest unaffected | all `skill-management-wire.test.mjs`; existing executor/conversation snapshot regression files |

The old ACTIVE+FAILED split between installer registry and task inbox no longer
exists: management's single journal/result is authoritative; generic task inbox
is explicitly excluded. Integrity/correlation/unknown/crash tests above replace
that split-state test, not a fabricated task terminal ACK.

## Real consumer integration and remaining boundary

`conf/cyf-agent-runtime-v1/test/runtime-host.test.mjs`:

- `SM-C1 exact durable result crosses current authenticated channel`: real
  manager + actual transport rejects forged/non-durable ACK/result, correlates
  receipt and preserves original boot/bytes on current authenticated transport.
- `SM-C1 real host first-install closes authenticated PREPARE ACTIVATE capability
  and receipt lifecycle`: actual Runtime client, serializer/parser, existing
  execution host, ZIP/journal, schema2 authenticated capability registration,
  reconnect/redelivery and receipt retirement. HTTP/WS peers are isolated API
  boundary doubles, **not actual API service/MySQL acceptance**.

Behavior fixture Runtime portions exercised: C01, C06, C08, C10–C19 and C21.
Their Web, DB transaction, purchase/entitlement, admission-lock and actual
cross-service portions remain coordinator integration work. Frozen behavior
statuses are intentionally not rewritten to PASS. No paid provider, production
installation, garbage collection, Flow build, deployment or browser acceptance
is claimed by these source tests. Exact run totals and logs accompany delivery.
