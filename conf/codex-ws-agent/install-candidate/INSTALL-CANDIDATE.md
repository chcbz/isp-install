# Historical `wuyong` dual-mode policy/provenance candidate — NOT an installer

This directory is an inert, redacted candidate for one existing `wuyong` identity. It does not create or bind an identity, install a release, restart a service, or call a Provider. An existing persona binding is identity evidence only and is not controlled-image credential-binding evidence. Numeric values are not globally unique across namespaces, so the checker does not blacklist historical IDs. The controlled-image `bindingId` and positive decimal `bindingEpoch` are platform Operator-selected configuration fences: no upstream Provider binding-issuance API or external binding object is required. Evidence remains `UNVERIFIED` when only the Client/API declarations exist.

## Current installation entry

This is historical audit/provider-policy data, **not** the latest Agent installation
procedure. The old broker, standalone engine launcher and unit source entries are
retired. New installations use `shell/cyf_agent_runtime_v1_install.sh` and
`conf/cyf-agent-runtime-v1/README.md`, explicit sealed multi-Agent configuration
and per-installation enrollment. Never restore old API-key authentication, infer
new authority from a persona, or automatically adopt/replay old queues.
The checker remains a read-only historical validator and is not packaged in the
unified Runtime artifact. Its existing static provider-contract/provenance tests
use a labelled test-only historical catalog, not a working old installer.

## Historical freeze inputs (audit only)

Main and the API configuration Owner must separately freeze every placeholder for historical evidence validation (not new installation):

- existing `wuyong` agent ID, private Codex home, workspace/API origin, and WebSocket URL;
- controlled-image HTTPS origin and exact model ID supplied by the Provider/account custodian;
- platform Operator-selected binding ID and positive decimal binding epoch, changed when the local credential/configuration fence is rotated;
- exact API tenant/client/owner/target-agent policy, custody, issuer, revision, expiry, and the same model/binding tuple;
- historical private Agent credential references (audit only, never new Runtime authorization), separately from controlled-image Provider credential references.

Do not place either secret in the profile, freeze JSON, registration capture, or logs. `producerRequestRevision` is server-owned under API contract commit `9ab62d6665c695a574b8b3bde9cfff3ea3ca13d4`; the Client profile, declaration, command, and freeze must not add or override it.

The template's typed-inspection values are fixed to the accepted evidence: provider `gpt`, `https://codex.chcbz.net/v1`, model `gpt-5.6-terra`, restricted proxy, `/etc/pki/tls/certs/ca-bundle.crt`, profile/engine IDs, carrier evidence digest, and the `LOCAL_IMAGE` contract digest. `normalizeProfile` and the production declaration builders are used by `install-candidate-check.mjs`; no mock loader or hard-coded PASS is used.

## Static scope and Client/API correspondence

`verify-template` and `freeze` return `STATIC_VALID` only. Their enabled declarations are a **synthetic expected registration projection** produced through the production declaration builders with static stand-ins; they do not measure a live executor, poller, credential, socket, isolation run, or runtime readiness. Only post-start authenticated registration and presence readback can establish that the live process emitted the expected shapes.

`controlled-image-api-policy.redacted.json` is deliberately marked `CONTROLLED_IMAGE_PROVIDER_PARTIAL_POLICY` and `fullInstallationReadiness=false`. It freezes only the provider-lane flags and exact operator policy represented by this Client handoff. It is not the complete product/API installation policy: formal-artifact, conversation-archive, selected-output, schema, exact API artifact/config, and full acceptance evidence remain required from Main/API owners and must not be inferred from this partial artifact.

## Client/API correspondence

