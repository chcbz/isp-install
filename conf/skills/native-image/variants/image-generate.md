---
name: image-generate
description: 根据用户描述生成图片，可指定画布尺寸；使用本技能单独配置的图片服务。
metadata:
  version: "1.3.1"
---
# 图片生成

仅在任务授权且本技能的配置与网络可用时运行包内 `scripts/image.mjs`。图片理解优先用原生图像载体。需 Node.js >=24.14 和包内 `vendor/` 的 `@imagemagick/magick-wasm` 0.0.45 运行文件；不在任务中下载依赖。

执行环境应提供只读私有配置 `/skill-config/image-generate.json`，字段为 `endpoint`（HTTPS 服务根地址）、`model`、`apiKey`。必须显式传入 `--config /skill-config/image-generate.json`，不要省略或使用其他技能的配置。不要把密钥写入参数、聊天、技能包或日志。脚本显式启用 `HTTPS_PROXY`/`HTTP_PROXY`，无视 `NO_PROXY` 防止绕过代理；不关闭 TLS 验证，CA 须由运行环境在 Node 启动前通过 `NODE_EXTRA_CA_CERTS` 等提供。实际配置、依赖和网络授权由执行环境负责。服务需支持 `/v1/images/generations` 和 `/v1/images/edits` JSON 协议。

```sh
node <本技能目录>/scripts/image.mjs generate --config /skill-config/image-generate.json --prompt '描述' --output /outputs/image.png [--size 800x600]
node <本技能目录>/scripts/image.mjs resize --input /outputs/image.png.provider.png --output /outputs/resized.png --size 800x600
```

只读实际获准的文件；实现尝试识别 PNG、JPEG、WebP、GIF、BMP、TIFF、HEIC/HEIF、AVIF，能否解码取决于实际文件及编码；本包定向回归仅实测 PNG、BMP，解码失败须如实报告，动画/多页需先选择静态帧。尺寸为正整数 `宽x高`，本地等比缩放并居中透明留边，不裁切/拉伸。输出必须是新文件；`--size` 生成/改图成功时原图先保存到 `<output>.provider.png`，缩放失败时仍保留，可使用 `resize` 离线处理。原图和成果皆为草稿，不自动提交；按真实文件选择 stage/propose，不能以脚本成功代替业务完成。

每次 generate/edit 最多发一次请求，不自动重试；发送前留下 `<output>.request-started` 标记，同输出路径重放会拒绝。标记不是成功回执，也不能阻止使用其他路径重发。网络中断、无法解析的响应或本地写入中断可能导致远端结果未知；不得因为重连或错误而自动重发或更换调用身份。报告实际错误、保留已收到原图，后续操作由用户明确决定；不要声称该脚本提供通用的外部调用幂等或跨重启恢复。

## 等待命令和交付文件

图片服务可能超过一次工具等待窗口。调用 `exec_command` 时保留完整返回对象（在 code 模式中可用 `console.log(JSON.stringify(result))`），不要只输出 `output` 或 `exit_code`。返回 `session_id` 表示命令仍在执行：使用 `write_stdin` 轮询同一会话直到终态；一次 yield 结束或暂时没有退出码不是失败，不重新调用生成/编辑服务。

CYF 原生隔离环境只提供有限工具链，不假定存在 `ls`、`file` 或 Python。需要检查文件时可用已提供的 Node.js `node:fs`；命令完成后核对脚本返回的路径、字节数及实际文件。使用本次执行提供的 `artifact_stage` 暂存图片，再用 `result_propose` 提交包含暂存文件引用的结果（仅文件成果的 `data` 为 `null`）。草稿存在或文字回复不等于已提交；提交失败如实报告，不重发已成功的图片服务调用。
