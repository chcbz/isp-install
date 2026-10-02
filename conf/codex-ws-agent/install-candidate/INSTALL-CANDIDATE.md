# `wuyong` dual-mode install candidate

This directory is an inert, redacted candidate for one existing `wuyong` identity. It does not create or bind an identity, issue a controlled-image binding, install a release, restart a service, or call a Provider. The existing persona binding `1` is identity evidence only and **must not** be used as the controlled-image provider binding. Persona bindings `1`, `2`, and `15` are rejected by the checker.

## Freeze inputs

Main and the API configuration Owner must separately freeze every placeholder before installation:

- existing `wuyong` agent ID, private Codex home, workspace/API origin, and WebSocket URL;
- separately issued controlled-image HTTPS origin, model ID, binding ID, and positive decimal binding epoch;
- exact API tenant/client/owner/target-agent policy, custody, issuer, revision, expiry, and the same model/binding tuple;
- private `0600` values for `OPENCLAW_API_KEY` and `CYF_CONTROLLED_IMAGE_API_KEY`.

Do not place either secret in the profile, freeze JSON, registration capture, or logs. `producerRequestRevision` is server-owned under API contract commit `9ab62d6665c695a574b8b3bde9cfff3ea3ca13d4`; the Client profile, declaration, command, and freeze must not add or override it.

The template's typed-inspection values are fixed to the accepted evidence: provider `gpt`, `https://codex.chcbz.net/v1`, model `gpt-5.6-terra`, restricted proxy, `/etc/pki/tls/certs/ca-bundle.crt`, profile/engine IDs, carrier evidence digest, and the `LOCAL_IMAGE` contract digest. `normalizeProfile` and the production declaration builders are used by `install-candidate-check.mjs`; no mock loader or hard-coded PASS is used.

## Client/API correspondence

| Capability | Client profile/evidence | Registration/presence | API policy/authority |
| --- | --- | --- | --- |
| INSPECT | `typedInspection*`, accepted carrier evidence file/digest, CA file bytes, `appServerEnabled=true` | `typedInspection.enabled=true`, exact profile/engine/policy/input declarations | authenticated agent registration and workspace-file access remain server-authorized |
| GENERATE_IMAGE | controlled endpoint/key env/model/binding/epoch/ledger; native HTTP poll on and generic native image executor off | V3 operation `GENERATE_IMAGE`, 0–16 `TASK_LINKED_WORKSPACE_VERSION` JPEG/PNG inputs | exact operator-policy tenant/client/owner/target/provider/model/binding tuple; consent/grant and source snapshot remain server authority |
| EDIT_IMAGE | same controlled provider tuple | V3 operation `EDIT_IMAGE`, exactly one `CURRENT_CONVERSATION_ASSET` JPEG/PNG input | API resolves and revalidates the authorized archive revision immediately before execution; Client never sends `producerRequestRevision` |

Fixed fences are provider lane `CONTROLLED_IMAGE_HTTP_V1`, max inputs `16`, max outbound attempts `1`, and precall fence `1`. API scheduling/consent/grant/policy is authoritative; registration and presence only advertise the live Client's measured readiness.

## Stable payload freeze (no Provider request)

Run from the exact source checkout against the exact collated release and installer used to create it. The output path must not already exist:

```bash
node conf/codex-ws-agent/install-candidate/install-candidate-check.mjs verify-template
node conf/codex-ws-agent/install-candidate/install-candidate-check.mjs freeze \
  --profile /private/codex-profiles.private.json \
  --env-file /private/wuyong-dual-mode.env \
  --api-policy /private/controlled-image-api-policy.frozen.json \
  --release /private/collated-release \
  --installer shell/codex_ws_agent_install.sh \
  --source-commit "$SOURCE_COMMIT" \
  --source-tree "$SOURCE_TREE" \
  --output /private/wuyong-dual-mode.freeze.json
chmod 0600 /private/wuyong-dual-mode.freeze.json
```

The checker verifies every `release-manifest.sha256` entry byte-for-byte, release provenance/integrity, installer digest, source commit/tree, normalized non-secret profile and minimal environment, secret-reference names, CA bytes, carrier-evidence bytes, complete API properties, and exact declarations. The freeze digest excludes secret bytes, release-root paths, runtime instance IDs, process IDs, random ports, timestamps, nftables counters, and request/turn IDs. Thus another process using the identical source, payload, profile, policy, CA, and evidence has the same contract digest; native isolation remains a per-execution check and is not replaced by this freeze.

## Post-start readback checklist (zero Provider calls)

1. Confirm exactly one owned runtime is live for the frozen agent ID; do not stop or alter a foreign runtime.
2. Read back `current`, `release-provenance.json`, `release-manifest.sha256`, and `release-integrity.sha256`; run `sha256sum --quiet -c` for both manifests and compare source commit/tree and installer/payload digests with the freeze.
3. Under the private environment, run `node current/agent-client.mjs --inspect-config` and `node current/agent-client.mjs --validate`. Capture redacted output only; neither command may register, poll, or call the Provider.
4. Start only through the separately authorized service action. Capture the authenticated `agent.register` and subsequent `agent.presence` payloads without credentials, commands, grants, source payloads, or secret headers.
5. Verify both captures against the freeze:

   ```bash
   node current/install-candidate/install-candidate-check.mjs readback \
     --freeze /private/wuyong-dual-mode.freeze.json \
     --registration /private/agent-register.redacted.json \
     --presence /private/agent-presence.redacted.json
   ```

   PASS requires one matching runtime instance and exact enabled INSPECT, provider binding, GENERATE_IMAGE, and EDIT_IMAGE declarations. Any drift fails closed.
6. With an authenticated read-only API credential, capture `GET /agent/capabilities` and `GET /agent/tasks/{taskId}/point-and-start-controlled-image-capability?targetAgentId={frozenAgentId}`. Verify the registered target and exact policy tuple. Before explicit execution consent/grant, the task capability must remain consent-required/not executable and `paidExecutionAuthorized=false` (or the exact equivalent in the frozen API contract).
7. Verify bootstrap created no command, lease, turn, Provider HTTP call, result, or ledger execution entry. Do not use a generation/edit call as a readiness check.

Do not call readiness complete until the placeholders are frozen, the installed hashes match, the authenticated API accepts the registration, both live declarations match this freeze, and the API policy readback names the same target/provider/model/binding tuple.
