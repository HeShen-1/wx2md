#!/usr/bin/env node
// Re-render the PDF from an existing (possibly hand-enhanced) markdown file,
// without re-fetching the article. wx2md.mjs overwrites the md on re-run, so
// articles enhanced after conversion (callouts / inline-CSS cards / details)
// must refresh their PDF through this script instead.
//
// Usage: node render-pdf.mjs '<article.md>' [out.pdf]
// md 是唯一源:frontmatter 提供 title/account/author/date/source/fetched。
//
// 与 wx2md.mjs 的差异(刻意为之):
// - Obsidian callout(`> [!kind] title`)在 marked 里只是普通 blockquote,
//   这里转成带左侧色条的 div,视觉对齐 Obsidian;body 逐段过 marked,
//   与 Obsidian 的 callout 内 markdown 解析保持一致。
// - <details> 打印默认收起,渲染前强制 open,否则折叠内容在 PDF 里丢失。
// - pdfHtml 模板与 wx2md.mjs 保持一致;改版式请两处同步。
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { Marked } from 'marked';
import puppeteer from 'puppeteer';

const mdPath = process.argv[2];
if (!mdPath) { console.error('usage: node render-pdf.mjs <article.md> [out.pdf]'); process.exit(1); }
const pdfPath = process.argv[3] || mdPath.replace(/\.md$/, '.pdf');

const raw = await readFile(mdPath, 'utf8');
const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
if (!fm) { console.error('no frontmatter found'); process.exit(1); }
const meta = {};
for (const line of fm[1].split('\n')) {
  const kv = line.match(/^(\w+):\s*"?(.*?)"?\s*$/);
  if (kv) meta[kv[1]] = kv[2];
}
const url = meta.source || '';
const fetched = meta.fetched || '';
let bodyMd = raw.slice(fm[0].length).trim();

