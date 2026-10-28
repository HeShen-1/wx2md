#!/usr/bin/env node
/**
 * wx2md — convert a WeChat official-account article (mp.weixin.qq.com/s/...)
 * to Markdown (with local image assets) and a typeset PDF.
 *
 * Usage:
 *   node wx2md.mjs <article-url> [--out <dir>] [--no-pdf] [--keep-html]
 *
 * Output layout:
 *   <out>/<title>/<title>.md
 *   <out>/<title>/assets/img-001.jpg ...
 *   <out>/<title>/<title>.pdf        (unless --no-pdf)
 *
 * The Markdown file is the source of truth; the PDF is rendered from it,
 * so both always carry identical content.
 */
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import * as cheerio from 'cheerio';
import { marked } from 'marked';
import puppeteer from 'puppeteer';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const REFERER = 'https://mp.weixin.qq.com/';

// ---------------------------------------------------------------- args ----
const argv = process.argv.slice(2);
const url = argv.find((a) => !a.startsWith('--') && !/^\/?$/.test(a));
if (!url || !/^https?:\/\//.test(url)) {
  console.error('Usage: node wx2md.mjs <article-url> [--out <dir>] [--no-pdf] [--keep-html]');
  process.exit(1);
}
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const OUT_ROOT = path.resolve(opt('--out', process.cwd()));
const WANT_PDF = !argv.includes('--no-pdf');
const KEEP_HTML = argv.includes('--keep-html');
const FETCHED = new Date().toISOString().slice(0, 10);

// -------------------------------------------------------------- helpers ----
async function fetchText(u) {
  const res = await fetch(u, { headers: { 'User-Agent': UA, Referer: REFERER } });
  if (!res.ok) throw new Error(`fetch article failed: HTTP ${res.status}`);
  return res.text();
}

async function pool(items, size, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await Promise.resolve(fn(items[i], i)).catch((e) => ({ error: e }));
    }
  });
  await Promise.all(workers);
  return results;
}

