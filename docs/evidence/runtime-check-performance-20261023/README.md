# Runtime检查性能：定向证据（2026-10-23）

唯一Owner为当前会话，单Agent；候选1.2.8，精确源码/模块SHA和结果见summary.json、audit-inventory.json。来源297272f5固定app候选，生产仍1.2.6；无服务切换、无生产包构建、无模型turn、无517重发。72个现行自有JS/Python模块做全量静态操作点扫描，热点按调用链审查，不等于每个分支动态验收或扫描第三方依赖内部实现。

## 定向测试

使用Node24.22.1，`node --test --test-concurrency=1`，15个入口：codex-ws-agent/test下app-server-integrity-worker、executable-integrity、typed-inspection-network、typed-inspection-profile、chat-runtime、materials-chat、skill-registry、skill-executor、skill-execution-store、workspace-file-bridge、skill-conversation，以及cyf-agent-runtime-v1/test下runtime-host、hosting-lifecycle、interface-agent-ws、interface-runtime-fields（均为.test.mjs）。294项，293通过、0失败、1项显式跳过：带凭据的完整native profile握手。日志保留原始输出；部分fixture导入了离线安装/venv消费回归，未进行真实安装/模型调用。不是正式Flow/浏览器/全业务验收。

覆盖同长改写恢复mtime、资源篡改、inode替换、缓存条件、异步过程PID漂移/取消、迟到启动阻止、真实进程摘要、ACK/session/锁/恢复等原边界。源码语法、71项权威安装清单和相对模块/worker引用闭包另行通过；未制作/发布制品。第一次用旧开发node_modules缺少magick-wasm，属于测试环境缺依赖；已改为只读复用与候选package-lock SHA一致的现行依赖，未在生产目录安装/写入，不能把首次环境失败当产品失败或省略。

## 真实隔离实验

- baseline-three-codex.json：安装1.2.6网络模块、真实292,309,256字节Codex、三并发，2失败/1通过，最大事件循环停顿32.112秒，明确recv timeout。
- candidate-three-codex.json：精确候选网络/完整性模块，原15秒超时、独立bwrap/slirp/netns、原nft默认拒绝、无凭据的Codex app-server holder，3/3通过。每路其他主机端口/直连互联网仍阻断。父Node仅观察时序，不是包级抓取或完整初始化业务turn。
- candidate-real-measurement.json：在独立临时HOME对真实Codex0.161.0做版本/schema/快照/资源测量，无模型/Provider请求；同时用本地HTTP403观测主线程响应。首次冷测与同进程缓存命中耗时不同，不比较为冷测“缩短”保证。所有临时HOME/自己的holder已清理。

脚本保留运行时字节，固定本任务临时证据输出前缀/现行快照路径，复用前需核对源码、工具、身份和路径，不能盲目在其他机器执行。候选三路脚本仅在实验开始前一次性计算期望fixture摘要，避免诊断脚本本身的同步hash污染被测事件循环；这是与旧脚本的差异，不能把总启动耗时当严格同输入吞吐基准。没有CPU/sleep阻塞注入，也不修改主机/生产namespace防火墙。

## 尚未完成/不能推断

- 候选未制作/安装/部署，主机PID仍1183474；不能把源码合入当线上修复。
- 完整native握手、真实二次图片修改与最终验收未执行；已有517失败状态未被本性能变更修复或重放。
- 同步Python成果重开、技能安装原子辅助、Git工作区子进程、资料解析/衍生和队列扫描仍是已知潜在阻塞点，不能无证据删除其验证或宣称全Runtime完全非阻塞。
- 历史14:40现场没有socket时序/并发日志；本次只实证同源码故障机制及候选定向改善，不唯一重建当时并发。
