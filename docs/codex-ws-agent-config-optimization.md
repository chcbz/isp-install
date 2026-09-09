# Codex WebSocket Agent 配置优化方案

审计日期：2026-09-09。依据安装仓库、部署目录 `/home/isp/apps/codex-ws-agent`、
本机 Codex CLI 0.153.4 的校验与历史会话。模型标识由实际网关决定，不在本轮更换模型。
不包含真实 Agent API Key、模型认证或私人 Codex Home 副本。

## 1. 范围和发布约束

第一轮仅修改安装仓库；第二轮经用户明确授权，已完成线上配置优化、原子发布和重启。
审计时仓库旧于线上 `releases/20260908122142-2989597`，因此没有直接覆盖：先找到与线上
源码完全一致的工作副本，三方合并优化补丁，再同步注册确认、技能安装、Home 隔离及托管
模块、锁文件、测试和原子发布安装器。本工作区现已与实际新 release 对齐（见第 7 节）。
今后仍不可用未包含这些同步内容的旧提交整包覆盖生产。

`abilities/skills` 不参与调度是已有文档及回归测试明确规定的设计，不是漏写一行 merge。
不能为了消除配置困惑而把工具名称、任意声明或未验证技能直接变成服务端调度能力。

## 2. 已落地内容

| 优先级 | 内容 | 边界/验收 |
| --- | --- | --- |
| P0 | 新建和恢复均显式传工作目录与 sandbox；参数放在 `exec` 后、`resume` 前 | 不新增 `--dangerously-bypass-approvals-and-sandbox`；现有全权限 profile 的恢复会话可能扩大权限，必须审阅后发布 |
| P1 | 新增 `--inspect-config` 只读脱敏报告 | 不连接 WebSocket/模型，不读取 auth，不初始化 Git 工作区；输出采用字段白名单 |
| P1 | sandbox、approval、session mode 和 timeout 校验 | 拼写错误、负数、小数、非数值、超出 Node 定时器范围的值拒绝启动/重载 |
| P1 | `codexTimeoutMs=0` 真正关闭超时 | 以前会创建 0ms 定时器；有限超时仍发 SIGTERM，尚不保证强杀整个进程树 |
| P1 | `--validate` 输出能力字段忽略、工作区缺失等警告 | 保留无工作区的聊天兼容，不把它误报为命令可执行 |
| P2 | 支持遗留环境变量 `CODEX_MODEL` | profile/公共默认中的显式 `codexModel` 优先；无覆盖时才交给 Home/CLI 默认 |
| P2 | 新安装模板改为 workspace-write，新增最小 Home 模板 | 只复制示例，不自动替换现有 Home、认证或 profile |

`--inspect-config` 展示的是 **Agent 合并后的 profile 配置**，不是 CLI 的所有配置层最终结果。
`policy-configured; requires --validate` 不代表工作区已初始化或仓库可用。
模型目录存在、认证文件存在、HTTP 路由可达也都不代表模型请求必然成功。

## 3. 配置职责与建议清理

### codex-profiles.conf：身份及运行策略

保留 Agent 身份、独立 Home、工作目录、sandbox、approval、session mode、timeout、可选模型覆盖，
以及经过准备的 workspacePolicyId。`apiKey` 只用于聚义厅 WebSocket。

建议的保守公共段如下，属于候选配置，不应直接覆盖线上文件：

```ini
[default]
codexBin=/usr/local/bin/codex
codexWorkdir=/home/isp
codexSandbox=workspace-write
codexApproval=never
codexSessionMode=resume
codexTimeoutMs=900000
# 若需要统一模型，在这里填实际网关支持的 model id；不要借本轮优化偷偷换模型。
codexModel=
```

- 每个 Agent 配置明确、互不重叠的 Home；工作目录尽量使用专用目录而非宽泛 `/home/isp`。
- 模型选一个主要配置入口：需要集中管控时用 `codexModel`，Home 的 `model` 只作明确标注的直连 CLI fallback；
  否则移除 profile/环境覆盖，让 Home 管理模型。不要保留两个不同值却都称为“实际模型”。
- `.env` 中的 DEFAULT_CODEX_PROFILE 与各段 isDefault 保持一致；默认选择并不意味着只启动一个 Agent。
- 对已确认没有外部消费者的 `abilities/skills` 旧字段，备份后清理；不要删除磁盘上的实际技能。
- `personaName` 只控制显示身份。若需要角色行为，应在受审阅的工作区指令文件中定义，另行验证 CLI 是否加载。

### config.toml：网关、模型能力、推理档位与本地信任

使用 `/home/isp/apps/codex-ws-agent/codex-home.example.toml` 作为结构参考，不能原样启用其中占位值。

1. 在配置副本中删除顶层 `writable_roots` 和 `preferred_auth_method`：本机 CLI 0.153.4 严格校验不识别它们。
   不要用 grep 全局删除相同名字，其他合法表下可能有同名字段。