function pickMeta(html, $) {
  const text = (sel) => $(sel).first().text().replace(/\s+/g, ' ').trim();
  let title = text('#activity-name') || text('.rich_media_title');
  if (!title) title = $('meta[property="og:title"]').attr('content')?.trim() || 'untitled';
  let account = text('#js_name') || text('.profile_nickname');
  if (!account) account = html.match(/var\s+nickname\s*=\s*"([^"]*)"/)?.[1] || '';
  let author =
    text('#js_author') ||
    $('meta[name="author"]').attr('content')?.trim() ||
    html.match(/var\s+author\s*=\s*"([^"]*)"/)?.[1] ||
    '';
  // WeChat often fills author with the account name itself — drop the duplicate.
  if (!author || author === account) author = '';
  let date = text('#publish_time');
  if (!date) {
    date =
      html.match(/var\s+(?:ct|createTime)\s*=\s*"([^"]+)"/)?.[1] ||
      html.match(/"publish_time"[^"]*"([^"]+)"/)?.[1] ||
      '';
  }
  if (/^\d{10,}$/.test(date)) date = new Date(Number(date) * 1000).toISOString().slice(0, 10);
  date = (date || '').slice(0, 16);
  return { title, account, author, date };
}

function slugify(title) {
  return (
    title
      .replace(/[\\/:*?"<>|`'’“”\s#]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'article'
  );
}

// ------------------------------------------- pre-turndown normalisation ----
// turndown's blank rule swallows empty custom elements before any custom rule
// can match them, so structural normalisation must happen on the DOM side.
function preprocessWeirdTags(content) {
  // mdnice-style horizontal rules live in empty <section data-role="hr">
  content.find('section[data-role="hr"]').replaceWith('<hr>');
  // WeChat code snippets: <section class="code-snippet__fix"><ul class="code-snippet__line-index">…</ul>
  // <pre><code>line1</code><code>line2</code></pre></section> — one <code> per
  // line with no separators. turndown-plugin-gfm's fencedCodeBlock reads only
  // node.firstChild.textContent, so every line after the first would be lost:
  // merge the <code> siblings into one <code> with real newlines (and drop the
  // presentational line-number list). nbsp → space keeps ASCII-art alignment.
  content.find('ul.code-snippet__line-index').remove();
  content.find('pre').each((_, el) => {
    const pre = content.find(el);
    const codes = pre.children('code');
    if (codes.length <= 1) return;
    const text = codes
      .map((_, c) => content.find(c).text().replace(/ /g, ' ').replace(/[ \t]+$/g, ''))
      .get()
      .filter((l) => l.length > 0) // empty <code> = markup junk, not a blank code line
      .join('\n');
    pre.html('<code></code>');
    pre.children('code').text(text);
  });
  // media embeds are blank custom elements → leave a visible marker
  const kind = { mpvoice: '语音', mpvideo: '视频', mpaudio: '音频', video: '视频', audio: '音频' };
  content.find('mpvoice, mpvideo, mpaudio, video, audio').each((_, el) => {
    const $el = content.find(el);
    const k = kind[el.tagName.toLowerCase()] || '媒体';
    $el.replaceWith(`<p>（此段为${k}，<a href="${url}">原文查看</a>）</p>`);
  });
}

// ------------------------------------------------- styled emphasis ----
// The WeChat editor marks bold/italic with inline styles on <span>, not with
// <strong>/<em> (one article: 229 bold spans vs 10 <strong> tags). turndown
// drops styles, so the emphasis would vanish entirely. Promote styled spans
// to semantic tags before conversion; turndown turns them into **…** / *…*,
// and cjkSafeStrong later swaps ** for <strong> so CJK text renders.
function promoteStyledEmphasis(content) {
  const hasBold = (s) => /font-weight\s*:\s*(bold|[5-9]\d{2})/i.test(s || '');
  const hasItalic = (s) => /font-style\s*:\s*italic/i.test(s || '');
  // reverse document order = innermost first: nested bold spans collapse into
  // <strong><strong>… (renders bold, no data loss) instead of orphaning inner
  // spans on detached nodes.
  const spans = content.find('span').get().reverse();
  for (const el of spans) {
    const $el = content.find(el);
    const b = hasBold($el.attr('style'));
    const i = hasItalic($el.attr('style'));
    if (!b && !i) continue;
    if (!$el.text().trim()) continue; // whitespace wrapper → ** around nothing
    // never wrap block content in an inline tag; inner spans were already
    // promoted by the pass above
    if ($el.find('p, div, section, table, ul, ol, h1, h2, h3, h4, h5, h6, blockquote, pre').length) continue;
    const inner = $el.html() || '';
    if (b) $el.replaceWith(`<strong>${i ? `<em>${inner}</em>` : inner}</strong>`);
    else $el.replaceWith(`<em>${inner}</em>`);
  }
}

// ------------------------------------------------------ caption marking ----
// Figure captions: WeChat editors emit <figure><img><figcaption> (semantic),
// but older ones leave a bare centered text paragraph after the image.
// Layer 1 (figcaption) is exact; layer 2 is a conservative heuristic —
// misses degrade to a normal paragraph (harmless), false positives eat real
// prose (harmful), so the structural conditions stay strict.
const CAPTION_SYMBOL = /^[▲△▼▽◇◆●○■□※◎]|^图\s*\d|^Fig\.?\s*\d/i;
const CAPTION_LEN = 100; // relaxed to 160 when a caption symbol leads the text

function markCaptions(content) {
  const root = content.get(0);
  content.find('p, section').each((_, el) => {
    const $el = content.find(el);
    if ($el.attr('data-wx-caption')) return;
    // leaf text block only — anything structural disqualifies
    if ($el.find('img, ul, ol, table, h1, h2, h3, h4, h5, h6, pre, blockquote, p, section').length) return;
    const text = $el.text().trim();
    if (!text) return;
    if (text.length > (CAPTION_SYMBOL.test(text) ? 160 : CAPTION_LEN)) return;
    // the block right before (skipping one blank sibling) must contain an image
    let prev = $el.prev();
    if (prev.length && !prev.text().trim() && !prev.find('img').length) prev = prev.prev();
    if (!prev.length || !prev.find('img').length) return;
    // centered: itself or any ancestor up to #js_content
    let n = $el;
    while (n.length && n.get(0) !== root) {
      if (/text-align\s*:\s*center/i.test(n.attr('style') || '')) {
        $el.attr('data-wx-caption', '1');
        return;
      }
      n = n.parent();
    }
  });
}

function extFor(src, attrs = {}) {
  const fmt = (attrs.type || attrs.format || '').replace('svg+xml', 'svg');
  const fromUrl = new URL(src, 'https://x.invalid').searchParams.get('wx_fmt') || '';
  const f = (fmt || fromUrl).toLowerCase();
  if (/^(jpg|jpeg|png|gif|webp|svg|bmp)$/.test(f)) return f === 'jpeg' ? 'jpg' : f;
  if (/\/(sz_)?mmbiz_(gif|png|jpg|jpeg|svg)\//.test(src)) return src.match(/mmbiz_(gif|png|jpg|jpeg|svg)/)[1].replace('jpeg', 'jpg');
  return 'jpg';
}

// ---------------------------------------------- inline svg / embed → asset ----
// WeChat renders MathJax formulas as inline <svg> (data-mjx-* attrs) and
// remote formulas as <embed data-type="svg+xml">. Both become local .svg
// assets so formulas survive as vector images in md and PDF.
async function saveFormulas(content, assetsDir, relPrefix) {
  await mkdir(assetsDir, { recursive: true });
  const writes = [];
  let n = 0;
  // inline <svg> → serialize to file
  content.find('svg').each((_, el) => {
    const $el = content.find(el);
    const html = $.html($el);
    if (!html || html.length < 40) return; // stray fragment
    const name = `formula-${String(++n).padStart(3, '0')}.svg`;
    writes.push(writeFile(path.join(assetsDir, name), html, 'utf8'));
    $el.replaceWith(`<img data-wx-local="${relPrefix}/${name}" alt="">`);
  });
  // <embed data-type="svg+xml" src="https://…svg"> → normal remote image
  content.find('embed').each((_, el) => {
    const $el = content.find(el);
    const src = $el.attr('src') || '';
    if (/^https?:\/\//.test(src) && /svg/i.test($el.attr('data-type') || '')) {
      $el.replaceWith(`<img data-src="${src}" alt="">`);
    } else {
      $el.replaceWith('<p>[嵌入内容已省略]</p>');
    }
  });
  await Promise.all(writes);
  return n;
}

// ----------------------------------------------------------- image fetch ----
async function downloadImages($, imgNodes, assetsDir, relPrefix) {
  await mkdir(assetsDir, { recursive: true });
  const map = new Map(); // data-src -> relative local path
  let failures = 0;
  let seq = 0;
  await pool(imgNodes, 6, (node) => {
    const $n = $(node);
    const src = $n.attr('data-src') || $n.attr('src') || '';
    if (!src || !/^https?:\/\//.test(src) || map.has(src)) return;
    const n = ++seq;
    const ext = extFor(src, { type: $n.attr('data-type'), format: $n.attr('data-format') });
    const name = `img-${String(n).padStart(3, '0')}.${ext}`;
    return (async () => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await fetch(src, { headers: { 'User-Agent': UA, Referer: REFERER } });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length < 100) throw new Error(`suspicious tiny body (${buf.length}B)`);
          await writeFile(path.join(assetsDir, name), buf);
          map.set(src, `${relPrefix}/${name}`);
          return;
        } catch (e) {
          if (attempt === 3) {
            failures++;
            console.warn(`  ! image failed, keeping remote URL: ${src} (${e.message})`);
          } else {
            await new Promise((r) => setTimeout(r, 500 * attempt));
          }
        }
      }
    })();
  });
  return { map, total: seq, failures };
}

// Inline markdown renders literally inside HTML blocks — map it to HTML tags
// for the caption/decoration lines we emit as raw HTML.
function mdInlineToHtml(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*\s][^*]*?)\*/g, '<i>$1</i>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>');
}

