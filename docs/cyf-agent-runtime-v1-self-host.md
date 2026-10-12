# 聚义厅「自家接应」：统一 Runtime 安装、登记与升级

核对：2026-10-12。Runtime 源码基线 `807b86d66153b765529bba1d547e4bcfbf0a3706` / **1.0.3**；本指南及准备工具是该基线后的接入补全。请使用包含本指南和工具的 `develop` 提交并记录实际 SHA，不使用旧 `master` 安装技能。Runtime 版本与 CYF 前后端版本分开。

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

本次不迁移历史协议队列，不做旧版本双轨兼容。备份旧状态；执行中、结果未知的业务须逐项说明处置，不能清队列、重放扣费请求或虚报完成。共用 Runtime 的其他 Agent 也受进程切换影响，先确认影响范围。

## 2. 固定源码并准备新制品

先记录真实旧服务的 `systemctl cat <旧服务>`、运行用户、ExecStart/cwd、配置/状态目录；不要猜服务名。检查磁盘、目标平台、Node/npm/Python 和 Codex CLI 是否可执行。Node 无项目版本白名单，记录实际版本；依赖仍须真实适配。Python 3.11.13 为已验证基线，不代表任意架构天然通过。

已有核验通过的1.0.3制品不用重复安装。首次安装示例（替换路径，使用真实工具）：

```bash
REPO=/absolute/path/to/isp-install
ARTIFACT=/home/isp/apps/cyf-agent-runtime-v1/selfhost-1.0.3-BUILD_ID
# 管理员只在必要时创建父目录并授权给真正的运行用户，不递归chown共享目录。
# ARTIFACT须为不存在的canonical绝对路径；制品不可直接覆盖运行目录。
bash "$REPO/conf/cyf-agent-runtime-v1/install.sh" \
  --target "$ARTIFACT" --node /absolute/path/to/node \
  --npm /absolute/path/to/npm --python /absolute/path/to/python3.11
"$ARTIFACT/runtime/validate.sh" --root "$ARTIFACT"
git -C "$REPO" rev-parse HEAD
```

安装器只准备 `runtime/`、`codex-ws-agent/`（内部执行引擎）、`node/bin/node` 及完整私有依赖。**不安装/启用 systemd、不登记、不迁移配置或状态。** 不借宿主 Python 包掩盖私有环境缺失。记录制品目录、源码SHA、安装回执及摘要，平台工具链验收失败应先归因。

## 3. 目标端准备登记材料（首次接入）

从本人「自家接应」文书取得 `tenantId/clientId/canonicalAgentId`。当前后端 local bind 复用的 Scope 仍限制 tenant `0`；以下工具不猜租户、也不解除服务端该限制。多区域绑定尚需单独实现。

以下变量均为**非秘密值**，由操作人替换；命令以最终 Runtime 运行用户执行。配置、状态与制品分离。

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
export CODEX_HOME_PATH=/absolute/path/to/this-agents-private-codex-home
export CODEX_MODEL='该账号实际可用模型'
export API_ORIGIN=https://api.chaoyoufan.cn
export INSTANCE=your-instance
export HOST_ID='本机持久唯一的host标识'
# STATE父目录应先由管理员授权。运行用户创建，勿覆盖已有目录/配置。
mkdir -m 700 -p "$STATE/host" "$STATE/$SUBJECT/runtime" "$STATE/$SUBJECT/workspace" "$STATE/$SUBJECT/private-runs"
# CODEX_HOME_PATH使用本角色独立的合法Codex凭据/配置，CLI先完成正常登录检查。
"$ARTIFACT/node/bin/node" --input-type=module <<'JS'
import {writeFile} from 'node:fs/promises';
const e=process.env;
for(const k of ['CFG','SUBJECT','CANDIDATE','STATE','CODEX_BIN','CODEX_HOME_PATH','CODEX_MODEL','API_ORIGIN','INSTANCE','HOST_ID','AGENT_ID'])
  if(!e[k]) throw Error('Missing '+k);