2. 统一权限表达，不混用相互矛盾的 `sandbox_mode` 与 `default_permissions`。
   默认采用 workspace-write；确需全权限时明确记录服务账号、允许操作范围、网络需求和风险批准。
   删除 `default_permissions=":workspace"` 而留下 `sandbox_mode="danger-full-access"` 可能扩大权限，**不能机械清理**。
3. 自定义 provider 的实际地址放在 `model_providers.<selected>.base_url`；顶层 `openai_base_url` 不作为该 provider 的第二控制入口。
4. `model_catalog_json` 若网关需要则保留；考虑迁移到稳定、只读、受管理的共享目录。
   本轮不删除自定义目录、不声称其中的模型名就是公网官方模型。
5. 项目信任条目按实际工作区缩小；trusted 不等于允许写入该目录。
6. TUI 引导状态不参与非交互任务，不必为了“精简”而批量清除自动生成状态。
7. 市场来源不等于插件启用列表。移除市场条目前先核实插件依赖；避免长期引用用户 Home 下的临时缓存。
8. 模型认证保存在各 Home 的 auth 文件或配置的凭据存储，不把 WebSocket Key 填成模型 Key。

## 4. 任务与业务能力优化建议（需另行实施）

### 吴用：编码任务

准备受控 repository、worktree root、可信远程 URL/ref，参照 workspace-policies.example.json。
在 `.env` 设置 CODEX_WORKSPACE_POLICIES_FILE，并在吴用 profile 设置 workspacePolicyId。
先验证目录、仓库及远程信任，随后验证任务隔离、并发锁、恢复与归档。
**不能通过删除 requireWorkspace 检查来让 command.dispatch 临时跑起来。**

### 卢俊义：铁路技能任务

先确认铁路 SKILL.md 是否被 CLI 加载、依赖与凭据是否可用，再设计调度能力映射。
当前扫描器只会上报固定业务白名单；单纯写 `abilities=rail-ticket-search` 不会注册铁路能力。
建议后续增加受信任、可验证的业务描述文件和明确白名单，并同步客户端/服务端协议及测试；
不自动根据任意 SKILL.md 名称、技术栈或 persona 推导“可以购票”。
涉及订票/支付等真实外部动作应有独立授权边界，不能以 never 或“技能已安装”替代业务确认。

非编码 command.dispatch 可在可信策略下使用 `dedicated-workdir`，明确列出允许的 commandType，
并使用不重叠、非 Git 的专用目录。具体类型须与服务端实际协议一致，不在这里编造线上类型。

### 林冲及所有 profile：会话和权限

- 将宽泛工作目录迁到实际专用工作区之前，先检查现有会话 cwd 与必要文件权限。
- 当前缺失 conversation 映射时仍可能恢复该 Home 最近会话；本轮只增加可见警告，保留兼容行为。
- 后续建议：有明确 conversationId 但无映射时新建，禁止回退到其他会话；补充并发/恢复/映射丢失测试后迁移。
- 可在后续为“超过超时仍不退出”的子进程加宽限期和进程组强杀；本轮不引入未验证的进程树管理。

## 5. 验证、上线和回滚

### 本地回归

```bash
cd /home/isp/wsps/chcbz/isp-install
for script in install.sh shell/*.sh bin/*.sh; do bash -n "$script" || exit 1; done
node --check conf/codex-ws-agent/agent-client.mjs
node --test conf/codex-ws-agent/test/*.test.mjs
```

新增用例覆盖三种 sandbox 的新建/恢复一致性、模型覆盖/回退、非法参数、0/有限超时、
诊断信息脱敏、无认证诊断、未配置工作区提示，以及诊断不初始化目录。
现有能力白名单与 workspace fail-closed 测试必须继续通过。

### 上线顺序

1. 将补丁移植到实际最新发布源码；记录旧 release、CLI 版本、systemd 单元及配置校验摘要。
2. 用受限权限备份 `.env`、profile、相关 Home 配置与必要会话状态；备份不能提交 Git 或放在公开日志目录。
3. 在隔离目录准备配置副本；先诊断，再使用该主机 CLI 严格校验和不执行模型任务的配置诊断核对。
4. 选择并审阅最终权限策略，尤其是原本通过恢复路径意外处于 workspace-write 的全权限 profile。
5. 不要边运行边逐项编辑被监听的生产 profile 文件；等待任务结束，在维护窗口受控停止服务，原子替换配置，
   执行 --validate（它可能初始化工作区），通过后切换经完整测试的 release 并启动。
6. 分别验证新建聊天、同会话恢复、命令工作区、模型/推理档位、实际 sandbox/network、注册确认及心跳。
   铁路外部动作只做模拟或明确获准的验证，不用真实订票作为普通冒烟测试。
7. 失败时停止新进程，恢复旧 release 和同一批次配置，再验证、启动。不要盲目回滚仍有新任务写入的数据库。