// `**bold**` flanking CJK text breaks CommonMark flanking rules: 的**“x”** cannot
// open (letter before, punctuation after) and ：**后文 cannot close (punctuation
// before, letter after), so Obsidian shows raw asterisks. Swap strong for
// <strong> — renders everywhere. Inline code and fenced blocks are skipped.
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

// ------------------------------------------------------------- markdown ----
function buildTurndown(imgMap) {
  const td = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    br: '  ',
    emDelimiter: '*', // '_' breaks next to CJK text in CommonMark renderers
  });
  td.use(gfm);
  td.remove([
    'script', 'style', 'noscript', 'mpchecktext', 'iformix',
    'mp-common-profile', // author card at article end (old tag)
    'mpprofile',         // author card at article end (new tag)
    'mp-style-type',     // empty style container
    'iframe',            // embeds (music cards etc.) — page context won't carry over
  ]);
  // WeChat images: real src lives in data-src (lazily loaded);
  // formulas serialized by saveFormulas carry a local path in data-wx-local.
  // Centered via <div align="center"> — works in Obsidian, Chrome and most renderers.
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
  // WeChat "maybe you also want to read" anchors carry the title in textvalue
  // with no text content — use it instead of emitting an empty []() link.
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
  // Media embeds and mdnice hr sections are EMPTY custom elements: turndown's
  // blank rule fires before any custom rule can match, so they are normalized
  // in preprocessWeirdTags() instead — no rules here for them.
  // Inline semantics with no markdown syntax → keep as HTML (Obsidian & Chrome render both).
  const keepInline = (tag) =>
    td.addRule(`keep-${tag}`, {
      filter: tag,
      replacement: (c) => {
        const t = c.trim().replace(/\\([[\]`*_])/g, '$1'); // inside HTML, markdown escapes show literally
        return t ? `<${tag}>${t}</${tag}>` : '';
      },
    });
  keepInline('sup');
  keepInline('sub');
  keepInline('u');
  keepInline('mark');
  keepInline('kbd');
  // gfm's strikethrough only covers <del>; editors also emit <s>/<strike>.
  td.addRule('strikethrough-s', {
    filter: ['s', 'strike'],
    replacement: (c) => (c.trim() ? `~~${c.trim()}~~` : ''),
  });
  // Figure captions: native <figcaption> or blocks marked by markCaptions().
  // Inline markdown inside an HTML block renders literally — convert to HTML tags.
  td.addRule('wechat-figcaption', {
    filter: (node) =>
      node.nodeName === 'FIGCAPTION' || node.getAttribute?.('data-wx-caption') === '1',
    replacement: (content) => {
      const t = mdInlineToHtml(content.replace(/\s*\n+\s*/g, ' ').trim());
      return t ? `\n\n<p align="center">${t}</p>\n\n` : '';
    },
  });
  // WeChat wraps cell contents in block elements (<p>/<section>), so the gfm
  // plugin emits newlines inside cells and GFM rows shatter. Flatten to one line.
  td.addRule('wechat-table-cell', {
    filter: ['th', 'td'],
    replacement: (content, node) =>
      `${node.previousElementSibling ? '' : '| '}${content.replace(/\s*\n+\s*/g, ' ').trim()} |`,
  });
  return td;
}

function frontmatter(meta) {
  const lines = [
    '---',
    `title: "${meta.title.replace(/"/g, '\\"')}"`,
    `account: "${meta.account.replace(/"/g, '\\"')}"`,
  ];
  if (meta.author) lines.push(`author: "${meta.author.replace(/"/g, '\\"')}"`);
  if (meta.date) lines.push(`date: ${meta.date}`);
  lines.push(`fetched: ${FETCHED}`, `source: ${url}`, '---');
  return lines.join('\n');
}

// ------------------------------------------------ md post-processing ----
// Decorative separator lines: "----------  END  ----------" or bare "----"
// arrive as (escaped) literal text; normalize to a centered label or an hr.
function normalizeDecorativeLines(md) {
  return md
    .replace(
      /^[ \t]*\\?[ \t]*[-—=_*·~]{3,}[ \t ]+(\S[^\n]{0,28}?)[ \t ]+[-—=_*·~]{3,}[ \t]*$/gm,
      (_f, mid) => `\n<p align="center">${mdInlineToHtml(mid.trim())}</p>\n`,
    )
    .replace(/^[ \t]*\\?[-—=_*·~]{3,}[ \t ]*$/gm, '---');
}

// Turn list items that exactly match a heading into in-page anchor links.
// Obsidian resolves `#heading text`; the PDF renderer sets matching ids.
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

// WeChat's "maybe you also want to read" widgets emit the SAME url twice per
// item (an empty anchor with textvalue + a real text anchor). Keep one link
// per url per line — the one with the longer label.
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

// ------------------------------------------------------------------ pdf ----
function pdfHtml(bodyHtml, meta) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${escapeHtml(meta.title)}</title>
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
</style></head>
<body><div class="doc">
<header class="doc-head">
  <h1 class="doc-title">${escapeHtml(meta.title)}</h1>
  <div class="doc-meta">
    ${meta.account ? `公众号：<b>${escapeHtml(meta.account)}</b>　` : ''}
    ${meta.author ? `作者：${escapeHtml(meta.author)}　` : ''}
    ${meta.date ? `发布：${escapeHtml(meta.date)}<br>` : '<br>'}
    原文：<a href="${url}">${escapeHtml(url)}</a>（抓取于 ${FETCHED}）
  </div>
</header>
${bodyHtml}
</div></body></html>`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Heading ids match linkTocItems()'s hrefs (heading text verbatim, URL-encoded),
// so the in-page TOC links work in the exported PDF.
marked.use({
  renderer: {
    heading({ tokens, depth }) {
      const text = this.parser.parseInline(tokens);
      const id = text.replace(/<[^>]+>/g, '').replace(/"/g, '&quot;').replace(/\s+/g, ' ').trim();
      return `<h${depth} id="${id}">${text}</h${depth}>\n`;
    },
  },
});

async function renderPdf(htmlPath, pdfPath) {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none'],
  });
  try {
    const page = await browser.newPage();
    await page.goto('file://' + htmlPath, { waitUntil: 'networkidle0', timeout: 60000 });
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
    return page.pdf ? undefined : undefined;
  } finally {
    await browser.close();
  }
}

// ----------------------------------------------------------------- main ----
const html = await fetchText(url);
const $ = cheerio.load(html);
const content = $('#js_content').first();
if (!content.length) {
  console.error('ERROR: #js_content not found — page may require JS rendering or the URL is not an article.');
  console.error('Tip: pass the rendered DOM via browser if this persists.');
  process.exit(2);
}
content.find('script, style, noscript, mpchecktext, iformix').remove();
preprocessWeirdTags(content);
promoteStyledEmphasis(content);

const meta = pickMeta(html, $);
const outDir = path.join(OUT_ROOT, slugify(meta.title));
const assetsDir = path.join(outDir, 'assets');
await mkdir(assetsDir, { recursive: true });

// svg/embed formulas become <img> first, so captions that follow them can match.
const formulaCount = await saveFormulas(content, assetsDir, 'assets');
markCaptions(content);
const captionCount = content.find('[data-wx-caption]').length;

console.log(`title  : ${meta.title}`);
console.log(`account: ${meta.account}${meta.author ? ` | author: ${meta.author}` : ''}${meta.date ? ` | date: ${meta.date}` : ''}`);
console.log(`out    : ${outDir}`);

const imgNodes = content.find('img').not('[data-wx-local]').toArray();
console.log(`images : ${imgNodes.length} <img> found`);
console.log(`formulas: ${formulaCount} inline svg saved as assets`);
console.log(`captions: ${captionCount} heuristically marked (+ native figcaption handled in turndown)`);
const { map: imgMap, total: imgTotal, failures: imgFailures } = await downloadImages($, imgNodes, assetsDir, 'assets');
console.log(`images : ${imgTotal - imgFailures}/${imgTotal} downloaded${imgFailures ? ` (${imgFailures} kept as remote URL)` : ''}`);

const td = buildTurndown(imgMap);
let bodyMd = td.turndown(content.html() || '');
// collapse the runaway blank lines WeChat markup produces
bodyMd = bodyMd
  .replace(/\n[ \t]+\n/g, '\n\n') // whitespace-only lines from <br> chains
  .replace(/\n{3,}/g, '\n\n')
  .trim();
bodyMd = normalizeDecorativeLines(bodyMd);
bodyMd = linkTocItems(bodyMd);
bodyMd = dedupeInlineLinks(bodyMd).replace(/\n{3,}/g, '\n\n') + '\n';
bodyMd = cjkSafeStrong(bodyMd);

const mdPath = path.join(outDir, `${slugify(meta.title)}.md`);
await writeFile(mdPath, `${frontmatter(meta)}\n\n# ${meta.title}\n\n${bodyMd}`, 'utf8');
const mdChars = bodyMd.replace(/\s/g, '').length;
console.log(`md     : ${mdPath} (${mdChars} non-space chars)`);

if (WANT_PDF) {
  const bodyHtml = marked.parse(bodyMd);
  const htmlPath = path.join(outDir, `${slugify(meta.title)}.render.html`);
  await writeFile(htmlPath, pdfHtml(bodyHtml, meta), 'utf8');
  const pdfPath = path.join(outDir, `${slugify(meta.title)}.pdf`);
  try {
    await renderPdf(htmlPath, pdfPath);
    console.log(`pdf    : ${pdfPath}`);
  } catch (e) {
    console.warn(`! pdf rendering failed: ${e.message}`);
    console.warn(`  markdown + assets are still complete; re-run without --no-pdf later.`);
  } finally {
    if (!KEEP_HTML) await rm(htmlPath, { force: true });
  }
}

console.log('done.');
