# 聚义厅「自家接应」：统一 Runtime 安装、登记与升级

> 2026-10-26：源码候选Runtime1.3.11/bridge1.1.5内部目录改为codex-bridge；本节新路径不代表旧主机已迁移。线上1.3.10仍使用codex-ws-agent，必须受控安装新制品并核验后再更新主机记录。不可直接mv运行目录、沿用旧绝对路径venv或迁移业务state。

核对：**2026-10-20**。本次仅更新安装/升级流程与目录约定；核对源码为 `2f0518de38eef3b33dc6498865c35f266133a7e6`，覆盖安装器、Runtime 入口、systemd/环境模板、托管控制说明及执行引擎配置校验。该提交的 Runtime `package.json` 声明为 **1.2.0**；包版本、制品目录名、CYF Web/API 版本不是同一版本标识，不相互推断。

本文不是最新发布清单，也不证明目标主机已经安装或验收。每次操作固定实际候选 commit/tree、制品路径/摘要、原安装基线和验证证据；远端未查询时不声称本地 HEAD 是远端最新。2026-10-12 的 1.0.3 接入与目录迁移结论只保留为历史范围，不作为新版本兼容性证明。

本指南对应新版自家接应文书。如果线上仍显示旧 API Key、`.env` / `codex-profiles.conf`，说明页面尚未发布此改动：**不要照旧页面操作，也不要把本仓更新当成网站已更新**。由服务端所属账号操作者通过下述已有接口登记；目标端无需等待后台“签发 manifest”。

## 1. 谁负责什么

| 执行方 | 工作 |
|---|---|
| 所属用户 / 聚义厅 | 在正确业务区域登录，绑定或查看已绑定角色；提供真实 scope；显式登记目标机生成的非秘密请求 |
| 目标机操作人 / Agent | 安装新制品，生成 manifest 和一次性密钥，准备配置，enroll，获授权后切换服务 |
| CYF 服务端 | 以登录用户 JWT 的 tenant/client/owner 校验角色归属，保存登记摘要；enroll 成功才返回安装授权 |

`ownerJiacn` 是所有者，不是 tenant。不能从历史任务的 tenant、机器目录名或角色名猜身份。旧 API Key 不能代替用户登录授权或新 installation 授权。不要在聊天、浏览器导入文件或普通日志传递密钥/JWT。

**两种情况分开：**
- 旧 `codex-ws-agent` 首次转入统一 Runtime：先查是否已有新 installation；没有才按下文登记/enroll，保留角色绑定，不除名再入伙。
- 已有统一 Runtime 升级：沿用原 manifest、installation、hostId、状态及授权，跳过第3～4、6节的首次注册，不重复生成身份。

已有统一Runtime仅做目录收口时，按第9节完整迁移本角色HOME与路径索引，仍不重新登记。

本次不迁移历史协议队列，不做旧版本双轨兼容。备份旧状态；执行中、结果未知的业务须逐项说明处置，不能清队列、重放扣费请求或虚报完成。共用 Runtime 的其他 Agent 也受进程切换影响，先确认影响范围。

## 2. 固定源码并准备新制品

先记录真实旧服务的 `systemctl cat <旧服务>`、运行用户、ExecStart/cwd、配置/状态目录；不要猜服务名。检查磁盘、目标平台、Node/npm/Python 和 Codex CLI 是否可执行。Node 无项目版本白名单，记录实际版本；依赖仍须真实适配。Python 3.11.13 为已验证基线，不代表任意架构天然通过。

优先复用与目标平台、固定源码及本次候选精确匹配的已验证制品；没有匹配证据才准备新制品。不得把历史安装成功当本次验证，也不覆盖正在运行的程序目录。以下只示例目标端制品准备，不授权 CYF 前后端本地生产构建/发布；CYF 前后端仍遵守项目 Flow 规则。

先记录候选信息（占位值必须替换）：
```bash
REPO=/absolute/path/to/isp-install
SOURCE_COMMIT='REPLACE_WITH_VERIFIED_FULL_COMMIT_SHA'
# 在独立干净源码目录固定候选，不在他人工作区 checkout/reset。
test "$(git -C "$REPO" rev-parse HEAD)" = "$SOURCE_COMMIT" || exit 1
test -z "$(git -C "$REPO" status --porcelain)" || exit 1
git -C "$REPO" rev-parse HEAD HEAD^{tree}
RUNTIME_VERSION='REPLACE_WITH_RUNTIME_PACKAGE_VERSION'
ARTIFACT="/home/isp/apps/cyf-agent-runtime-v1/app"
# 仅适用于该目录尚不存在；已有安装按§2.1/§7.1先停写归档，不覆盖运行目录。
# 管理员只在必要时创建父目录并授权给真正的运行用户，不递归chown共享目录。
# ARTIFACT须为不存在的canonical绝对路径；制品不可直接覆盖运行目录。
bash "$REPO/conf/cyf-agent-runtime-v1/install.sh" \
  --target "$ARTIFACT" --node /absolute/path/to/node \
  --npm /absolute/path/to/npm --python /absolute/path/to/python3.11
"$ARTIFACT/runtime/validate.sh" --root "$ARTIFACT"
git -C "$REPO" rev-parse HEAD
```

安装器只准备 `runtime/`、`codex-bridge/`（内部执行引擎）、`node/bin/node` 及完整私有依赖。**不安装/启用 systemd、不登记、不迁移配置或状态。** 不借宿主 Python 包掩盖私有环境缺失。记录制品目录、源码SHA、安装回执及摘要，平台工具链验收失败应先归因。

### 2.1 CYF固定程序目录、发布记录与历史归档（2026-10-23）

本节按CYF项目授权更新目录策略；不自动迁移其他主机或修改全局规则。

```text
/home/isp/apps/cyf-agent-runtime-v1/
  app/                                    # 唯一实体程序；新候选为runtime/、codex-bridge/、node/
  release-records/                         # 当前与历史版本/源码/摘要/验证记录
  RELEASES.md                             # 与实际服务/PID一致的当前说明
/home/isp/baks/cyf-agent-runtime-v1/<归档批次>/ # 历史程序、停写状态快照、恢复信息
```

