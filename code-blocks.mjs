/**
 * code-blocks — normalise every WeChat code-block shape into a single
 * <pre><code> with plain text, so gfm's fencedCodeBlock rule (which requires
 * pre.firstChild to be <code>) produces a real fenced block.
 *
 * Shapes seen in the wild:
 *  1. code-snippet: <pre><code>line1</code><code>line2</code></pre> — one
 *     <code> per line (+ a line-number <ul> outside the pre).
 *  2. mdnice: <pre><span decoration/><code><span>token</span><span><br/></span>…</code></pre>
 *     — single <code>, token spans, <br/> line breaks, nbsp indentation.
 *  3. highlight.js: <pre><code class="language-x">text\n</code></pre> — real
 *     newlines in text (language class must survive untouched).
 *  4. bare: <pre>text</pre> with no <code> at all.
 *
 * WeChat's re-serialisation also strips whitespace-only text nodes BETWEEN
 * token spans ("class"+"Foo" → "classFoo"), so keyword tokens are
 * re-separated during the flatten.
 */

// Keywords that can never legally abut a word char, quote, or opening sigil
// when the highlighter emitted them as separate spans. Deliberately EXCLUDED:
// function-ish names that legally take '(' with no space (print, map, len,
// get, set, make, append) — inserting there would produce print ( / map [.
const CODE_KEYWORDS = new Set([
  // python
  'class', 'def', 'return', 'yield', 'if', 'elif', 'else', 'while', 'for', 'in',
  'and', 'or', 'not', 'is', 'import', 'from', 'as', 'with', 'try', 'except',
  'finally', 'raise', 'assert', 'del', 'lambda', 'global', 'nonlocal', 'pass',
  'break', 'continue', 'async', 'await',
  // go (map excluded: map[string]int is invalid with a space)
  'func', 'package', 'range', 'go', 'defer', 'chan', 'type', 'struct',
  'interface', 'select', 'var', 'const', 'fallthrough', 'goto',
  // java / c / c++
  'public', 'private', 'protected', 'static', 'final', 'void', 'int', 'long',
  'double', 'float', 'boolean', 'char', 'byte', 'short', 'new', 'throws',
  'throw', 'catch', 'do', 'switch', 'case', 'default', 'enum', 'implements',
  'extends', 'sizeof', 'typedef', 'struct', 'unsigned', 'signed', 'bool',
  'virtual', 'inline', 'namespace', 'template', 'typename',
  // javascript / typescript
  'function', 'typeof', 'delete', 'instanceof', 'of', 'export', 'super',
  'this', 'null', 'nil', 'true', 'false',
]);

// Uppercase SQL keywords — kept separate so lowercase prose words never match.
const SQL_KEYWORDS = new Set(
  (
    'SELECT FROM WHERE INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE JOIN ' +
    'LEFT RIGHT INNER OUTER FULL CROSS ON GROUP BY ORDER HAVING LIMIT OFFSET ' +
    'UNION ALL DISTINCT EXISTS BETWEEN LIKE CASE WHEN THEN END AS AND OR NOT ' +
    'IN NULL PRIMARY KEY FOREIGN REFERENCES INDEX VIEW'
  ).split(' '),
);

// `[` is intentionally absent: java `int[] x` / go map literal would become
// invalid with an inserted space, while python `return[1]` stays valid without.
const NEXT_SIGIL = /^[A-Za-z0-9_"'{(\-*+]/;

// CJK prose punctuation — a bare <pre> full of these is promo text or a
// poem, not code
const PROSE_MARK = /[，。！？；、…]/;

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function collectParts(node, parts) {
  if (node.type === 'text') {
    if (node.data) parts.push(node.data.replace(/ /g, ' '));
    return;
  }
  if (node.type !== 'tag') return;
  if (/^br$/i.test(node.tagName)) {
    parts.push('\n');
    return;
  }
  for (const child of node.children || []) collectParts(child, parts);
}

// Flatten one <code> element (any internal span/nesting) to plain text with
// real newlines and repaired keyword spacing.
function codeText(codeEl) {
  const parts = [];
  for (const child of codeEl.children || []) collectParts(child, parts);
  let text = '';
  for (let i = 0; i < parts.length; i++) {
    const cur = parts[i];
    text += cur;
    const next = parts[i + 1];
    if (!next || /\s$/.test(cur)) continue;
    if (CODE_KEYWORDS.has(cur) || SQL_KEYWORDS.has(cur)) {
      if (NEXT_SIGIL.test(next)) text += ' ';
    }
  }
  return text.replace(/[ \t]+$/gm, '');
}

/**
 * Normalise every <pre> under `root` to <pre><code>plain text</code></pre>.
 * `root` is any cheerio collection containing the pre elements.
 */
export function normalizeCodeBlocks(root) {
  root.find('ul.code-snippet__line-index').remove();
  root.find('pre').each((_, el) => {
    const pre = root.find(el);
    // find code elements BEFORE dropping non-code children — nested variants
    // (<pre><section><code>) would be deleted along with the junk otherwise
    let codes = pre.children('code');
    if (!codes.length) codes = pre.find('code');
    if (!codes.length) {
      // bare <pre>text</pre>: split by content shape — CJK prose (promo
      // footers, poems) degrades to a paragraph; code-like text (ASCII art,
      // diagrams) gets fenced
      const raw = pre.text().replace(/ /g, ' ').trim();
      if (!raw) {
        pre.remove(); // decoration or whitespace only
      } else if (PROSE_MARK.test(raw)) {
        pre.replaceWith(`<p>${escapeHtml(raw)}</p>`);
      } else {
        pre.html('<code></code>');
        pre.children('code').text(raw);
      }
      return;
    }
    // decoration spans (mdnice traffic-light bar) as direct children break
    // gfm's firstChild-must-be-<code> requirement — drop them wherever they sit
    pre.children(':not(code)').remove();
    if (codes.length === 1) {
      pre.html('<code></code>');
      pre.children('code').text(codeText(codes.get(0)));
      return;
    }
    // one <code> per line: join with real newlines (empty <code> = markup
    // junk, not a blank code line)
    const text = codes
      .get()
      .map((c) => codeText(c).replace(/[ \t]+$/g, ''))
      .filter((l) => l.length > 0)
      .join('\n');
    pre.html('<code></code>');
    pre.children('code').text(text);
  });
}