profile 文件默认每 5 秒检查；`.env` 不热加载。更新正在执行的 profile 可能导致断连/中断或重启，
具体行为取决于发布版本。第一轮没有上线；第二轮已执行维护窗口切换，记录见第 7 节。

## 6. 本轮验证记录

- 环境：Alibaba Cloud Linux 3；安装的 Codex CLI 0.153.4。
- 完整回归：133/133 通过。为降低共享主机磁盘 fsync 压力，完整回归的临时夹具使用 `TMPDIR=/run`。
- 完整回归运行期间又补充了布尔值/数组 timeout 拒绝用例；最终配置专项重新执行，21/21 通过。
  现有 114 个用例和新增 21 个用例均有通过记录，不将重叠执行次数当成独立用例数。
- 所有仓库 Shell 脚本逐个 `bash -n`、修改/新增 JS 的 `node --check`、`git diff --check` 通过。
- 新诊断入口在已部署配置上做了只读核对，未执行配置迁移或模型请求。
- systemd 服务保持原 PID 2990525，启动时间仍为 2026-09-08 12:23:18 CST。
- 安装验证门测试使用隔离夹具和重启标记；未在真实主机执行安装/重启流程。
- 新建/恢复传参通过 mock 子进程及 CLI help 参数解析检查；仍需在待发布版本上完成真实会话端到端验收。

## 7. 第二轮线上发布记录（2026-09-09）

- 发布完成：`2026-09-09T10:31:36.270618+08:00`。
- 实际 release：`/home/isp/apps/codex-ws-agent/releases/20260909102948-3657004`。
- 服务验证：active，MainPID 3657704，NRestarts=0；三个 profile 均收到注册确认。
- 249 项完整回归测试通过；三个候选 Home 通过 CLI 0.153.4 `--strict-config` 和 config/read。
- 使用隔离 Home 做两次真实模型请求（新建、恢复），仅回复测试短语，不执行工具/文件/业务动作。
  两轮记录均为 `gpt-5.6-luna`、medium、never、workspace-write、network_access=true，工作目录一致。
  隔离测试认证副本和会话文件已清理，没有污染线上历史。
- 实际安装门和重启后的 `--validate` 均通过：profiles=3、workspacePolicies=1。
- 12 个发布源码/模板/锁文件与本工作区逐字节一致。真实 `.env`、profile、Home、模型目录未复制进仓库。

### 实际配置变化

1. 三个 Agent 统一 `workspace-write`，同时显式启用 sandbox 下联网；不再依赖 full-access 获得联网。
2. 清除不识别的顶层 writable_roots、preferred_auth_method，以及冲突的 default_permissions。
   去掉自定义 provider 不使用的顶层 openai_base_url，保留实际 provider 地址和认证机制。
3. Agent 指定的模型保持 Luna 不变，Home 的直连 CLI fallback 同步为 Luna；推理档位保持 medium。
4. 自定义模型目录复制到受管理的共享文件 `/home/isp/apps/codex-ws-agent/shared/model-catalog.json`，
   三个 Home 不再依赖 `/root/.codex/model-catalog.json`。没有修改模型目录内容。
5. 林冲改用专用工作目录，缩小项目 trusted 条目；吴用保留 CYF 工作目录。
6. 吴用绑定 CYF workspace policy，以既有仓库为可信 repository、独立 worktree root，固定 master 和既有 HTTPS origin。
7. 清除卢俊义 profile 中无效的 abilities/skills 声明，实际技能文件未删除、未自动改变调度白名单。
8. WebSocket Key 和三个 Home 的模型认证内容均未更改；持久配置/认证文件权限检查通过。

**保留的安全边界：**卢俊义、林冲未被强行绑定 CYF 编码仓库。它们的普通 command.dispatch
仍因未配置对应策略而 fail closed，聊天连接保持正常。铁路业务能力映射及真实非编码命令白名单
仍需与服务端协议另行实现，不将“已注册在线”等同于“所有业务命令可执行”。

### 回滚与验证说明

私有备份：`/root/backups/codex-ws-agent/20260909101412`（root-only，含配置及部署证据，不进入 Git）。
首次切换因健康检查使用的 ISO 时间格式不被本机 journalctl 接受，自动恢复了旧配置和旧 release。
随后改为兼容时间格式并按新进程 PID 过滤日志，第二次切换及三 Agent 注册验证成功。
首次尝试和最终成功状态分别保留在私有备份中，未隐藏首次回滚。

### 最终同步检查

安装器补齐 README、`.env.example`、Home 示例的静态兼容入口，并已同步线上对应链接，
避免根目录继续展示旧说明；持久 `.env`、profile、auth、state 不转换成 release 链接。
这项收尾变更的安装器专项 9/9 通过（其他 35 项按名称过滤跳过），未再次重启 Agent。
同步内容已扫描，不含线上 WebSocket/模型密钥字面值；线上配置与认证均为 root-owned、0600。
仓库仅同步通用源码、模板、锁文件、测试和文档，不同步私有 Home、实际 profile、`.env` 或模型目录。