- 不使用版本号、功能名或日期作为现用程序目录，也不新增按版本切换的`current`链接。“最新”是获授权且验收启用的候选，不自动追踪远端；版本号、源码commit/tree、依赖锁与制品SHA仍须完整记录，程序行为变化须升版。
- 安装器仍拒绝覆盖已存在的目标，不负责停止服务、登记或迁移状态。统一组件入口默认准备`app/`；其他目标必须显式指定且为不存在的canonical实体目录。已有`app/`升级时先在独立位置准备候选，按§7.1完成停写、完整备份并归档旧程序，才能安装至固定目录。
- 复用已验证制品迁移路径时，先核验来源清单和文件摘要，再用`python3 shell/cyf_runtime_toolchain_rebase.py --root /absolute/candidate --from-root /absolute/original`只读检查；仅在已停写且独占候选时加`--apply`。工具只更改已识别的Python venv生成路径；未知引用/符号链接拒绝，不改源代码或业务状态。随后使用候选`runtime/validate.sh`验证完整依赖闭包及实际配置；不能只搬目录假定可用。
- 路径迁移不伪造业务代码升级：保留原Runtime版本及源码来源，另记录安装转换、工具源码commit、变更文件前后摘要及新制品清单。重新构建或改变程序行为仍须按真实候选升版、验证。
- systemd固定`app/`真实路径，不跟随可变链接；保留原User、EnvironmentFile、停止策略及无关drop-in修复。归档批次按时间/任务区分，不以版本号作为目录名；归档记录原路径、真实版本/来源/摘要。历史记录保留原事实，另补归档位置，不将旧证据重标为当前验收。
- 配置、manifest/installation、HOME、会话、ACK、锁和业务状态不是旧程序，不能按只留最新清除或以旧快照覆盖新事实。停写快照须覆盖启用的managedRoot与各角色完整HOME。回退前核对状态兼容性，走受控恢复安装，不直接启动备份目录或重建身份。
- 历史目录仅在停用、进程/服务/外部引用核验完成后归档；`current`仅在新固定路径启用验证后移除。存在未迁移状态的混合目录只归档明确的程序文件，保留状态/身份路径，不整目录搬走。
- 本指南源码适配不等于主机已迁移；每台主机分别记录安装执行、Run（如适用）、通道健康与业务验收。本次目录迁移不授权付费模型调用或API/Web发布。

## 3. 目标端准备登记材料（首次接入）

从本人「自家接应」文书取得 `tenantId/clientId/canonicalAgentId`。当前后端 local bind 复用的 Scope 仍限制 tenant `0`；以下工具不猜租户、也不解除服务端该限制。多区域绑定尚需单独实现。

以下变量均为**非秘密值**，由操作人替换；命令以最终 Runtime 运行用户执行。配置、状态与制品分离。新安装使用第5节的统一目录，不将HOME留在旧客户端部署目录。

```bash
export REPO=/absolute/path/to/isp-install
export ARTIFACT=/absolute/path/to/verified-artifact
export CFG=/home/isp/conf/cyf-agent-runtime-v1
export SUBJECT=your-local-profile-name
export TENANT_ID='从文书复制'
export CLIENT_ID='从文书复制'
export AGENT_ID='从文书复制'
umask 077
# CFG需已由管理员正确授权给运行用户，且不可有symlink或group/other写权限。
export CANDIDATE="$CFG/$SUBJECT-enrollment"
# 示例有效期2小时，单位毫秒；它是凭据有效期，不是业务执行deadline。
EXPIRES_AT=$("$ARTIFACT/node/bin/node" -p 'Date.now() + 2 * 60 * 60 * 1000')
"$ARTIFACT/node/bin/node" "$REPO/shell/cyf_runtime_enrollment_prepare.mjs" \
  --tenant-id "$TENANT_ID" --client-id "$CLIENT_ID" --agent-id "$AGENT_ID" \
  --output "$CANDIDATE" --expires-at "$EXPIRES_AT"
```

工具离线运行，拒绝既有输出目录和symlink路径；不会申请安装、写数据库、enroll或切换服务。生成文件均0600、目录0700：
- `manifest.json`：正式身份文件；`manifestSha256` 为 `sha256:` 前缀加递归排序 JSON 摘要。
- `enrollment-secret`：一次性密钥，**只留目标机**，不要打印或上传。
- `installation-request.json`：已有登记接口的6字段请求体，两个摘要均为64位小写hex、**不带** `sha256:`。
- `handoff.json`：`{scope:{tenantId,clientId,canonicalAgentId},request:{…}}`，可交给账号持有人导入新版页面，不包含明文密钥。
- `subject-key.txt`：Runtime `--subject` 参数，不能用 Agent ID 代替。

同批材料需一起保留，不能替换manifest或secret后继续用旧摘要。工具失败留下的目录不可当成功制品；检查结果后使用明确的新目录，勿盲删旧授权。

## 4. 本人授权登记及查询

新版聚义厅「自家接应」文书导入 `handoff.json`，核对业务区域和Agent后，明确点击**登记安装**。页面只发送六个request字段，tenant/client/owner仍取当前登录授权；目标机无需获取该用户JWT。

服务端已有接口（不是新增旁路）：

```text
POST /agent/runtime/v1/installations         # 本人JWT；请求体为installation-request.json
GET  /agent/runtime/v1/installations/{id}    # 本人JWT；只读查询
POST /agent/runtime/v1/enroll               # 由目标端CLI调用，不手工向浏览器提供密钥
```

创建请求字段：`installationId, canonicalAgentId, manifestVersion, manifestSha256, enrollmentSecretSha256, enrollmentExpiresAt`。`manifestVersion="1"`，`enrollmentExpiresAt` 为未来毫秒时间。身份必须与本人当前绑定一致。

- 预期创建结果为 `PENDING`。这只是登记成功，**不是上线**。
- 请求超时或响应未知：先用同一ID查询，不重复创建，不另起installation蒙混通过。
- 查询 `ACTIVE`：已enroll，不再消费同一secret；核对目标机授权文件后进入服务阶段。
- 403/归属不符：修正登录账号/区域，不能修改tenant冒充。404只说明当前请求范围查询不到，不能据此认定全局不存在。
- secret过期或已消费但目标机丢失授权：停止尝试同一secret，核对原installation，由所属用户按正式撤销/重新登记流程恢复，不自动轮换。

如果页面尚未发布，由已有合法登录上下文的服务端操作者发送同一6字段请求；不在聊天索取JWT、不用旧API Key、不直接INSERT数据库。

## 5. 配置 host、profile 和独立状态

原已接入Runtime升级：优先保持已核验配置与状态。本节为首次单Agent配置示例，须替换真实路径、CLI、模型。不能照抄别人的Codex Home或凭据。

