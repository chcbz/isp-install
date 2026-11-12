> 整理日期2026-10-23。来源为历史用户请求、最终报告及既有spec/handoff；本轮不重新验证历史部署/服务或第三方规则。保留差异与未完成状态，非逐字聊天备份，不含密码/验证码。

# isp-install历史会话接续规格

## 历史确认与边界
- 独立项目会话曾确认master与origin/master为bfa917b3986b（修复一次过期workspace队列socket重连），不是今天版本或线上安装的证明。
- 相关Runtime子任务虽cwd记录为CYF，实际代码落在本仓：D03 work.result持久化/outbox、精确回执绑定、多Owner managed-host、统一Runtime、自家接应、UNKNOWN退避、固定目录安装。对应来源详见CYF历史索引，不重复恢复被停止子任务。
- 配置/身份/授权/会话/ACK与程序分离；准备制品不自动激活，不隐式迁移状态或重enroll，不覆盖已有其他修复。
- CYF Runtime固定app目录是**CYF限定**规则，不泛化修改其他实例/项目。已有固定目录迁移记录在 `/home/isp/wsps/cyf/docs/implementation/handoffs/RUNTIME-FIXED-DIR-20261023.md`：安装器297272f5合develop，实际1.2.6内容迁移，候选1.2.7尚未发布；以现行运行核对为准。
- 保留版本、完整commit/tree、依赖锁和制品摘要，历史内容归档baks。系统命令、venv绝对路径、systemd与最终路径一致；不能移动在用旧目录或直接改链接假定完成。
- 安装脚本语法/隔离回归不等于实际安装、通道健康及业务验收；部署/重启/主机修改均按具体授权。

## 接续
以本仓当前AGENTS和self-host/安装指南为入口，引用CYF规则时明确限定作用域。先核对主checkout/develop/安装版本，不把旧master同步确认当新候选已合并。此次仅文档归纳，无源码/服务变更。
