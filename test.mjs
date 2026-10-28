#!/usr/bin/env node
// Fixture test for the wx2md turndown rules — covers the full tag map,
// independent of any single real article. Run: node test.mjs
import { strict as assert } from 'node:assert';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import * as cheerio from 'cheerio';
import { normalizeCodeBlocks } from './code-blocks.mjs';
import { inferCodeLang, inferCodeLangs } from './code-lang.mjs';

// Mirror of the rules in wx2md.mjs. Kept in sync deliberately: if this test
// and the tool drift apart, the tool is the source of truth — update both.
const url = 'https://mp.weixin.qq.com/s/TEST';

function mdInlineToHtml(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*\s][^*]*?)\*/g, '<i>$1</i>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>');
}

function buildTurndown(imgMap) {
  const td = new TurndownService({ headingStyle: 'atx', hr: '---', bulletListMarker: '-', codeBlockStyle: 'fenced', br: '  ', emDelimiter: '*' });
  td.use(gfm);
  td.remove(['script','style','noscript','mpchecktext','iformix','mp-common-profile','mpprofile','mp-style-type','iframe']);
  td.addRule('wechat-image', {
    filter: 'img',
    replacement: (_c, node) => {
      const alt = (node.getAttribute('alt') || '').replace(/[\[\]\n"]/g, ' ').trim();
      const localAttr = node.getAttribute('data-wx-local');
      if (localAttr) return `\n\n<div align="center"><img src="${localAttr}" alt="${alt}"></div>\n\n`;
      const src = node.getAttribute('data-src') || node.getAttribute('src') || '';
      if (!src) return '';
      const target = imgMap.get(src) || src;
      return `\n\n<div align="center"><img src="${target}" alt="${alt}"></div>\n\n`;
    },
  });
  td.addRule('wechat-link', {
    filter: 'a',
    replacement: (content, node) => {
      const href = node.getAttribute('href') || '';
      let text = content.trim();
      if (!text) text = (node.getAttribute('textvalue') || '').trim();
      if (!href) return text;
      if (!text) return '';
      return `[${text}](${href})`;
    },
  });
  const keepInline = (tag) => td.addRule(`keep-${tag}`, {
    filter: tag,
    replacement: (c) => {
      const t = c.trim().replace(/\\([[\]`*_])/g, '$1'); // inside HTML, markdown escapes show literally
      return t ? `<${tag}>${t}</${tag}>` : '';
    },
  });
  ['sup','sub','u','mark','kbd'].forEach(keepInline);
  td.addRule('strikethrough-s', {
    filter: ['s','strike'],
    replacement: (c) => (c.trim() ? `~~${c.trim()}~~` : ''),
  });
  td.addRule('wechat-figcaption', {
    filter: (node) => node.nodeName === 'FIGCAPTION' || node.getAttribute?.('data-wx-caption') === '1',
    replacement: (content) => {
      const t = mdInlineToHtml(content.replace(/\s*\n+\s*/g, ' ').trim());
      return t ? `\n\n<p align="center">${t}</p>\n\n` : '';
    },
  });
  td.addRule('wechat-table-cell', {
    filter: ['th','td'],
    replacement: (content, node) =>
      `${node.previousElementSibling ? '' : '| '}${content.replace(/\s*\n+\s*/g, ' ').trim()} |`,
  });
  return td;
}

const imgMap = new Map([['https://mmbiz.qpic.cn/x/640?wx_fmt=png', 'assets/img-001.png']]);
const td = buildTurndown(imgMap);
// Mirror of preprocessWeirdTags() in wx2md.mjs. Code-block normalisation is
// imported from code-blocks.mjs — shared, not mirrored.
function preprocessWeirdTags($) {
  $('#js_content').find('section[data-role="hr"]').replaceWith('<hr>');
  normalizeCodeBlocks($('#js_content'));
  const kind = { mpvoice: '语音', mpvideo: '视频', mpaudio: '音频', video: '视频', audio: '音频' };
  $('#js_content').find('mpvoice, mpvideo, mpaudio, video, audio').each((_, el) => {
    const k = kind[el.tagName.toLowerCase()] || '媒体';
    $(el).replaceWith(`<p>（此段为${k}，<a href="${url}">原文查看</a>）</p>`);
  });
}

// Mirror of promoteStyledEmphasis() in wx2md.mjs.
function promoteStyledEmphasis($) {
  const hasBold = (s) => /font-weight\s*:\s*(bold|[5-9]\d{2})/i.test(s || '');
  const hasItalic = (s) => /font-style\s*:\s*italic/i.test(s || '');
  const spans = $('#js_content').find('span').get().reverse();
  for (const el of spans) {
    const $el = $(el);
    const b = hasBold($el.attr('style'));
    const i = hasItalic($el.attr('style'));
    if (!b && !i) continue;
    if (!$el.text().trim()) continue;
    if ($el.find('p, div, section, table, ul, ol, h1, h2, h3, h4, h5, h6, blockquote, pre').length) continue;
    const inner = $el.html() || '';
    if (b) $el.replaceWith(`<strong>${i ? `<em>${inner}</em>` : inner}</strong>`);
    else $el.replaceWith(`<em>${inner}</em>`);
  }
}

// Mirror of the md post-processing in wx2md.mjs.
function normalizeDecorativeLines(md) {
  return md
    .replace(
      /^[ \t]*\\?[ \t]*[-—=_*·~]{3,}[ \t ]+(\S[^\n]{0,28}?)[ \t ]+[-—=_*·~]{3,}[ \t]*$/gm,
      (_f, mid) => `\n<p align="center">${mdInlineToHtml(mid.trim())}</p>\n`,
    )
    .replace(/^[ \t]*\\?[-—=_*·~]{3,}[ \t ]*$/gm, '---');
}
function linkTocItems(md) {
  const heads = [...md.matchAll(/^#{2,6} (.+)$/gm)].map((m) => m[1].trim());
  if (!heads.length) return md;
  const norm = (s) => s.replace(/[\s ]+/g, '');
  const byKey = new Map(heads.map((h) => [norm(h), h]));
  return md.replace(/^(\s*(?:[-*+]|\d+[.)])[ \t]+)(.+?)[ \t]*$/gm, (full, pre, text) => {
    const t = text.trim();
    if (/[[\]]/.test(t)) return full;
    const hit = byKey.get(norm(t));
    if (!hit) return full;
    return `${pre}[${t}](#${encodeURIComponent(hit)})`;
  });
}

const cases = [
  ['figcaption', '<figure><img data-src="https://mmbiz.qpic.cn/x/640?wx_fmt=png" alt="▲ 图一"><figcaption><span leaf="">▲ 图一</span></figcaption></figure>',
    (o) => { assert.ok(o.includes('<div align="center"><img src="assets/img-001.png" alt="▲ 图一"></div>'), 'centered img'); assert.ok(o.includes('<p align="center">▲ 图一</p>'), 'caption line'); }],
  ['native img data-src', '<p><img data-src="https://mmbiz.qpic.cn/x/640?wx_fmt=png"></p>',
    (o) => assert.match(o, /<div align="center"><img src="assets\/img-001\.png" alt=""><\/div>/)],
  ['local formula img', '<p><img data-wx-local="assets/formula-001.svg" alt=""></p>',
    (o) => assert.match(o, /<div align="center"><img src="assets\/formula-001\.svg" alt=""><\/div>/)],
  ['empty anchor with textvalue', '<p><a href="https://example.com/x" textvalue="标题文字" linktype="text"></a></p>',
    (o) => assert.ok(o.includes('[标题文字](https://example.com/x)'))],
  ['empty anchor without textvalue dropped', '<p>前文 <a href="https://example.com/y"></a> 后文</p>',
    (o) => { assert.ok(!o.includes('](')); assert.ok(o.includes('前文')); assert.ok(o.includes('后文')); }],
  ['caption bold becomes HTML', '<figure><img data-src="https://mmbiz.qpic.cn/x/640?wx_fmt=png"><figcaption><p><strong>总第 494</strong><strong>篇</strong></p></figcaption></figure>',
    (o) => { assert.ok(o.includes('<p align="center"><b>总第 494</b> <b>篇</b></p>') || o.includes('<b>总第 494</b>'), JSON.stringify(o)); assert.ok(!o.includes('**'), 'no literal ** inside HTML'); }],
  ['caption with link becomes HTML anchor', '<figcaption><a href="https://x.com">说明</a> 详见</figcaption>',
    (o) => { assert.ok(o.includes('<a href="https://x.com">说明</a>')); assert.ok(!o.includes('](https://x.com)')); }],
  ['sup', '<p>X<sup>2</sup> 系数</p>', (o) => assert.ok(o.includes('<sup>2</sup>'))],
  ['sub', '<p>H<sub>2</sub>O</p>', (o) => assert.ok(o.includes('<sub>2</sub>'))],
  ['u', '<p><u>下划线</u></p>', (o) => assert.ok(o.includes('<u>下划线</u>'))],
  ['mark', '<p><mark>高亮</mark></p>', (o) => assert.ok(o.includes('<mark>高亮</mark>'))],
  ['kbd', '<p>按 <kbd>Ctrl</kbd></p>', (o) => assert.ok(o.includes('<kbd>Ctrl</kbd>'))],
  ['s strike', '<p><s>旧</s> 和 <strike>更旧</strike></p>', (o) => { assert.ok(o.includes('~~旧~~')); assert.ok(o.includes('~~更旧~~')); }],
  ['link', '<p>见 <a href="https://example.com/a?b=1&amp;c=2">文档</a></p>', (o) => assert.ok(o.includes('[文档](https://example.com/a?b=1&c=2)'))],
  ['code block', '<pre><code class="language-go">func main() {}</code></pre>', (o) => assert.ok(o.includes('```\nfunc main() {}\n```') || o.includes('```go'))],
  ['wechat code snippet (multi <code> per <pre>)',
    '<section class="code-snippet__fix"><ul class="code-snippet__line-index"><li></li><li></li><li></li></ul><pre class="code-snippet__js"><code><span leaf="">┌──────────┐</span></code><code><span leaf=""></span></code><code><span leaf="">&nbsp; │ hi there │</span></code><code><span leaf="">└──────────┘</span></code></pre></section>',
    (o) => { assert.ok(o.includes('┌──────────┐\n  │ hi there │\n└──────────┘'), JSON.stringify(o)); assert.ok(!o.includes('code-snippet')); }],
  ['wechat code snippet single code untouched', '<pre class="code-snippet__js"><code><span leaf="">just one line</span></code></pre>',
    (o) => assert.ok(o.includes('just one line'))],
  ['inline code', '<p>运行 <code>npm test</code> 即可</p>', (o) => assert.ok(o.includes('`npm test`'))],
  ['blockquote', '<blockquote><p>引用内容</p></blockquote>', (o) => assert.ok(o.includes('> 引用内容'))],
  ['list', '<ul><li>甲</li><li>乙</li></ul>', (o) => { assert.match(o, /-\s+甲/); assert.match(o, /-\s+乙/); }],
  ['ordered list', '<ol><li>一</li><li>二</li></ol>', (o) => { assert.match(o, /1\.\s+一/); assert.match(o, /2\.\s+二/); }],
  ['heading', '<h2>标题</h2>', (o) => assert.ok(o.includes('## 标题'))],
  ['hr', '<hr>', (o) => assert.ok(o.includes('---'))],
  ['mdnice hr', '<section data-role="hr"></section>', (o) => assert.ok(o.includes('---'))],
  ['table (WeChat style, p-wrapped cells)', '<table><thead></thead><tbody><tr><th style="x"><p><span leaf="">列A</span></p></th><th><p><span leaf="">列B</span></p></th></tr><tr><td><p><span leaf="">1</span></p></td><td><p><span leaf="">2</span></p></td></tr></tbody></table>',
    (o) => { assert.ok(o.includes('| 列A |列B |'), JSON.stringify(o)); assert.ok(o.includes('| --- |')); assert.ok(o.includes('| 1 |2 |')); }],
  ['mp-voice placeholder', '<p>听这段：</p><mpvoice src="x"></mpvoice>', (o) => assert.ok(o.includes('（此段为语音，[原文查看](https://mp.weixin.qq.com/s/TEST)）'))],
  ['mpvideo placeholder', '<mpvideo src="x"></mpvideo>', (o) => assert.ok(o.includes('（此段为视频，[原文查看]'))],
  ['profile card removed', '<p>正文</p><mpprofile data-id="x"></mpprofile>', (o) => { assert.ok(!o.includes('mpprofile')); assert.ok(o.includes('正文')); }],
  ['old profile card removed', '<mp-common-profile></mp-common-profile>', (o) => assert.ok(o.trim() === '')],
  ['mp-style-type removed', '<p>文</p><mp-style-type></mp-style-type>', (o) => assert.ok(o.includes('文'))],
  ['iframe removed', '<p>文</p><iframe src="https://x"></iframe>', (o) => assert.ok(!o.includes('iframe'))],
  ['bold/italic', '<p><strong>粗</strong> 和 <em>斜</em></p>', (o) => { assert.ok(o.includes('**粗**')); assert.ok(o.includes('*斜*'), `em should use *: ${JSON.stringify(o)}`); }],
  ['styled bold span promoted', '<p><span style="font-weight: bold;">关键结论</span></p>', (o) => assert.ok(o.includes('**关键结论**'), JSON.stringify(o))],
  ['styled numeric weight promoted', '<p>前<span style="letter-spacing: 0.034em;font-weight: 600;">中权重</span>后</p>', (o) => assert.ok(o.includes('**中权重**'), JSON.stringify(o))],
  ['styled italic span promoted', '<p><span style="font-style: italic;">着重</span></p>', (o) => assert.ok(o.includes('*着重*'), JSON.stringify(o))],
  ['normal weight span untouched', '<p><span style="font-weight: normal;">普通</span></p>', (o) => assert.ok(!o.includes('**'), JSON.stringify(o))],
  ['nested bold spans keep text', '<p><span style="font-weight: bold;">外层<span style="font-weight: bold;">内层</span></span></p>', (o) => { assert.ok(o.includes('外层')); assert.ok(o.includes('内层')); assert.ok(o.includes('**'), JSON.stringify(o)); }],
  ['whitespace bold span skipped', '<p>甲<span style="font-weight: bold;"> </span>乙</p>', (o) => { assert.ok(!o.includes('****')); assert.ok(o.includes('甲')); assert.ok(o.includes('乙')); }],
  ['mdnice single-code: decoration + token spans + br → fenced, keywords repaired',
    '<pre data-tool="mdnice编辑器"><span data-cacheurl="" style="display: block;background-image: url(https://mmbiz.qpic.cn/x.svg)"></span><code style="display: -webkit-box;"><span style="color: #5c6370;font-style: italic;line-height: 26px;"><span leaf=""># 框架</span></span><span leaf=""><br  /></span><span style="line-height: 26px;"><span style="color: #c678dd;line-height: 26px;"><span leaf="">class</span></span></span><span style="color: #e6c07b;line-height: 26px;"><span leaf="">Demo</span></span><span leaf="">:</span></span><span leaf=""><br  /></span><span leaf="">&nbsp;&nbsp;&nbsp;&nbsp;</span><span style="line-height: 26px;"><span style="color: #c678dd;"><span leaf="">def</span></span></span><span leaf="">__init__</span><span leaf="">(self):</span><span leaf=""><br  /></span><span leaf="">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;self.x = 1</span></code></pre>',
    (o) => {
      assert.ok(o.includes('```\n# 框架\nclass Demo:\n    def __init__(self):\n        self.x = 1\n```'), JSON.stringify(o));
      assert.ok(!o.includes('classDemo') && !o.includes('def__init__'), 'keyword spacing repaired');
      assert.ok(!o.includes('*'), 'italic comment spans not promoted inside code');
    }],
  ['mdnice decoration after code still removed',
    '<pre><code><span leaf="">ok(1)</span></code><span style="display: block;background-image: url(https://mmbiz.qpic.cn/x.svg)"></span></pre>',
    (o) => assert.ok(o.includes('```\nok(1)\n```'), JSON.stringify(o))],
  ['bare <pre> without <code> keeps text as fenced block',
    '<pre>┌─────┐\n│ box │\n└─────┘</pre>',
    (o) => assert.ok(o.includes('```\n┌─────┐\n│ box │\n└─────┘\n```'), JSON.stringify(o))],
  ['decoration-only <pre> dropped silently',
    '<p>前文</p><pre><span style="background-image: url(https://x/y.svg)"></span></pre><p>后文</p>',
    (o) => { assert.ok(o.includes('前文') && o.includes('后文')); assert.ok(!o.includes('```')); }],
  ['section-wrapped <code> inside <pre> recovered',
    '<pre><section><code><span leaf="">hi()</span></code></section></pre>',
    (o) => assert.ok(o.includes('```\nhi()\n```'), JSON.stringify(o))],
  ['multi-code lines: <br/> inside a line-code keeps both lines',
    '<section class="code-snippet__fix"><pre><code><span leaf="">a</span><br><span leaf="">b</span></code><code><span leaf="">c</span></code></pre></section>',
    (o) => assert.ok(o.includes('a\nb\nc'), JSON.stringify(o))],
  ['java int[] must not gain a space',
    '<pre><code><span leaf="">int</span><span leaf="">[</span><span leaf="">]</span><span leaf=""> x = 1;</span></code></pre>',
    (o) => assert.ok(o.includes('int[] x = 1;'), JSON.stringify(o))],
  ['go func repaired at token boundary',
    '<pre><code><span leaf="">func</span><span leaf="">main()</span></code></pre>',
    (o) => assert.ok(o.includes('func main()'), JSON.stringify(o))],
  ['sql uppercase repaired',
    '<pre><code><span leaf="">SELECT</span><span leaf="">id</span></code></pre>',
    (o) => assert.ok(o.includes('SELECT id'), JSON.stringify(o))],
  ['inline code with span children stays inline',
    '<p>运行 <code><span leaf="">npm test</span></code> 即可</p>',
    (o) => assert.ok(o.includes('`npm test`'), JSON.stringify(o))],
  ['bare <pre> with CJK promo prose degrades to paragraph, not fence',
    '<p>正文完</p><pre><span leaf="">👆👆👆欢迎关注，一起进步👆👆👆欢迎留言讨论哈🧐点赞、分享、推荐，一键三连，养成习惯👍</span></pre>',
    (o) => { assert.ok(o.includes('欢迎关注，一起进步'), JSON.stringify(o)); assert.ok(!o.includes('```')); }],
  ['html entities in bare pre stay escaped',
    '<pre>a &lt; b &amp;&amp; c &gt; d</pre>',
    (o) => assert.ok(o.includes('a < b && c > d'), JSON.stringify(o))],
];

let failed = 0;
for (const [name, html, check] of cases) {
  try {
    // mimic main(): strip junk, then normalise empty custom elements, as the tool does
    const $ = cheerio.load(`<div id="js_content">${html}</div>`);
    $('#js_content').find('script, style, noscript, mpchecktext, iformix, mp-common-profile, mpprofile, mp-style-type, iframe').remove();
    preprocessWeirdTags($);
    promoteStyledEmphasis($);
    const out = td.turndown($('#js_content').html() || '');
    check(out.replace(/\n{3,}/g, '\n\n'));
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}: ${e.message.split('\n')[0]}`);
  }
}

// post-processing tests (plain md text, no turndown)
function dedupeInlineLinks(md) {
  return md
    .split('\n')
    .map((line) => {
      const re = /\[([^\]]*)\]\((https?:[^)\s]+)\)/g;
      const urls = new Map();
      for (const m of line.matchAll(re)) {
        const prev = urls.get(m[2]);
        if (!prev || m[1].length > prev.length) urls.set(m[2], m[1]);
      }
      if (!urls.size) return line;
      let out = line;
      for (const [url, keepText] of urls) {
        const esc = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        let kept = false;
        out = out.replace(new RegExp(`\\[[^\\]]*\\]\\(${esc}\\)`, 'g'), () => {
          if (kept) return '';
          kept = true;
          return `[${keepText}](${url})`;
        });
      }
      return out.replace(/\*\*\s*\*\*/g, '').replace(/(?<=\S) {2,}(?=\S)/g, ' ');
    })
    .join('\n');
}
const postCases = [
  ['decorative END line', '\\----------\u00A0 END\u00A0 ----------',
    (o) => { assert.ok(o.includes('<p align="center">END</p>'), JSON.stringify(o)); assert.ok(!o.includes('----------')); }],
  ['escaped bare rule', '\\---  ', (o) => assert.equal(o.trim(), '---')],
  ['bare rule', '------', (o) => assert.equal(o.trim(), '---')],
  ['plain text untouched', '价格是 100-200 元', (o) => assert.equal(o, '价格是 100-200 元')],
  ['toc item linked', '## 1 背景\n\n正文。\n\n- 1 背景\n- 2 无关项',
    (o) => { assert.ok(o.includes('[1 背景](#1%20%E8%83%8C%E6%99%AF)'), JSON.stringify(o)); assert.ok(o.includes('- 2 无关项')); }],
  ['already-linked item untouched', '## 1 背景\n\n- [外部](https://x.com/y)', (o) => assert.ok(o.includes('[外部](https://x.com/y)'))],
  ['duplicate-url links deduped, longer label kept',
    '**| [标题甲](https://x.com/a)** [标题甲](https://x.com/a)',
    (o) => { assert.equal((o.match(/https:\/\/x\.com\/a/g) || []).length, 1); assert.ok(o.includes('[标题甲](https://x.com/a)')); }],
  ['different urls untouched', '[a](https://x.com/1) [b](https://x.com/2)',
    (o) => { assert.ok(o.includes('[a](https://x.com/1)')); assert.ok(o.includes('[b](https://x.com/2)')); }],
];
for (const [name, md, check] of postCases) {
  try {
    check(dedupeInlineLinks(linkTocItems(normalizeDecorativeLines(md))));
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}: ${e.message.split('\n')[0]}`);
  }
}

// strong → <strong>: `**` flanking CJK text breaks CommonMark, mirror of the
// post-turndown pass in wx2md.mjs.
function cjkSafeStrong(md) {
  const lines = md.split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    lines[i] = lines[i]
      .split(/(`[^`]*`)/g)
      .map((p) => (p.startsWith('`') ? p : p.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')))
      .join('');
  }
  return lines.join('\n');
}
const strongCases = [
  ['cjk-punct open (的**“x”**)', '残酷的**“淘汰赛”**。', (o) => assert.ok(o.includes('残酷的<strong>“淘汰赛”</strong>。'))],
  ['cjk-punct close (】：**后文)', '**结论：**感知层', (o) => assert.ok(o.includes('<strong>结论：</strong>感知层'))],
  ['plain pair still swapped', '这是**加粗**文本', (o) => assert.ok(o.includes('这是<strong>加粗</strong>文本'))],
  ['inline code protected', '运行 `a ** b` 与 **粗**', (o) => assert.ok(o.includes('`a ** b`') && o.includes('<strong>粗</strong>'))],
  ['fenced block protected', '```go\nx := a ** b\n```\n后文**粗**', (o) => assert.ok(o.includes('a ** b') && o.includes('<strong>粗</strong>'))],
];
for (const [name, md, check] of strongCases) {
  try {
    check(cjkSafeStrong(md));
    console.log(`  ok   strong: ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL strong: ${name}: ${e.message.split('\n')[0]}`);
  }
}
// code-lang: language inference from block text — shared module, exercised
// directly. Bare-safe default: unknown/prose blocks must return ''.
const langCases = [
  ['chinese prompt prose → bare', '介绍一下李白', ''],
  ['numbered prompt prose → bare', '1. 先分析用户的请求', ''],
  ['comment-led prompt prose → bare', '# 思考步骤\n首先观察以下案例', ''],
  ['triple-quote assignment → python', 'prompt = """\n# 角色\n你是一位专家\n"""', 'python'],
  ['strict json → json', '{"a": 1, "b": [2, 3]}', 'json'],
  ['smart-quoted json → json', '{\n  ”session_id”: ”abc123”,\n  ”user_id”: ”user_456”\n}', 'json'],
  ['jsonl multi-line → json', '{"data":{"instruction": "a"}}\n{"data":{"instruction": "b"}}', 'json'],
  ['wrapped/truncated json → json', '{"data":{"instruction":"我想听音乐\n","_itag_index":""},"label-1":{"results":[]}}', 'json'],
  ['cjk unicode arrow prose → bare', '用户消息 → 意图识别 → 记忆维护', ''],
  ['cjk ascii-arrow prose → bare', '输入 => 处理 => 输出', ''],
  ['capitalized prose colon lines → bare', 'Note: hello there\nWarning: it may fail', ''],
  ['lowercase yaml pairs → yaml', 'server_name: demo\nport: 8080', 'yaml'],
  ['shell verbs → bash', 'cd /data && export TMPDIR=/tmp\npip install requests', 'bash'],
  ['go → go', 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hi")\n}', 'go'],
  ['java → java', 'public class Demo {\n    public static void main(String[] args) {}\n}', 'java'],
  ['python class not stolen by java', 'class A:\n    def b(self):\n        pass', 'python'],
  ['chatml template → bare', '<|im_start|>system\n你是一个意图识别专家', ''],
];
for (const [name, code, want] of langCases) {
  try {
    assert.equal(inferCodeLang(code), want, `got ${JSON.stringify(inferCodeLang(code))}`);
    console.log(`  ok   lang: ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL lang: ${name}: ${e.message.split('\n')[0]}`);
  }
}

// inferCodeLangs: full-document fence tagging
const docCases = [
  ['bare python fence tagged, prose fence untouched',
    '```\nclass A:\n    def b(self):\n        pass\n```\n\n```\n介绍一下李白\n```',
    (o) => { assert.ok(o.includes('```python\nclass A:'), JSON.stringify(o)); assert.ok(o.includes('```\n介绍一下李白\n```')); }],
  ['already-tagged fences untouched',
    '```json\n{"a": 1}\n```\n```\nplain\n```',
    (o) => { assert.ok(o.includes('```json\n{"a": 1}\n```')); assert.ok(o.includes('```\nplain\n```')); }],
];
for (const [name, md, check] of docCases) {
  try {
    check(inferCodeLangs(md));
    console.log(`  ok   langs: ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL langs: ${name}: ${e.message.split('\n')[0]}`);
  }
}


console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