```bash
export STATE=/home/isp/state/cyf-agent-runtime-v1/your-instance
export CODEX_BIN=/absolute/path/to/codex
export CODEX_HOME_PATH="$STATE/agents/$SUBJECT/codex-home"
export CODEX_MODEL='该账号实际可用模型'
export API_ORIGIN=https://api.chaoyoufan.cn
export INSTANCE=your-instance
export HOST_ID='本机持久唯一的host标识'
# STATE父目录应先由管理员授权。运行用户创建，勿覆盖已有目录/配置。
mkdir -m 700 -p "$STATE/host" "$STATE/agents/$SUBJECT/runtime" "$STATE/agents/$SUBJECT/workspace" "$STATE/agents/$SUBJECT/private-runs" "$CODEX_HOME_PATH"
# CODEX_HOME_PATH使用本角色独立的合法Codex凭据/配置，CLI先完成正常登录检查。
"$ARTIFACT/node/bin/node" --input-type=module <<'JS'
import {writeFile} from 'node:fs/promises';
const e=process.env;
for(const k of ['CFG','SUBJECT','CANDIDATE','STATE','CODEX_BIN','CODEX_HOME_PATH','CODEX_MODEL','API_ORIGIN','INSTANCE','HOST_ID','AGENT_ID'])
  if(!e[k]) throw Error('Missing '+k);
for(const k of ['SUBJECT','INSTANCE']) if(!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(e[k])) throw Error('Unsafe '+k);
if(e.CODEX_HOME_PATH !== `${e.STATE}/agents/${e.SUBJECT}/codex-home`) throw Error('New setup requires the canonical subject HOME');
const profile={profileId:e.SUBJECT,agentId:e.AGENT_ID,codexBin:e.CODEX_BIN,
  codexHome:e.CODEX_HOME_PATH,codexWorkdir:`${e.STATE}/agents/${e.SUBJECT}/workspace`,
  codexModel:e.CODEX_MODEL,codexSandbox:'workspace-write',codexApproval:'never',codexSessionMode:'new',codexTimeoutMs:0,
  chatEngine:'app-server',appServerEnabled:true,fastChatEnabled:true,trueDeltaEnabled:true,typedDeliberationEnabled:true,
  chatModel:e.CODEX_MODEL,chatSandbox:'read-only',chatToolPolicy:'read-only-constrained',
  workspaceFileApiOrigin:e.API_ORIGIN,workspaceFileRootDir:`${e.STATE}/agents/${e.SUBJECT}/private-runs`,
  nativeConversationHttpPollEnabled:true,nativeConversationTextFileEnabled:true};
const host={configVersion:1,hostId:e.HOST_ID,stateRoot:`${e.STATE}/host`,agents:[{
  manifestPath:`${e.CANDIDATE}/manifest.json`,profilePath:`${e.CFG}/${e.SUBJECT}.profile.json`,stateRoot:`${e.STATE}/agents/${e.SUBJECT}/runtime`}]};
for(const [name,value] of [[`${e.SUBJECT}.profile.json`,profile],[`${e.INSTANCE}.host.json`,host]])
  await writeFile(`${e.CFG}/${name}`,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
JS
```

模板只开普通原生文本通道，不自动启用图片能力或付费Provider。本次核对源码的文本开关要求 native HTTP 轮询且不能与 controlled-image profile 混用；已有图片角色升级应保留图片配置，不能机械套用此文本模板。托管 hosting-control profile 无原生文件根目录，不能套本单机模板。

普通 `command.dispatch` 的仓库工作任务还需单独 `workspacePolicyId` 和受信任仓库策略（见执行引擎 workspace-manager 与已有运行配置）；上面原生文本模板不代表所有代码工作区能力已启用。不要借此临时克隆不可信仓库。

```bash
"$ARTIFACT/node/bin/node" "$ARTIFACT/runtime/agent-runtime.mjs" validate \
  --config "$CFG/$INSTANCE.host.json"
"$ARTIFACT/runtime/validate.sh" --root "$ARTIFACT" --config "$CFG/$INSTANCE.host.json"
```

以上是配置/制品校验，不证明Codex实际执行、网络授权或业务已经成功。服务用户与配置/凭据/状态所有者必须一致；host状态不得和Agent可写根目录重叠。Runtime1.2.9起不按Codex CLI版本或生成schema摘要拦截；保留实际握手/必需RPC及业务字段校验，不能仅凭Node版本、validate或版本探测成功断言CLI兼容。

## 6. enroll（首次接入且已登记PENDING）

在目标机以最终运行用户执行，密钥只通过文件路径传入：

```bash
SUBJECT_KEY=$(cat "$CANDIDATE/subject-key.txt")
CYF_RUNTIME_V1_API_BASE_URL="$API_ORIGIN" \
CYF_RUNTIME_V1_ENROLLMENT_SECRET_FILE="$CANDIDATE/enrollment-secret" \
"$ARTIFACT/node/bin/node" "$ARTIFACT/runtime/agent-runtime.mjs" enroll \
  --config "$CFG/$INSTANCE.host.json" --subject "$SUBJECT_KEY"
```

授权写入该Agent `stateRoot/runtime-authorization.json`。在网页用原ID查询确认 `ACTIVE`，并确认目标端授权已持久化，再删除**本批已消费的** `enrollment-secret`（保留manifest）。服务环境里不得长期存留secret或该secret路径。未知响应先查安装状态及本机授权，不盲重enroll。

## 7. 管理员切换服务

### 7.1 已有统一 Runtime 升级（不重新登记）

升级走第2节准备候选、第5节按现有配置校验、本节切换和第8节验收；**跳过第3、4、6节的首次登记/enroll**。第5节示例只用于新配置，不重建已有 host/profile。