const profile={profileId:e.SUBJECT,agentId:e.AGENT_ID,codexBin:e.CODEX_BIN,
  codexHome:e.CODEX_HOME_PATH,codexWorkdir:`${e.STATE}/${e.SUBJECT}/workspace`,
  codexModel:e.CODEX_MODEL,codexSandbox:'workspace-write',codexApproval:'never',codexSessionMode:'new',codexTimeoutMs:0,
  chatEngine:'app-server',appServerEnabled:true,fastChatEnabled:true,trueDeltaEnabled:true,typedDeliberationEnabled:true,
  chatModel:e.CODEX_MODEL,chatSandbox:'read-only',chatToolPolicy:'read-only-constrained',
  workspaceFileApiOrigin:e.API_ORIGIN,workspaceFileRootDir:`${e.STATE}/${e.SUBJECT}/private-runs`,
  nativeConversationHttpPollEnabled:true,nativeConversationTextFileEnabled:true};
const host={configVersion:1,hostId:e.HOST_ID,stateRoot:`${e.STATE}/host`,agents:[{
  manifestPath:`${e.CANDIDATE}/manifest.json`,profilePath:`${e.CFG}/${e.SUBJECT}.profile.json`,stateRoot:`${e.STATE}/${e.SUBJECT}/runtime`}]};
for(const [name,value] of [[`${e.SUBJECT}.profile.json`,profile],[`${e.INSTANCE}.host.json`,host]])
  await writeFile(`${e.CFG}/${name}`,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
JS
```

模板只开普通原生文本通道，不自动启用图片能力或付费Provider。1.0.3文本开关要求native HTTP轮询且不能与controlled-image profile混用；已有图片角色升级应保留图片配置，不能机械套用此文本模板。托管 hosting-control profile 无原生文件根目录，不能套本单机模板。

普通 `command.dispatch` 的仓库工作任务还需单独 `workspacePolicyId` 和受信任仓库策略（见执行引擎 workspace-manager 与已有运行配置）；上面原生文本模板不代表所有代码工作区能力已启用。不要借此临时克隆不可信仓库。

```bash
"$ARTIFACT/node/bin/node" "$ARTIFACT/runtime/agent-runtime.mjs" validate \
  --config "$CFG/$INSTANCE.host.json"
"$ARTIFACT/runtime/validate.sh" --root "$ARTIFACT" --config "$CFG/$INSTANCE.host.json"
```

以上是配置/制品校验，不证明Codex实际执行、网络授权或业务已经成功。服务用户与配置/凭据/状态所有者必须一致；host状态不得和Agent可写根目录重叠。Codex CLI app-server协议须匹配制品适配器支持契约，不能仅凭Node版本或validate成功断言CLI兼容。

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

准备时检查 `id` 和 `sudo -n -l`，权限不足就交付具体命令，不要求用户发送管理员密码。下面为需要管理员审核的模板，不会由安装器自动执行：

1. 记录真实旧unit/drop-in及安装/配置/状态备份。配置备份按凭据同等保护，不把内容打到日志。
2. 没有未处理执行中任务、共用实例影响已确认后，正常停止**准确归属的旧服务**，不按耗时kill，不启动第二writer。
3. 复用 `systemd/cyf-agent-runtime-v1@.service` 配置新实例。该模板默认 `User=root`、制品 `/home/isp/apps/cyf-agent-runtime-v1/%i`；非root用户或其他制品路径必须覆盖真实User/Group、WorkingDirectory、ExecStartPre、ExecStart和配置路径，不能直接照模板启动。覆盖ExecStart/ExecStartPre时先以空赋值清除原值。
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

按顺序记录，不混淆状态：
1. 制品安装/闭包校验完成。
2. 安装登记PENDING → enroll ACTIVE（仅首次接入）。
3. 目标unit运行、无重复writer、扈三娘/目标角色在本人点将册在线；核实真实执行器能力ready。
4. 两轮正常议事；新建明确标记的普通事项生成UTF-8文本，实际下载核对内容/摘要，再确认验收。
5. 图片生成/改图仅在该角色具备对应配置和单独付费授权时验证，不随文本升级自动测试。

网关需放行现有 `/agent/runtime/v1/`、`/ws/agent/channel` 与任务使用的原生 `/internal/agent/` 精确路由，同时保留installation/session/owner鉴权；444/403应定位路由或授权，不放开全部internal或回退API Key。只对新事项验证新grant，不回填历史权限。

交付记录：源码SHA、Runtime版本、实际平台与工具链、制品摘要、服务名/运行用户、配置/状态路径、installationId（非秘密）、逐步验收证据及未完成项。**本指南不是目标机器已升级或网站已发布的证明。**
