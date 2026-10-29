# wx2md

微信公众号文章 → 干净 Markdown(图片本地化)+ 原文配色 HTML/PDF,一条管线。

## 安装

需要 Node.js ≥ 18。

```bash
git clone https://github.com/HeShen-1/wx2md.git
cd wx2md
npm install
```

puppeteer 会把 Chrome 装到 `~/.cache/puppeteer`(免 sudo);官方 CDN 慢时可换镜像:

```bash
PUPPETEER_DOWNLOAD_BASE_URL=https://cdn.npmmirror.com/binaries/chrome-for-testing npm install
```

## 用法

```bash
node wx2md.mjs <文章URL> --out <输出目录>
```

例:

```bash
node wx2md.mjs 'https://mp.weixin.qq.com/s/xxxxxxxx' --out ./articles
```

### 已增强文章刷新 PDF

md 经手工视觉增强(callout / 内联 CSS 卡片 / details)后,**不能用 wx2md.mjs 重跑**(会覆盖 md)。用 `render-pdf.mjs` 直接从现有 md 重出 PDF:

```bash
node render-pdf.mjs '<文章目录>/<标题>.md'
```

frontmatter 提供 title/account/author/date/source/fetched;Obsidian callout 转成带色条的 div,`<details>` 打印前强制展开。

参数:

| 参数 | 说明 |
| --- | --- |
| `--out <dir>` | 输出根目录;默认本机 Obsidian 收藏目录 `AI文章/微信公众号`(源码内 `DEFAULT_OUT_ROOT`,可用 env `WX2MD_OUT` 覆盖) |
| `--no-pdf` | 只出 md + html + 图片,不出 PDF |

## 输出结构

```
<out>/<标题>/<标题>.md     # 干净 md,笔记用,frontmatter 带标题/公众号/日期/原文链接
<out>/<标题>/<标题>.html   # 原文配色渲染(品牌色/色块卡片/引用框),浏览器即读
<out>/<标题>/<标题>.pdf    # 从 html 渲染,A4,带页码,样式同 html
<out>/<标题>/assets/       # 全部图片,md 与 html 共用
```

md 是干净的文本源(纯 markdown,不携带样式);HTML/PDF 不由 md 渲染,而是直接采用转换前的微信原 DOM,原文配色与卡片布局得以保留。三路产物文字内容一致。

## 已知限制

- 只处理免登录可见的文章(绝大多数公众号正文);需验证/付费的拿不到 `#js_content` 会直接报错。
- 微信视频嵌入(`mpvoice`/`mpvideo`)不转,正文保留文字部分。
- `var author` 常被微信填成公众号名,与公众号名相同时不写 author 字段。
- 防盗链图片下载失败时回退为保留远程 URL 并打警告,不会中断。

## 标签映射(通用能力)

输入是微信生态实际出现的 HTML 标签全集(基于多篇真实文章盘点,腾讯/美团两种排版风格),逐类映射:

| 输入 | 输出 | 方式 |
| --- | --- | --- |
| `img[data-src]` | `![](assets/…)`(下载) | turndown 规则 |
| inline `<svg>`(MathJax 公式) | `![](assets/formula-NNN.svg)` | 预处理序列化 |
| `<embed data-type="svg+xml">`(远程公式) | `![](assets/…svg)`(下载) | 预处理转 img |
| `figcaption` / 启发式图名 | `<p align="center">…</p>` | turndown 规则 |
| `th/td`(内容包块级元素) | 压平单行的 GFM 表格 | turndown 规则 |
| `sup/sub/u/mark/kbd` | 保留 HTML 内联标签 | turndown 规则(去 md 转义) |
| `s/strike/del` | `~~删除线~~` | turndown 规则 + gfm |
| `mpvoice/mpvideo/mpaudio/video/audio` | `（此段为X，[原文查看](…)）` 占位 | 预处理(空元素会被 turndown blank 规则吞掉) |
| `section[data-role="hr"]` | `---` | 预处理(同上) |
| `mp-common-profile/mpprofile/mp-style-type/iframe` | 移除 | turndown remove |
| 标题/列表/引用/代码/表格/链接/粗斜体 | 原生 md 语法 | turndown + gfm(`emDelimiter:'*'`,中文安全) |
| `pre` 含多个 `<code>`(微信 code-snippet) | 合并为单个 `<code>`,行间补 `\n` | 预处理(gfm 的 fencedCodeBlock 只读 firstChild,不合并则第 2 行起全部丢失;同时删 `code-snippet__line-index` 行号列表、空 `<code>` 过滤、nbsp 转空格) |
| | `pre` 首子元素非 `<code>`(mdnice 装饰条) + 单 `<code>` | 删装饰 span、`<br/>`→`\n`、nbsp→空格、按 token 边界补回被微信剥掉的关键词空格(`def__init__`→`def __init__`,词表覆盖 py/go/java/c/js/sql,逻辑在 `code-blocks.mjs`) | 预处理(gfm fencedCodeBlock 要求 pre.firstChild 是 `<code>`,否则整块退化为一行行内代码);嵌套 `<section><code>` 一并下钻恢复 |
| 裸 `<pre>`(无 `<code>`) | 按内容分派:CJK 标点散文(文末推广语/诗句)→还原段落;代码样文本(ASCII 图)→围栏 | 预处理(旧版:含 code 的 pre 未命中规则时静默丢弃/降级,纯装饰 pre 删除) |
| 围栏代码块语言标注 | 内容启发式推断(python/json/js/go/java/sql/bash/yaml),推断不出保持裸围栏 | `code-lang.mjs`,turndown 后处理 |
| `<strong>`(输出后处理) | `<strong>…</strong>` | `**` 贴中文标点违反 CommonMark 侧翼规则(如 `的**“x”**` 打不开、`】：**` 闭不上,Obsidian 显示原始星号),换 HTML 标签;行内代码与围栏代码块跳过 |
| `<span style="font-weight: bold/600…">` | `<strong>`(预处理) | 公众号编辑器用行内样式而非 `<strong>` 表达加粗(实测一篇文章 229 处样式加粗 vs 10 个 `<strong>`),turndown 会剥掉样式导致加粗整体丢失;`font-style: italic` 同理升为 `<em>`;纯空白与包块级元素的 span 跳过 |

fixture 测试 `test.mjs` 覆盖映射表每一行:`node test.mjs`。

## 图名(caption)识别规则

图片下方的图名会被转成居中灰字(`<p align="center">…</p>`),识别分两层:

1. **语义标签(精确,优先)**:编辑器输出的原生 `<figcaption>` —— 现代微信编辑器(mdnice/135/秀米新版)基本都是这种。
2. **结构启发式(保守,兜底)**:没有 figcaption 时,满足**全部**条件才算图名:
   - 纯文本叶子段落(不含列表/表格/图片/标题等结构)
   - 紧邻的前一个兄弟(跳过一个空段)子树里含图片
   - 自身或祖先链 `text-align: center`
   - 短文本:默认 ≤100 字;以 `▲ △ ▼ ▽ ◇ ◆ ● ○ ■ □ ※ ◎` 或 `图 N`/`Fig. N` 开头放宽到 160 字

设计取向:**漏判无害**(降级为普通段落,内容不丢),**误判有害**(正文被错标成图名)—— 所以结构条件从严,不依赖任何特定符号。识别不了的老文章图名会留在正文里,内容零损失。

## License

[MIT](LICENSE)