1. **只读盘点**：确认实际 unit、运行用户、`ExecStart`、cwd、环境文件及 drop-in；通过 `systemctl show "$UNIT" -p FragmentPath -p DropInPaths -p WorkingDirectory -p ExecStart -p EnvironmentFiles` 核对，`UNIT` 必须是已确认归属的服务。另核对真实进程路径、原制品与配置、各 subject 的 manifest/installation/hostId、授权和状态路径。不要把含凭据的配置或完整环境输出到聊天/普通日志。
2. **明确升级范围**：检查候选的协议/状态格式、Codex CLI、Node/Python ABI、依赖及 runner 要求；配置校验不等于这些条件全部兼容。若需显式迁移，先制定当前状态对应的恢复方案；不承诺任意旧版直接跨版本升级。
3. **准备恢复点**：保存原 unit/drop-in、原制品和私有配置；记录摘要与权限。盘点聊天、指令、租约、ACK、文件/技能执行及结果未知状态；不能通过清队列、清锁、自动重跑或重复付费消除问题。共用实例切换会影响所有 subject，先协调维护窗口。
4. **候选预检**：候选放独立目录，用实际服务用户、原配置及相同的 Provider/policy 文件路径环境运行候选 `validate`。不执行 `run`，不启动第二 writer。检查新依赖是否真实可用；不得关闭原能力以掩盖缺项。不要 `source` 未审核配置或把 systemd EnvironmentFile 当通用 shell 脚本。
5. **停写并备份**：按下述授权流程温和停止准确 unit，等待所属引擎/子进程与写者退出、锁正常释放；再完整备份持久状态（包括各 HOME、SQLite/WAL/SHM、授权、registry、ledger、inbox/outbox，以及已启用的 managedRoot）。备份存 `/home/isp/baks/<批次>/` 并按凭据保护，禁止运行中复制单个 DB 冒充一致快照。
6. **精确切换**：确认候选及完整停写备份有效，归档旧程序并将候选安装到固定`app/`实体目录；仅修改受管 drop-in 的程序 cwd/启动/预检路径，保持原配置、身份和状态路径。若必须改配置，保存前值、固定候选并 readback；先审查已有多个 drop-in 的合并效果，不覆盖无关修复。显式迁移完成后再次预检，再 daemon-reload 并启动准确 unit。
7. **逐项验收**：核对实际进程使用候选路径、无重复 writer、每个 subject 的当前注册/在线与实测能力；按第8节做明确授权的新业务验收。旧在线记录、服务 active、inbox completed 或目录存在均不足以证明交付成功。
8. **失败处置**：保留新状态和日志，先归因；只有确认旧制品能读取当前状态时才恢复旧启动配置。若新版本已写入不可逆状态，不拿旧 DB 快照覆盖新业务事实，不盲回退或再次 enroll；按已制定的恢复方案处理并报告真实阻塞。

### 7.2 从旧独立 codex-ws-agent 迁移

先查是否已有统一 Runtime installation：已有则沿用，没有才执行首次登记/enroll。保留原角色绑定，不除名重绑、不复用旧 API Key。旧协议队列不自动导入，逐项处理在途/未知结果；完整 HOME 和路径索引的迁移按第9节执行。旧服务确认停止后才启动统一服务，不把制品中的内嵌执行库当成另一套需启用的服务。

### 7.3 服务切换模板与边界

准备时检查 `id` 和 `sudo -n -l`，权限不足就交付具体命令，不要求用户发送管理员密码。下面为需要管理员审核的模板，不会由安装器自动执行：

1. 记录真实旧unit/drop-in及安装/配置/状态备份。配置备份按凭据同等保护，不把内容打到日志。
2. 没有未处理执行中任务、共用实例影响已确认后，正常停止**准确归属的旧服务**，不按耗时kill，不启动第二writer。
3. 复用 `systemd/cyf-agent-runtime-v1@.service` 配置新实例。该模板默认 `User=root`、制品 `/home/isp/apps/cyf-agent-runtime-v1/app`；非root用户或其他制品路径必须覆盖真实User/Group、WorkingDirectory、ExecStartPre、ExecStart和配置路径，不能直接照模板启动。覆盖ExecStart/ExecStartPre时先以空赋值清除原值。
4. `EnvironmentFile`只放 `CYF_RUNTIME_V1_API_BASE_URL`、已审核的策略/Provider**文件路径**等正常设置，不放enrollment secret。显式PATH需包含实际Codex及工具链依赖。
5. 管理员 `systemctl daemon-reload`，启动真实目标unit；查看精确unit的日志/status。验证无旧新重复进程、身份沿用，确认新服务健康后才设置自启并禁用准确旧unit。
6. 启动失败先定位；恢复需同时匹配原制品、配置和原状态，不能拿旧二进制读新状态。不得删注册记录或清状态冒充修复。

可用于定制的单实例unit核心（占位符必须替换，不作为可直接复制的命令）：

```ini
[Service]
User=<实际运行用户>
Group=<实际运行组>
WorkingDirectory=<ARTIFACT绝对路径>
EnvironmentFile=<CFG>/<INSTANCE>.conf
ExecStartPre=<ARTIFACT>/runtime/validate.sh --root <ARTIFACT> --config <CFG>/<INSTANCE>.host.json
ExecStart=<ARTIFACT>/node/bin/node <ARTIFACT>/runtime/agent-runtime.mjs run --config <CFG>/<INSTANCE>.host.json
Restart=on-failure
RestartPreventExitStatus=78
KillSignal=SIGTERM
```

手动诊断与systemd启动互斥；不可为了看日志同时运行两份 `run`。既有制品内Python路径如涉及搬迁必须重新validate，不把任意`mv`视为可恢复安装。

## 8. 验收与交付

首次接入与升级都按实际启用能力验收；纯文本模板不能证明图片/识别/技能可用。技能需同时满足真实 runner/工具/Provider 绑定、当前会话目录、安装 entitlement 和业务调用授权；仅安装包名或开关不代表 READY。2026-10-25 用户授权变更：`local-script` 使用普通 Node 子进程，不依赖 bubblewrap/namespace；READY 仍须实测解释器、输入读取和输出写入。子进程拥有 Runtime 服务账号的文件与网络权限，私有 cwd/HOME 和最小环境变量不构成安全沙箱；不继承 Provider token 等环境变量，不通过 shell 执行。仅执行已授权审核包，保留包/输入摘要、身份、幂等和结果路径检查。此项不改变其他执行链路的沙箱。不要为验收顺便启用新付费能力或触发未授权 Provider 调用。

按顺序记录，不混淆状态：
1. 制品安装/闭包校验完成。
2. 安装登记PENDING → enroll ACTIVE（仅首次接入）。
3. 目标unit运行、无重复writer、扈三娘/目标角色在本人点将册在线；核实真实执行器能力ready。
4. 两轮正常议事；新建明确标记的普通事项生成UTF-8文本，实际下载核对内容/摘要，再确认验收。
5. 图片生成/改图仅在该角色具备对应配置和单独付费授权时验证，不随文本升级自动测试。

网关需放行现有 `/agent/runtime/v1/`、`/ws/agent/channel` 与任务使用的原生 `/internal/agent/` 精确路由，同时保留installation/session/owner鉴权；444/403应定位路由或授权，不放开全部internal或回退API Key。只对新事项验证新grant，不回填历史权限。

