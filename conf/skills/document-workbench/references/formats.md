# 格式处理

## 文本与 HTML

文本使用UTF-8；对比内容而不只检查文件头。HTML展示用户文本时做文本转义；只有用户需要实际运行页面时才交给浏览器。保存大段原文和转换结果到文件，返回所读取范围及必要摘要。

## XLSX

用 `openpyxl.load_workbook` 读取，按用户指定工作表、单元格或列处理。读大表可用 `read_only=True`，顺序写新表可用 `Workbook(write_only=True)`；需要修改现有结构时使用普通模式。关闭已打开的工作簿。

`data_only=True`读取的是文件已有的缓存值，不会计算公式；openpyxl不能重算公式。需要保留公式时不要用缓存值覆盖公式。没有计算引擎时明确“公式已保留但未重算”，不要把旧缓存当新的计算结果。保存后重开文件核对相关工作表、表头和实际数值。

## 文本型 PDF

用 `pypdf.PdfReader` 读取页数及各页 `extract_text()`；需要页面操作时用 `PdfWriter`。未提供密码的加密文件或损坏文件可能无法读取。扫描页面没有文本不等于内容为空；本技能不提供OCR，不编造抽取文本，也不把抽取文字等同于理解图表。

## 中文 PDF

为当前内容编写HTML，声明UTF-8并使用 `font-family: "Noto Sans CJK SC"`，复用共享工具：

```js
import { readFile } from 'node:fs/promises';
import { withBrowser } from '/usr/lib/cyf-browser/browser-session.mjs';
await withBrowser(async ({ page }) => {
  await page.setContent(await readFile('/workspace/report.html', 'utf8'));
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({ path: '/outputs/report.pdf', format: 'A4', printBackground: true });
});
```

路径是任务内的例子，按实际工作区和输出要求调整。HTML应自包含；需要外部资源时必须有本次执行的网络许可，不通过换域名、关闭TLS校验或换宿主浏览器规避限制。

生成后用pypdf重开，检查页数及中文文本；浏览器字体映射可能把“文”抽取为兼容部首“⽂”。语义比较可对期望值和实际文本都使用 `unicodedata.normalize('NFKC', text)`，同时保留原始抽取结果；规范化不能替代缺失字符。需要版式验收时另做视觉检查，纯文字抽取不能证明没有裁切或遮挡。
