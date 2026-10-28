/**
 * code-lang — infer a fenced-code language tag from the code text itself.
 *
 * WeChat editors (mdnice etc.) strip any language hint from <pre>/<code>
 * markup, so the tag has to be guessed from the block contents. Heuristics
 * ordered from strict to loose; unknown or prose blocks return '' so the
 * fence stays bare instead of getting a wrong label.
 */

export function inferCodeLang(code) {
  const t = code.trim();
  if (!t) return '';
  // strict JSON parse beats every keyword heuristic; when it fails, try
  // JSONL (per-line parse), then a shape fallback — WeChat hard-wraps long
  // JSON lines and smart-quotes string keys, which breaks strict parsing
  if (/^[{[]/.test(t)) {
    try {
      JSON.parse(t);
      return 'json';
    } catch {
      /* keep guessing */
    }
    const rows = t.split('\n').map((l) => l.trim()).filter(Boolean);
    if (rows.length > 1 && rows.every((r) => { try { JSON.parse(r); return true; } catch { return false; } }))
      return 'json';
    if (/["“”]\s*:/.test(t)) return 'json';
  }
  // go / java before python: their code contains class/import-like tokens
  // ("public class", package imports) that python's check would steal
  if (/\bpackage\s+\w+|func\s+\w+\(|fmt\.(?:Print|Sprintf|Errorf)/.test(t)) return 'go';
  if (/\bpublic\s+(?:class|static|void)\b|System\.out\.print|\bprivate\s+\w+\s+\w+\s*[({;]/.test(t)) return 'java';
  if (
    /(?:^|\n)\s*(?:def\s|class\s|import\s+\w|from\s+[\w.]+\s+import|self\.|elif\s|async\s+def\s|__\w+__\s*=|with\s+open\(|json\.loads\(|print\(|[\w.]+\s*=\s*[fFrRbBuU]?("""|'''))/.test(
      t,
    )
  )
    return 'python';
  if (/(?:^|\n)\s*(?:SELECT\s|INSERT\s+INTO\s|CREATE\s+TABLE\s|UPDATE\s+\S+\s+SET\s|DELETE\s+FROM\s)/i.test(t))
    return 'sql';
  // `=>` needs an ASCII word/paren before it — CJK prose arrows (输入 => 输出)
  // must not become javascript
  if (/(?:^|\n)\s*(?:const\s|let\s|var\s|function\s|console\.log\(|[\w)\]]\s*=>|require\(|import\s.+from\s)/.test(t))
    return 'javascript';
  if (
    /(?:^|\n)\s*(?:\$\s|sudo\s|cd\s|export\s|pip3?\s|npm\s|yarn\s|docker\s|git\s|curl\s|wget\s|apt(?:-get)?\s|conda\s|source\s|kubectl\s|make\s|echo\s|python3?\s|bash\s)/.test(
      t,
    )
  )
    return 'bash';
  // comment-led script with shell-verb lines and no braces
  if (!/[{}]/.test(t) && /^#\s/m.test(t) && /(?:^|\n)[a-z][\w-]*\s+\S/.test(t)) return 'bash';
  // flat key: value pairs — require ≥2 lowercase-start keys, short lines, no
  // CJK sentence punctuation, so English prose fences ("Note: …") stay bare
  const yamlKeys = t
    .split('\n')
    .filter((l) => /^(?:[a-z][\w.-]*|["'][^"']+["']):(?:\s|$)/.test(l) && l.length <= 80);
  if (yamlKeys.length >= 2 && !t.includes('。') && !t.includes('！')) return 'yaml';
  return '';
}

/**
 * Add an inferred language tag to every bare opening fence in a markdown
 * document. Fences already carrying a tag are left untouched.
 */
export function inferCodeLangs(md) {
  const lines = md.split('\n');
  const fenceAt = (s) => /^\s*```/.test(s);
  let inFence = false;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!inFence && fenceAt(lines[i])) {
      inFence = true;
      start = i;
    } else if (inFence && fenceAt(lines[i])) {
      inFence = false;
      if (/^\s*```\s*$/.test(lines[start])) {
        const lang = inferCodeLang(lines.slice(start + 1, i).join('\n'));
        if (lang) lines[start] = lines[start].replace(/^(\s*```)/, `$1${lang}`);
      }
    }
  }
  return lines.join('\n');
}