交付记录：源码SHA、Runtime版本、实际平台与工具链、制品摘要、服务名/运行用户、配置/状态路径、installationId（非秘密）、逐步验收证据及未完成项。**本指南不是目标机器已升级或网站已发布的证明。**


## 9. 已有统一 Runtime 的目录收口（不是再次登记）

2026-10-12核对：CYF主机已按此原则把旧独立目录的现用数据迁走，三静态角色在线、59个会话索引路径完整、原读图证据无付费重测READY。该实例证据不替代其他机器的迁移验证，也不等于Runtime源码1.0.3已在每台主机安装。

**统一布局**（示例基目录`/home/isp`，其他账号用其真实授权根；`INSTANCE/SUBJECT`为安全本地标识，不代表tenant）：

| 内容 | 新安装/目录收口目标 |
|---|---|
| 不可变程序制品 | `apps/cyf-agent-runtime-v1/<release>` |
| host/profile/manifest与独立Provider配置、policy/model-catalog | `conf/cyf-agent-runtime-v1/` |
| host锁和状态 | `state/cyf-agent-runtime-v1/<instance>/host` |
| 每个角色完整Codex HOME | `state/cyf-agent-runtime-v1/<instance>/agents/<subject>/codex-home` |
| 每个角色runtime授权、workspace、private-runs | 同一`agents/<subject>/`下彼此独立子目录 |
| 尚需引用的历史工作数据 | `state/cyf-agent-runtime-v1/<instance>/history/`，保持原角色权限/归属 |
| 动态托管角色持久状态 | `state/cyf-agent-runtime-v1-managed/<instance>/`；与普通角色状态分开，沿用实际 `managedRoot` |
| 退役程序和恢复证据 | `baks/<本次批次>/`，不是第二套活动服务 |
| 本机临时控制 UDS | `/run/cyf-agent-runtime-v1/<instance>/control.sock`；不是网络端口或持久数据 |
| systemd unit/drop-in | `/etc/systemd/system/` |
| 开机临时目录规则 | `/etc/tmpfiles.d/cyf-agent-runtime-v1-hosting.conf` |

**目录原则：长期程序、配置、状态和备份归入 `/home/isp`；系统服务定义和临时 socket 保留 Linux 标准位置，不为路径整齐迁入 `/home/isp`。** `/run` 随重启清空，审核后的 tmpfiles 规则在开机时重建父目录，Runtime 监听时创建 socket；这不是重建安装身份或业务状态。标准托管示例为父目录 `root:isp 0750`、socket `0660`，实际组/GID 必须与 API 配置一致，不以放宽权限解决连通性问题。

托管控制仅用于本机 API → Runtime 的 prepare/ensure 等指定 subject 操作，不是模型聊天或公网入口。API 的 socket-path 与 Runtime 的 socketPath 必须一致，详见 [托管控制说明](../conf/cyf-agent-runtime-v1/HOSTING-CONTROL.md) 和 [tmpfiles 模板](../conf/cyf-agent-runtime-v1/systemd/cyf-agent-runtime-v1-hosting.tmpfiles.conf.example)。安装器不自动应用该规则、不创建生产控制目录；运行中不得手删 socket，未知旧端点/锁须先确认归属和写者停止，不自动抢占或清理。

制品中的`codex-bridge/`是内嵌执行库，不能全局改名或删掉。安装器仍**只准备制品**；不自动搬HOME、接管锁、改身份、停服务或启用旧服务，也不把目录更新当作升级完成。

管理员在明确授权的目标机上逐项执行，不把CYF主机路径/角色直接套到其他账号：

1. 固定实际制品、运行用户、unit/drop-in、配置摘要、manifest/installation/hostId及授权文件摘要；记录每个旧→新路径。确认其他任务的服务使用窗口、所有在途状态和可恢复备份。目标必须不存在、权限与原UID一致；同文件系统可原子rename，跨文件系统先完整复制和逐文件校验，不能半复制后删除原目录。
2. 盘点profile中的`codexHome`、HOME内`config.toml`的model catalog/受信任工作目录、workspace policy与工作区根、外部工具路径、符号链接、SQLite会话索引和进程FD/cwd/exe。检查旧目录无他人进程，不因为旧独立service停用就判定可删。
3. 对准确归属的统一服务请求温和退出，并等待原主进程及写者退出、所属writer锁正常释放；**不因耗时强杀、不手工删锁**。维护时禁止并行启动第二writer。快照SQLite及WAL/SHM须在写者全部停止后一起保存，不能仅复制正在写入的主DB。Python3.6没有`Connection.backup`，不得假定该API存在；离线字节备份须覆盖全部相应文件。
4. 完整移动各角色自己的HOME（含认证、会话、DB、索引），保留属主/权限；同时移动仍被引用的model-catalog、policy/workspace及历史数据，再定向更新profile/环境文件/配置和已确认的符号链接目标。不跨角色复制凭据，不改Provider/模型/权限/图片开关，不采用兼容软链接或双写。原runtime授权/ACK/installation state不在路径计划内就保持不动。
5. 对**当前实际数据库schema**逐项确认路径索引后，在事务内只替换明确旧→新路径。例如现行Codex的`state_5.sqlite`表`threads`中`rollout_path`和`cwd`；保留线程ID、行数和原会话原文，不全库文本替换。迁移前后`PRAGMA integrity_check`必须为`ok`，确认每个rollout实际存在。版本schema不符时先分析，不能盲执行示例SQL。此步骤是本角色会话路径保留，不是旧协议队列导入/重放。
6. 使用原精确制品validate，携带**与服务一致**的Provider/policy文件路径环境；启用图片的host缺少`CYF_RUNTIME_PROVIDER_ENVIRONMENTS_FILE`时会拒绝，不能关闭能力绕过校验。核对认证/manifest/installation授权摘要未变。启动后检查每个subject实际在线、能力ready、锁归属、新路径进程与会话读取；图片识别原证据保留，做无模型调用的隔离/承载重测，不能伪造新摘要。
7. 确认旧根无活动配置、FD/cwd/exe引用且每个会话索引可读后，把剩余旧部署目录、旧启动脚本移到本批备份；禁用/屏蔽精确旧服务，健康监控指向统一服务。**先核验再退役**，不误删当前内嵌执行库。旧文档/会话原文和证据可保留历史路径，不重写历史。
8. 失败保留阶段记录、先归因再恢复：原制品和当前业务状态保持对应，逆向移动原数据并恢复配置/路径映射。若新服务已产生写入，禁止用旧DB快照覆盖当前状态；只逆向修正当前索引。恢复也只能启动统一服务，不重新enroll、清队列或重放未知请求。

