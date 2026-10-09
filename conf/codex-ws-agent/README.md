# Runtime execution library

This directory supplies the execution library used by `conf/cyf-agent-runtime-v1`.
It is not an independently runnable Agent service. Use the unified Runtime guide
in `../cyf-agent-runtime-v1/README.md` and its existing installer/host JSON entry.

As of 2026-10-09 the retired environment/INI profile loader, API-key installation
templates, old launcher/installer stubs, dual-mode candidate checker and historical
HTTP diagnostics have been removed. Explicit Runtime profiles and per-subject
manifest/session authentication are the supported configuration path.

The execution, CHAT, workspace, current capability and ACK implementations remain.
`migrate-ack-high-water.mjs` is still referenced by the separate active ACK task;
it is excluded from the installed execution payload, not automatically executed.

## Retained implementation notes

The following notes describe retained code, not additional UR06 delivery gates.
The offline ACK migration belongs to its existing separate workstream; new-task
acceptance does not require migrating historical state.

### Controlled-image v3: retain produced bytes when delivery is uncertain

After a validated PNG returns, the v3 lane writes `delivery/output_1.png` and then
`delivery/receipt.json` inside its private run directory, fsyncing the files and
directories before upload. The receipt binds the exact command, Agent, API origin,
byte length and SHA-256; it contains no runtime credential. Directories are 0700,
files 0600, and existing/symlink destinations are rejected rather than overwritten.

Upload errors, lost/mismatched commit acknowledgements, expired leases and local
persistence errors retain the run for investigation. A transport error after an
image was produced is not reported as an ordinary execution failure. Only a
validated commit acknowledgement permits normal run-directory cleanup.

Retention is **not** automatic recovery: no Provider call is retried, no paid claim
is deleted, and the receipt grants no API authority. The current start lease/inbox
cannot reclaim a provider-started execution. A separately authorized result-only
recovery contract is required for retransmission after restart or lease expiry.
Images deleted by older clients cannot be recreated from the claim or receipt.

## ACK high-water checkpoints (format 2)

The ACK queue remains file-backed, strictly FIFO and protected by the existing
cross-process sequence lock. Sending stops at the first unsuccessful ACK; durable
quarantine prevents every instance from allocating or sending further ACKs.

High-water evidence no longer creates a file for every allocated sequence:

- `ack-sequence-high-water/initialized.json`: private, checksummed Agent/storage identity.
- `ack-sequence-high-water/checkpoint.json`: independent, checksummed high-water witness.
- `ack-sequence.json`: counter/commit fence, which must match the witness exactly.
- `ack-sequence-high-water/intent.json`: at most one active transaction, removed durably after commit.

An enqueue holds the existing lock throughout: validate health/evidence → persist
an intent containing the exact ACK and old/new checkpoints → persist the new
witness → persist the ACK → advance the independent counter/commit fence → remove
the intent. Every file publication fsyncs its contents and containing directory.
Only exact reachable transaction prefixes are recovered. Missing or inconsistent
evidence is quarantined; there is no “take the maximum” or old-checkpoint fallback.
A leftover/restored committed intent does **not** recreate a dequeued ACK.
Checksums detect integrity faults, not adversarial rewriting or authenticated history.

Healthy high-water storage retains two small files, plus the counter outside that
directory; space no longer grows with the number of already-sent ACKs. Actual pending
ACKs, quarantine and superseded records have separate lifecycles and are not purged.
Secure temporary evidence left by interrupted writes is cleaned under the lock after
successful initialization. Startup/runtime checks read fixed-size high-water evidence;
existing pending-queue scans remain proportional to the actual pending ACK count.

### Explicit offline migration

Format 1 is not a supported runtime mode. A new binary reports
`ACK_OUTBOX_MIGRATION_REQUIRED` until its profile has been explicitly converted.
Do not run the installer/restart an active deployment before planning this conversion.

1. Identify the exact profile storage root and Agent identity. Drain/stop **all** its
   writers under the release's maintenance authorization; do not hot-reload a busy
   profile or stop a foreign service. A stale lock is never stolen: reconcile its
   exact owner separately before migration.
2. Run the migration from the pinned new release with a unique backup path **outside**
   the profile storage root. Replace every placeholder with an authorized target:

   ```bash
   node /absolute/path/to/new-release/migrate-ack-high-water.mjs \
     --root-dir /absolute/path/to/stopped-profile-storage \
     --agent-id '<exact-agent-id>' \
     --backup-path /home/isp/baks/ack-high-water/<profile>-<release>.jsonl.gz
   ```

3. The tool validates all legacy markers, identity, counter, pending filenames and
   duplicate/future sequences. It streams a compressed complete high-water backup,
   syncs and verifies it, then publishes a migration intent. It never overwrites an
   existing backup. The existing pending ACK bytes remain unchanged.
4. The tool writes the new checkpoint/counter/identity, then removes only validated
   legacy high-water markers covered by the backup, synchronizes the directory once
   for the completed deletion batch, and finally removes the intent.
   It does not change production configuration, activate a release, send ACKs, or restart
   a service. Its JSON result records the high-water, marker count and backup digest.