| Capability | Client profile/evidence | Registration/presence | API policy/authority |
| --- | --- | --- | --- |
| INSPECT | `typedInspection*`, accepted carrier evidence file/digest, CA file bytes, `appServerEnabled=true` | `typedInspection.enabled=true`, exact profile/engine/policy/input declarations | authenticated agent registration and workspace-file access remain server-authorized |
| GENERATE_IMAGE | controlled endpoint/key env/model/binding/epoch/ledger; native HTTP poll on and generic native image executor off | V3 operation `GENERATE_IMAGE`, 0–16 `TASK_LINKED_WORKSPACE_VERSION` JPEG/PNG inputs | exact operator-policy tenant/client/owner/target/provider/model/binding tuple; consent/grant and source snapshot remain server authority |
| EDIT_IMAGE | same controlled provider tuple | V3 operation `EDIT_IMAGE`, exactly one `CURRENT_CONVERSATION_ASSET` JPEG/PNG input | API resolves and revalidates the authorized archive revision immediately before execution; Client never sends `producerRequestRevision` |

Fixed fences are provider lane `CONTROLLED_IMAGE_HTTP_V1`, max inputs `16`, max outbound attempts `1`, and precall fence `1`. API scheduling/consent/grant/policy is authoritative; registration and presence only advertise the live Client's measured readiness.

`bindingEpoch` is an exact positive-long equality fence, not an externally issued Provider version. The Client and API do not generate it or prove monotonicity; the Operator freezes one value in both configurations and changes it on a relevant rotation so stale consent/start state no longer matches.

### Controlled image HTTP compatibility contract

The configured endpoint is an HTTPS origin only. The production adapter appends `/v1/images/generations` or `/v1/images/edits` and sends Bearer-authenticated `application/json`. Generation sends `model`, `prompt`, `n: 1`, and `output_format: "png"`. Editing additionally requires JSON `images: [{"image_url":"data:image/...;base64,..."}]`; a Provider that only supports multipart image edits is not compatible with this adapter. The direct, non-redirected 200 response must contain exactly one canonical PNG in `data[0].b64_json`.

This is not the Responses understanding contract. Static validation, model-list output, or a successful understanding request does not establish generation/edit compatibility; that remains unclaimed until supported by Provider contract evidence or a separately authorized real request.

### Independent Operator freeze evidence

`VERIFIED` is allowed only when `sourceType` is `API_OPERATOR_POLICY_FREEZE_FILE` and `freeze` receives `--operator-binding-freeze FILE`. The checker reads that regular non-symlink file, hashes its actual bytes, requires the digest and internal `sourceReference` to match the policy candidate, and compares its exact tenant/client/owner/target/lane/binding/epoch/model/custody/issuer/revision/expiry/attempt tuple with the API properties. The file is a non-secret platform Operator configuration freeze, not an upstream receipt and not a new signing requirement. Arbitrary non-empty source labels or a claimed SHA without the file cannot become `VERIFIED`.

The independent file has exact top-level keys `schemaVersion`, `artifactType`, `sourceContractCommit`, `sourceReference`, and `operatorPolicy`; `artifactType` is `CONTROLLED_IMAGE_OPERATOR_BINDING_FREEZE_V1`. If that independently owned file is unavailable, keep all three source fields null and status `UNVERIFIED`.

## Historical freeze and readback are not current install evidence

Retain historical manifests, source/installer hashes, non-secret provider tuples,
independent Operator freeze evidence and redacted registration/presence captures
as audit records. The checker can prove consistency of those historical records;
it cannot enroll an installation, prove current session/fence ownership or accept
a new Runtime release. No runnable legacy installation, engine CLI validation,
service start or API-key readback procedure is prescribed here.

The current unified installer excludes these tools/templates and fails if they
are reintroduced into its execution payload. New readiness comes from the current
installation-derived authenticated channel, actual adapters and durable state,
not a historical STATIC_VALID/READBACK_MATCH or heartbeat. Main/runner must still
verify actual Java/D06/DB/native/skill boundaries and fixed commit/Flow artifacts.
Provider calls, paid business, production credential/state migration and old unit
retirement require separate exact authorization; no such operation was performed.