现用目录、退役备份、源码可用、目标服务在线和真实业务验收分别记录。目标机升级不意味着网站已发布；网站新文书发布也不会远程自动更新已有安装。

## 10. CYF unified Node baseline (2026-10-22 candidate)

The CYF host and Flow toolchain target Node **24.22.1**, with npm **11.19.1** from the same official distribution. Runtime 1.2.5 must be prepared with that exact supplied Node/npm; its immutable artifact may carry the same Node bytes, not a separate version track. The generic Runtime installer still records the actual interpreter and does not impose a new global engine allowlist. This candidate is not evidence that any host has switched.

Linux x64 archive SHA-256: `6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6`. Verify the official release manifest and archive before preparation. Extract as the intended trusted owner (`--no-same-owner` for root preparation); archive numeric UIDs are not host trust identities. Do not relax the local-script interpreter checks.

The host installation entry is `/home/isp/apps/node`. Existing RPM-managed Node/npm must be inventoried and migrated together with global CLI resolution; merely prepending PATH is not convergence. Preserve existing global packages and their permissions. Coordinate other owners' active Node/Codex processes: changing filesystem entries does not change their running interpreter. Old artifacts are recovery material, not active alternative toolchains. Do not mark full-system convergence until actual service processes and Flow runs use the unified version. Runtime activation follows §7.1 and preserves identities, HOME and state; do not modify a running immutable artifact.

## UNKNOWN 技能恢复诊断（2026-10-22 局部源码核对）

覆盖源码 `2d7650a77b058c7d80bec95e5511ef1faf6126cb`（Runtime 候选 1.2.5），仅技能 conversation lane 调度和安全日志，不代表已安装或激活。

- `SKILL_RESULT_UNKNOWN` 按 executionId 延期恢复；基准间隔 15/30/60/120/240/300 秒，实际加入 0.8–1.0 倍抖动；不是请求 deadline，不终止未知执行，不重新发起未知外部副作用。到期仍走原身份、租约、结果和幂等校验。
- 冷却期跳过该执行的完整 process，返回 `deferred` 计数而非宣称处理成功；其他执行继续。正常收件箱轮询及本地待处理扫描仍保留，尚非事件驱动或独立轻量查询协议。状态变化最迟需等当前冷却到期才会被恢复路径观察。
- 调度信息只在当前 lane 内存中；重建/重启后重新核对一次，持久化 effect/attempt/result 的安全规则保持不变，不能因此重放 UNKNOWN。恢复成功或转为其他可处理错误时清除对应退避。
- native poll 的 `diagnostic` 仅输出安全结构化字段：`cause=ABSENT` 表示没有 cause，`REDACTED` 表示存在但不能直接输出；网络码及合法 SKILL_/MATERIALS_ 码保留。技能进程失败可带安全 exitCode/signal，执行错误带 executionId。首次 effect 调用异常标记 `stage=skill-effect-invoke`；其他路径为 `native-conversation-poll`。不打印原始 message/stack/stderr/命令或输入。
- 冷却期间不重复抛出同一 UNKNOWN；到期仍未知时保留真实告警。本次未做持久化告警聚合、原始异常历史补全或卡住任务自动修复。不得删除现有 checkpoint 或伪造成功来消除告警。

## 校验开销与主线程隔离（2026-10-23，1.2.8源码候选）

本节仅覆盖基线 `297272f5e7af49c6bda703b37f0fc8a6a830a4a7` 之后的校验性能改动；**不是生产升级回执**。CYF主机本次只读核对仍为Runtime1.2.6，1.2.7固定目录源码候选未因本节自动部署。此候选不修改业务wire、安装身份、ACK、代际、技能或成果合同，也不处理既有事项517的业务状态。

- 网络归属校验：绑定时异步分块测量实际`/proc/PID/exe`。只在dev/ino/size/mtimeNs/**ctimeNs**/mode/uid/gid完全一致时复用本实例摘要，不按路径或TTL信任；每次仍重新打开并核对元数据，变化则重新测量、按原预期摘要拒绝漂移。分块缓冲1MiB，不再整文件读入内存。异步前后保留PID/startticks/父子关系、可执行身份、namespace、外来进程与取消检查。
- 同一`_nsenter`已在返回前核验所有权，其后没有异步间隙的4处完整重复检查移除；写防火墙、读回、slirp准备及探针等真实边界上的保护不删除。拒绝探针累计HTTP状态行，并在接收异常/EOF时记录阶段与类型，不增加超时或放宽安全判定。
- 普通会话/重连及带资料会话统一走异步测量和spawn入口。单个进程内共享一个串行完整性worker，承担重型复制、哈希和CLI版本/schema探测；无待处理作业时unref。主线程只做已验证证据的元数据一致性核对，worker错误关闭当前启动，不回退主线程重测或绕过校验。退出/身份切换后不得迟到启动；在途启动完成清理前不释放本subject生命周期。
- 启动器识别只读原有8192字节前缀，而不是读取整个原生二进制；configured与native为同一路径时每轮只哈希一次。原来源/快照/资源全部验证后的内存缓存，仅在内容元数据、目录树及祖先权限身份一致时复用；资源变化、替换inode、同长改写并恢复mtime均不得借缓存通过。普通子进程验证只测一次，不留跨PID的无界摘要缓存。
- 心跳发送只复用本次同步调用刚取得的持久健康结果；一次health读回只取一次ready。每次后续调用仍重新检查，不跨心跳周期缓存、不延长在线时间或弱化故障隔离。
- 同步底层测量函数保留给独立诊断/单测；生产调用点均使用异步入口。新增worker和完整性模块已进入权威`EXECUTION_PAYLOAD_FILES`清单，源码语法正确不等于制品已包含或安装成功。

### 全链路审查处置