5. If interrupted, keep the stopped state and rerun the **same** command/backup path.
   Runtime refuses an unfinished migration; the offline tool verifies the archive and
   exact commit/cleanup prefix before resuming. Never manually delete the intent or
   repair a disagreement by choosing the highest value.
6. After a successful migration, verify the exact new release/profile, empty intent,
   matching counter/witness and pending FIFO before authorized activation. Do not
   restart an older binary against format 2. Restoring a backup requires a separate
   stopped-writer recovery plan covering both code and complete related runtime state;
   never restore the counter alone. Backup retention/offloading/deletion is a separate
   authorized operation.

Like the old per-sequence format, local evidence cannot detect a coordinated rollback
of the entire storage to a coherent earlier snapshot after process restart. That
stronger guarantee requires an independent trusted witness (for example on the server).
An initialized instance does reject a rollback relative to its observed high-water.

Targeted regression command (disposable fixtures only):

```bash
node --test /absolute/path/to/source/conf/codex-ws-agent/test/ack-checkpoint.test.mjs \
  /absolute/path/to/source/conf/codex-ws-agent/test/agent-client.test.mjs
```
## Managed native CHAT activation

`AGENT_MANAGED_CHAT_SCOPES_FILE` points to a canonical private operator-owned JSON
file: `{ "schemaVersion": 1, "authorizations": [...] }`. Each authorization has
exact `tenantId`, `clientId`, `ownerJiacn`, `agentId`, `generation`, `profileId`,
and a supported `appServerSchemaContractId` bound to the measured native version.
Only this exact managed identity receives native CHAT/typed controls; other
managed identities do not inherit global CHAT activation. CHAT cwd is allocated
from the managed profile identity, not copied from a template. A scope enables
measurement, not READY: the installed binary/schema and initialized adapter
still determine readiness. This does not enable INSPECT or image generation.


### 原生 API 单一地址（2026-10-06）

接应程序的 `workspaceFileApiOrigin` 是所有原生 HTTP lane 的唯一 API 地址，包含任务文件、受控执行和 INSPECT 资料读取；由操作员的来源 profile 配置，managed profile 不得覆盖。复用相同 origin 校验：远端 HTTPS，或同机显式 loopback HTTP；不含凭据、路径、query 或 fragment，不硬编码端口，不通过公开业务 proxy 暴露 `/internal`。

精确 managed CHAT scope 的 `inspection` 只包含身份授权下的输入/状态目录、测量 profile、provider 和 carrier policy，不再包含 `apiOrigin`。旧独立字段 `inspection.apiOrigin`、`typedInspectionApiOrigin` 必须移除，不能双轨兼容。既有 private roots、AgentRuntime 身份与manifest/字节完整性、provider HTTPS及隔离测量不变。

### INSPECT 模型启动前失败恢复（2026-10-06）

收到 durable ACK 的原 dispatch 不依赖服务端重新派发。客户端启动/恢复时，仅对明确 `CHAT_FAILURE`、`RECOVERY_REQUIRED` 且没有 preparation/engine/final 及其时间证据的 INSPECT 原记录，在 profile lock 内核对原 key/fingerprint 后转为 processing，沿原身份重新测量、读取及校验资料。`markPrepared` 在 thread/start 与 turn/start 前同步持久化，因此这条路径不重跑已经启动的模型。每个客户端进程对同 key 仅尝试一次，不因反复 resume 盲重试。

已有 preparation/engine、未知 acceptance 或进程中断状态禁止重新启动；已有 final 只恢复原最终消息发布/服务端持久确认。不得手工移动 inbox 文件、重置数据库 outbox 或新建业务请求替代恢复。

INSPECT 测量完成会触发携带最新声明的重新注册。读取资料和恢复引擎前必须等待当前精确 registration ACK；旧 ACK、presence 和仅本地测量成功均不能释放原生读取。慢 ACK 继续等待，不增加强制业务 deadline；拒绝/断线/发送失败则关闭此路径。资料 GET 非200只记录 HTTP 数字状态，不读取或输出错误正文、凭据。

INSPECT 的 v3 原生输出 schema 进一步固定 `deliverable=false`、`deliveryRelation=null`，不把资料读取回复关联成可验收成果。模型终态返回后，即使成果关联/其他严格校验拒绝回复，也必须保留原私有引擎状态供只读核对，不得在 finally 删除唯一终态，再用新模型 turn 补偿。历史已被删除的引擎状态不可能由本修复补回；缺少原终态时不能伪造成功。

恢复只允许打开已存在且有精确 binding marker 的原引擎目录。原目录/marker 缺失时返回 `TYPED_INSPECTION_RECOVERY_STATE_MISSING`，不重建目录、不复制新凭据、不启动新 adapter 或模型 turn；必须另行安排明确的全新验证请求，不能冒充原 turn 的终态恢复。