// --- callout → styled div (marked 只认 blockquote,渲染不出 Obsidian 效果) ---
const CALLOUT_COLORS = {
  abstract: '#0969da', info: '#0969da', note: '#0969da',
  tip: '#1a7f37', important: '#8250df',
  warning: '#9a6700', caution: '#cf222e', quote: '#57606a',
};
// callout 体内的 md(Obsidian 会解析)必须同样过 marked,否则 ** 与列表在 PDF 里失真
function transformCallouts(md, marked) {
  const lines = md.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^> \[!(\w+)\]\s*(.*)$/);
    if (!m) { out.push(lines[i++]); continue; }
    const color = CALLOUT_COLORS[m[1].toLowerCase()] || '#57606a';
    const title = m[2].trim();
    const body = [];
    i++;
    while (i < lines.length) {
      if (/^> \[!/.test(lines[i])) break; // 下一个 callout 从这里开始,不能吞进 body
      if (lines[i].startsWith('>')) { body.push(lines[i].replace(/^> ?/, '')); i++; continue; }
      if (lines[i].trim() === '' && lines[i + 1] !== undefined && lines[i + 1].startsWith('>') && !/^> \[!/.test(lines[i + 1])) { body.push(''); i++; continue; }
      break;
    }
    const paras = [];
    let cur = [];
    for (const l of body) {
      if (!l.trim()) { if (cur.length) { paras.push(cur.join('\n')); cur = []; } }
      else cur.push(l);
    }
    if (cur.length) paras.push(cur.join('\n'));
    out.push(
      `<div class="callout" style="border-left-color:${color}">` +
      `<div class="callout-title" style="color:${color}">${title}</div>` +
      paras.map((p) => marked.parse(p.trim())).join('\n') +
      `</div>`
    );
    if (lines[i] !== undefined && lines[i].trim() !== '') out.push(''); // keep HTML block separated
  }
  return out.join('\n');
}
const mdParser = new Marked({
  renderer: {
    heading({ tokens, depth }) {
      const text = this.parser.parseInline(tokens);
      const id = text.replace(/<[^>]+>/g, '').replace(/"/g, '&quot;').replace(/\s+/g, ' ').trim();
      return `<h${depth} id="${id}">${text}</h${depth}>\n`;
    },
  },
});
bodyMd = transformCallouts(bodyMd, mdParser);

// --- md → html(heading renderer 与 wx2md.mjs 相同,供文内锚点跳转) ---
const bodyHtml = mdParser.parse(bodyMd);

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${escapeHtml(meta.title || '')}</title>
<style>
  @page { size: A4; }
  * { box-sizing: border-box; }
  body {
    font-family: "Noto Sans CJK SC","WenQuanYi Micro Hei","WenQuanYi Zen Hei","PingFang SC","Microsoft YaHei",sans-serif;
    font-size: 14.5px; line-height: 1.9; color: #1f2328; margin: 0;
    text-rendering: optimizeLegibility;
  }
  /* WeChat inline styles bring their own font stacks (mp-quote, "PingFang SC", …)
     with no installed match; headless Chrome then draws ZERO glyphs instead of
     falling back — table cells go completely blank. Force the doc font back on
     every element; code/pre (and their children) keep the mono stack. */
  .doc :not(pre):not(code):not(pre *):not(code *) { font-family: inherit !important; }
  .doc { padding: 6px 2px 24px; }
  header.doc-head { border-bottom: 2px solid #d0d7de; margin-bottom: 28px; padding-bottom: 14px; }
  h1.doc-title { font-size: 24px; line-height: 1.45; margin: 0 0 10px; }
  .doc-meta { font-size: 11.5px; color: #57606a; line-height: 1.7; }
  .doc-meta a { color: #0969da; text-decoration: none; }
  h1,h2,h3,h4 { line-height: 1.5; margin: 1.5em 0 0.6em; }
  h2 { font-size: 19px; border-bottom: 1px solid #eaeef2; padding-bottom: 6px; }
  h3 { font-size: 16.5px; }
  p { margin: 0.65em 0; text-align: justify; }
  img { max-width: 88%; display: block; margin: 14px auto 4px; }
  p[align="center"] { color: #57606a; font-size: 12.5px; line-height: 1.6; margin: 2px auto 22px; }
  a { color: #0969da; }
  blockquote { margin: 1em 0; padding: 2px 14px; border-left: 3px solid #d0d7de; color: #57606a; background: #f6f8fa; }
  code { font-family: "WenQuanYi Micro Hei Mono","Noto Sans Mono CJK SC",ui-monospace,monospace; font-size: 0.88em; background: #f6f8fa; padding: 2px 5px; border-radius: 4px; }
  pre { background: #f6f8fa; padding: 12px 14px; border-radius: 6px; overflow-x: hidden; line-height: 1.6; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 13px; }
  th, td { border: 1px solid #d8dee4; padding: 6px 10px; text-align: left; }
  th { background: #f6f8fa; }
  hr { border: none; border-top: 1px solid #d0d7de; margin: 1.6em auto; width: 60%; }
  ul, ol { padding-left: 1.6em; }
  li { margin: 0.3em 0; }
  strong { color: #111; }
  details { margin: 1em 0; }
  summary { cursor: pointer; color: #57606a; font-size: 13px; }
  .callout { border-left: 4px solid #57606a; border-radius: 8px; background: #f6f8fa; padding: 10px 16px; margin: 1em 0; }
  .callout p { margin: 0.45em 0; }
  .callout-title { font-weight: 700; margin: 4px 0 6px; }
</style></head>
<body><div class="doc">
<header class="doc-head">
  <h1 class="doc-title">${escapeHtml(meta.title || '')}</h1>
  <div class="doc-meta">
    ${meta.account ? `公众号：<b>${escapeHtml(meta.account)}</b>　` : ''}
    ${meta.author ? `作者：${escapeHtml(meta.author)}　` : ''}
    ${meta.date ? `发布：${escapeHtml(meta.date)}<br>` : '<br>'}
    ${url ? `原文：<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>${fetched ? `（抓取于 ${escapeHtml(fetched)}）` : ''}<br>` : ''}
  </div>
</header>
${bodyHtml}
</div></body></html>`;

const htmlPath = pdfPath.replace(/\.pdf$/, '.render.html');
await writeFile(htmlPath, html, 'utf8');

const browser = await puppeteer.launch({
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none'],
});
try {
  const page = await browser.newPage();
  await page.goto('file://' + htmlPath, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = true; }));
  await page.pdf({
    path: pdfPath,
    format: 'A4',
    printBackground: true,
    margin: { top: '16mm', bottom: '18mm', left: '15mm', right: '15mm' },
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate:
      '<div style="font-family:\'WenQuanYi Micro Hei\',\'Noto Sans CJK SC\',sans-serif;font-size:10px;width:100%;text-align:center;color:#8a94a0;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
  });
  console.log(`pdf    : ${pdfPath}`);
} finally {
  await browser.close();
  await rm(htmlPath, { force: true });
}