| 范围 | 处置 |
|---|---|
| 普通/带资料启动、重连、网络隔离 | 本候选优化上述重复测量和主线程重操作；禁止/允许目标及nft真实回归不删 |
| 注册、presence、健康读回 | 去掉同次调用内的重复结果计算；会话认证、注册确认、健康撤销保留 |
| 消息收件箱、ACK/结果重放、恢复 | 去重、锁、持久化、原请求/执行身份和未知结果不可重放检查保留；不是可无证据删去的冗余 |
| 技能目录与执行 | 现有declaration已只读缓存，refresh按工具名/provider alias共用探测；执行时requireExact仍重测绑定，不跨会话复用授权 |
| 资料/工作空间/成果 | 字节与摘要核对、路径/ACL、输出重开与上传校验各保护不同边界，保留；同步解析/重开仍可能阻塞，不能宣称全Runtime已无同步重操作 |
| 安装、工具链与Python | 来源、依赖、包摘要、不可变清单、固定app路径、锁与可恢复安装保留；未运行生产安装或重打包 |

剩余已识别但本轮未改写的路径包括：`validateWorkspaceFileOutput`同步Python重开、技能安装原子操作辅助进程、资料解码/图片衍生处理、启动时命令适配器版本探测、Git工作区同步子进程以及持久队列扫描。这些不是已证实可删除的重复校验；若继续消除阻塞，应逐条调整异步调用合同并定向回归，不能只把函数声明改成async导致调用方漏await。当前不为这些潜在开销添加任意硬门限，也不据此声称业务性能全面达标。

## Codex版本与生成协议不再作为准入门禁（2026-10-23，1.2.9源码候选）

本节覆盖前文1.2.8的版本/schema探测口径。基线源码3c993e58033d901622c24126028199cdf4e2c76f；修改范围仅为Codex App Server启动、typed就绪与配置门禁，不是取消CYF业务协议校验。

- 移除生产版本/schema合同注册表、固定版本相等比较和生成协议bundle摘要比较。启动不再运行`app-server generate-json-schema`；`--version`仅记录观察，失败或未知版本不阻止运行。历史schema fixtures仅用于测试，不作为生产白名单。
- 静态/托管配置不再要求`appServerSchemaContractId`；已存字段忽略，不参与授权/就绪。READY需要实际初始化及已测量执行文件，不因未来版本、schema附加字段或缺失的诊断版本号判为UNAVAILABLE。
- 必需RPC真实错误、消息绑定/结果结构、身份/ACL、网络/文件沙箱、摘要、锁和发布完整性保持原行为。未知CLI不等于兼容已验证；实际业务回归仍必要。
- `schema`历史诊断槽中的`measured`仍指执行文件测量；合同ID/bundle摘要为空，不伪造schema已测量。汇总用`binaryMeasured`/`codexCliVersion`，INSPECT合同ID不再拼接CLI版本；执行策略仍绑定实际binaryIdentityDigest，旧carrier证据不得冒充新文件证据。
- `CODEX_APP_SERVER_CONFIGURED_EXECUTABLE_DRIFT`是运行期间文件改变的完整性保护，仍拒绝旧测量执行。新程序获授权部署/受控重启后重新测量；不在请求中自动信任漂移、不回放旧请求、不改全局Codex。此源码说明不证明已经安装或多轮图片已验收。


## Codex伴随可执行文件（2026-10-25，1.3.3候选）

基线60ed188。生产任务523暴露：快照只有主程序和codex-resources，遗漏同发行目录的codex-code-mode-host，工具启动ENOENT。快照现在同时复制原生bin目录中实际存在的codex-*常规文件，保留同级布局；旧CLI没有伴随文件也可运行，不新增版本白名单。来源/快照的文件摘要、独立副本及变更检测继续保护真实执行身份；缓存路径只stat，不在主线程反复读取大型助手。符号链接或非常规文件不作为可执行快照复制，作用域限本次App Server启动。复用app-server-integrity-worker既有测试验证助手可执行及篡改拒绝；真实模型/图片验收须另记线上证据。

### 2026-10-25 历史技能命令隔离（1.3.4）

已有private-runs中的旧command可能缺少后来新增的taskSkillBinding；这不能构造或补写为当前执行授权。扫描仍核对私有目录、普通文件、UID/权限、锁及身份完整性。只将命令级SKILL_COMMAND_INVALID记录为该execution的待处理错误，保留全部原始文件/回执，不重放、不标记成功，并继续当前合法命令；共享目录/身份/会话错误仍中止。轮询最终报告原错误、executionErrors及实际processed数，不把隔离误报为旧任务完成。实现skill-conversation.pendingCommands/poll，复用既有“不饿死后续任务”回归包含旧无binding记录，正式Flow结果见CYF协调仓本次handoff。

### 图片技能尺寸契约（2026-10-25，源码候选；安装/业务验证另记）

Runtime 1.3.5 / image-generate、image-edit 1.2.0 增加可选 `parameters.size="800x600"`。只在用户明确尺寸时填写；旧 `{}` 不转换、旧已完成回执不重放。图片runner复用Magick：等比缩放到指定画布内、居中透明留边，不裁切/拉伸，不向未核实尺寸能力的Provider盲传参数。尺寸语法须为正整数宽x高并能被JS安全整数表示；无效值在外部调用前拒绝，防止错误尺寸产生有偿副作用，不加业务像素上限。

Provider原始PNG通过原SkillEffects先持久保存成功，再执行本地尺寸转换；尺寸及转换标识绑定effect摘要，转换失败仅报告该动作的输出处理错误，不将外部成功改为UNKNOWN、不再次调用Provider。最终成果摘要对应实际输出字节，原输入SHA/DELIVERED不变。仅新尺寸请求加转换摘要字段，旧空参数摘要保持。恢复需原服务端确认、身份/授权/fence不变，不能根据本地文件自行补发旧UNKNOWN。

关键回归复用 `conf/codex-bridge/test/skill-runners.test.mjs` 的既有图片broker用例：旧参数、800×600、非同比例透明边、持久effect恢复不重复调用、错误尺寸不调用Provider。Flow同Run测试/打包，新技能包通过维护发布→报价→INSTALL/UPGRADE→目录READY，不以直接写权益替代管理流程。线上尺寸和多轮识图/生图/改图仍须实际图片验收，不以测试通过代替上线。


### 9.5 系统Codex直连与历史快照回收（2026-10-25，1.3.8候选）

核对范围：基线0425c11之后的 `app-server-adapter.mjs` 测量/spawn与typed inspection调用链；完整源码、受测及安装事实见CYF `docs/implementation/handoffs/RUNTIME-DISK-GROWTH-20261025.md`，本节不是线上启用证明。用户最终要求直接使用系统Codex，覆盖此前公共目录迁移方案及1.3.3/1.3.7的程序复制描述。

