# U0-R runtime capabilities v1 evidence

Date: 2026-09-28

## Implemented source contract

`agent.register` and every `agent.presence` use the same
`runtimeCapabilities.capabilityContractVersion = 1` payload.

- Default `fastChatEnabled=false`, `appServerEnabled=false` reports CHAT as
  `supported=true`, `enabled=false`, with no `toolPolicy` claim.
- CHAT is `enabled=true` and declares `toolPolicy=read-only-constrained` only
  for the existing app-server/read-only/network-disabled configuration.
- `strictNoToolsVerified=false` is explicit. This does not assert that the
  Provider proves a strict no-tools boundary.
- INSPECT remains `supported=false`, `enabled=false`, with
  `fixed-manifest-provider-isolation-not-verified`; no fixed-manifest Provider
  run was performed or claimed.
- EXECUTE remains `supported=false`, `enabled=false`. Existing PRIVATE/TASK
  compatibility, durable `chat.dispatch.ack`, and configured native START stay
  under `legacyCompatibility`, not new orchestration capability.

Fixture: `test/fixtures/u0-runtime-capabilities-v1.json`.

## Verification

- Initial targeted Node invocation did not begin tests because this isolated
  worktree lacked the declared `yauzl` dependency (`ERR_MODULE_NOT_FOUND`).
  `npm ci --ignore-scripts --no-audit --no-fund` restored the lockfile-pinned
  local dependencies.
- `node --test test/agent-client.test.mjs`: PASS, 116 tests, 0 failures.
- `node --test test/config-runtime.test.mjs`: PASS, 34 tests, 0 failures.
- No Provider, paid model, production connection, deployment, or native START
  request was executed by this work item.

## Contract handoff / unresolved boundary

The API target matcher should require `profiles[profile].supported === true`
and `enabled === true`; it must not treat `legacyCompatibility` as permission
for new orchestration. The concrete INSPECT wire manifest is intentionally not
introduced here: its exact fields and a Provider-isolation fixture remain
blocked on the cross-repository U0 contract freeze.