- 直接解析profile既有`codexBin`（支持系统Node launcher到本平台native程序），执行系统安装中的原生Codex，不创建程序、伴随工具或资源副本，也不新建公共快照目录。版本仅诊断，旧CLI无伴随工具也可运行。同进程测量缓存共享不等于程序副本；HOME、身份、会话、SQLite、授权和任务状态仍逐Agent隔离。
- 内部`snapshotPath`/`snapshotIdentity`兼容槽现在指向系统程序，`snapshotKind=system`；既有消费者与真实进程/proc校验继续使用实际dev/inode/hash。INSPECT沙箱只读挂载系统native发行根，仍保留HOME、输入和网络隔离，不为直接执行暴露宿主全文件系统。
- 不再具有独立不可变副本的抗系统更新保证。程序、launcher、助手及资源保留属主/非group/world可写、摘要、路径和祖先目录检查；spawn前重查与spawn后真实/proc程序核验仍执行。系统Codex升级必须协调运行中任务，受控更新后重新测量，不能把旧证据视为新程序或声称完全消除TOCTOU；不自动安装/升级Codex，不回放任务。
- 测量缓存返回前仍扫描本profile精确HOME的`.cyf-app-server-bin-XXXXXX`历史目录；只删除已过原5分钟窗口、owner PID/startTime不再活动且无真实进程引用的副本。年轻遗留安排unref延迟回收并重查，不按名字清除其余HOME、身份或业务数据。退出维护仅清理计时器与测量缓存，不删除系统程序。
- 合成fixture覆盖100独立HOME和三轮进程重启均0份新增程序、缓存命中根回收、年轻遗留与活owner保护，以及系统/助手/资源篡改拒绝；不冒充100真实模型会话容量测试，不承诺业务状态零增长。
- `.tmp/plugins`历史副本需单独核对配置/技能链接/进程引用与恢复材料，不能只凭tmp名删除；本机本次三份已清除并只留一份压缩恢复包。备份仍须保留完整状态恢复闭包，不能借取消程序快照删减身份/SQLite备份。

### 9.6 技能管理内置能力（2026-10-25，1.3.9候选，未部署）

技能安装/升级/启停管理不再需要profile的`skillInstallEnabled`，历史缺字段、false、true均不决定管理能力。岗位技能与归档同步也不依赖这个开关；它们仍只在已绑定且ready的当前Runtime通道上执行。用户对单个技能的启停、身份/会话/命令授权、包摘要、幂等日志、锁和恢复原样保留。真实ready依据生命周期与持久状态健康，不凭配置声称就绪。此处是源码行为说明，不代表线上林冲原安装已恢复；正式回归与部署证据在CYF技能管理handoff。

### 2026-10-26 技能服务共享作用域（候选，部署单独核对）
技能安装选择即授权固定版本所需权限，不再逐Agent开通。skill-bindings.json新增可选scopes数组，每项为{tenantId,clientId,providerAliases}；providers.json新增可选scopes数组，每项为{tenantId,clientId,environment}。同一完整tenant/client所属范围的已绑定Agent自动取得已配置别名及其引用的凭据名。显式主体配置优先，不读取全局env、不跨作用域借用；显式覆盖为另一Provider时不得借用共享Provider的同名凭据。新Agent无需修改subject清单。现有无scopes配置继续兼容；依赖未配置仍按真实失败回传，不产生虚假就绪。安装不自动执行，原任务授权、技能启停、摘要、锁和幂等不变。配置必须与支持scopes的Runtime一起受控启用，旧程序回退前先恢复这两份配置的原值，不能恢复业务journal/ACK。回归入口：conf/cyf-agent-runtime-v1/test/provider-environments.test.mjs。

### 2026-10-26 技能目录重注册心跳语义（1.3.16）

技能安装/卸载后的目录刷新需要匹配的新注册 ACK 才能恢复准入；等待期间不代表 Agent 断线。健康、未暂停且有可用执行器时暂停该窗口的 presence，避免发送 offline 撤销服务端刚建立的会话绑定。实际持久状态异常或暂停仍发送 offline 并停止准入；不放宽身份、会话代次或 ACK 匹配，不重放历史 UNKNOWN。定向回归入口：`runtime-host.test.mjs` 的 `catalog re-registration heartbeat`，以及既有 health revocation、stale generation、skill measurement 测试。此段记录源码行为，发布/线上核验单独记录。

### 技能管理/冷启动分段耗时（1.3.17源码候选）

`runtime-phase-timing`只记录subjectKey、commandId（若有）、固定阶段、开始/结束、单调时钟耗时和completed/failed；不记录输入/凭据/错误正文。阶段包括profile-state-initialize、input-carriers-measure、app-server-initialize、skill-command-handle、skill-receipt-handle、skill-catalog-refresh。`runtime-management-timing`区分原有入站队列等待与实际handler耗时。日志失败不改变操作结果或抛出的原错误，不增加超时、并发或准入门禁。此段仅为源码候选，不能据此宣称线上已生效或性能已改善。

### 解释器逐次异步摘要（1.3.18源码候选）

local-script解释器从整文件同步读取改为1MiB缓冲异步SHA，每次仍重新测量全文件，不新增信任缓存，也不修改既有工具链摘要字段。异步窗口用同FD和路径身份/元数据前后对照，保留属主/父目录权限校验；父目录内容变化不等于路径身份变化。变化仅拒绝当前测量，不启动脚本、不重放历史效果。小合成文件验证摘要等价、事件循环推进、同长替换/修改/别名切换拒绝；真实runner及恢复回归继续走Flow。1MiB不是包大小门槛，源码存在不等于线上提速。本轮接口基线为CYF `api/docs/interface-standard.md` v1.4，详细约束见`specs/juyiting-skill-execution/management-contract.md`的2026-10-26性能节。


### CYF 本领维护与最小注册（2026-10-29 候选，发布见 CYF handoff）

遵循 `/home/isp/wsps/cyf/api/docs/interface-standard.md` v1.4 和 RB-1。请上梁山/API 初始化资料和本领，随后本人在详情维护；Runtime 注册不读工作目录推测本领、不上报姓名/头像/角色资料/本领，presence 只报动态状态与会话 fence。保留 API 真实消费的 runtimeCapabilities、typedDeliberation（材料输入、nativeExecution）、skillExecution，不能用本领介绍代替就绪/授权。无旧客户端双轨；Runtime 1.3.24/bridge 1.1.15 候选需与对应 API/Web 协调部署，版本号修改不表示已启用。
