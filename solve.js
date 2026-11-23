// A fast drop-in replacement for makefun-site 1.0.0.
//
// run(input) returns the exact output tree makefun-site's build returns for
// one site: every page's index.html, the index and tag pages, the static
// files and build-report.txt, byte for byte. The implementation is written
// for speed on the hot paths a build actually spends time in:
//
//   - front matter is scanned line by line from offsets, never split+join;
//   - slugs and long dates are memoised per build (titles, tags and
//     headings repeat a lot inside one site);
//   - the Markdown lexer classifies lines with direct character checks
//     instead of a battery of regular expressions;
//   - the inline renderer walks the source once with an explicit range,
//     copying plain runs in bulk instead of escaping character by character;
//   - templates are parsed once and compiled to plain JavaScript
//     functions, so rendering is direct code, not a tree walk.
//
// No state survives a build: every cache below is reset at the top of
// build(), so each case is answered alone, exactly as the rules require.

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December',
];

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped, and nothing else touched. */
function esc(text) {
  return text.replace(ESCAPE_RE, (c) => ESCAPES[c]);
}

// ------------------------------------------------------------------ slugs

const slugCache = new Map();

function computeSlug(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  let out = '';
  let gap = false;
  if (ascii) {
    // NFKD is the identity on ASCII and there are no marks to drop, so the
    // generic loop below can run on the text itself.
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  if (out.length > 64) {
    out = out.slice(0, 64);
    if (out.endsWith('-')) out = out.slice(0, -1);
  }
  return out === '' ? 'untitled' : out;
}

/** The slug of `text`: NFKD, marks dropped, lowered, dashed, capped. */
function slugify(text) {
  let v = slugCache.get(text);
  if (v === undefined) {
    v = computeSlug(text);
    slugCache.set(text, v);
  }
  return v;
}

/** `slug` made unique against the `taken` set, which it then joins. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

// ------------------------------------------------------------------ dates

const dateCache = new Map();

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  let v = dateCache.get(date);
  if (v === undefined) {
    v = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
    dateCache.set(date, v);
  }
  return v;
}

/** Whether a UTF-16 code unit is one of the characters \s matches. */
function isWsCode(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
    c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** The number of words in `text`: runs of characters other than whitespace. */
function wordCount(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isWsCode(text.charCodeAt(i))) inWord = false;
    else if (!inWord) { n++; inWord = true; }
  }
  return n;
}

/** A line holding nothing but spaces and tabs (or nothing at all). */
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** `line` with spaces and tabs at either end dropped. */
function trimLine(line) {
  let s = 0;
  let e = line.length;
  while (s < e && (line[s] === ' ' || line[s] === '\t')) s++;
  while (e > s && (line[e - 1] === ' ' || line[e - 1] === '\t')) e--;
  return s === 0 && e === line.length ? line : line.slice(s, e);
}

/** The directory part of a "/"-separated path, or "" at the root. */
function dirOf(path) {
  const at = path.lastIndexOf('/');
  return at === -1 ? '' : path.slice(0, at);
}

// ------------------------------------------------------------ front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A front-matter string value, quoted or bare, or why it is refused. */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value parsed from its raw text, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw[4] === '-' && raw[7] === '-';
      if (ok) {
        for (const p of [0, 1, 2, 3, 5, 6, 8, 9]) {
          const c = raw.charCodeAt(p);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      if (ok) {
        const y = Number(raw.slice(0, 4));
        const mo = Number(raw.slice(5, 7));
        const d = Number(raw.slice(8, 10));
        ok = y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
      }
      return ok
        ? { value: raw }
        : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      if (raw === 'true') return { value: true };
      if (raw === 'false') return { value: false };
      return { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-')) {
          return { error: 'key "layout": not a template name' };
        }
      }
      return { value: raw };
    }
    case 'slug': {
      // [a-z0-9]+ pieces joined by single dashes, at most 64 characters.
      let ok = raw.length >= 1 && raw.length <= 64;
      let piece = 0;
      if (ok) {
        for (let i = 0; i < raw.length; i++) {
          const c = raw[i];
          if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) piece++;
          else if (c === '-' && piece > 0) piece = 0;
          else { ok = false; break; }
        }
        if (piece === 0) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` already has "\n" line ends. The scan
 * works on offsets into `text`, so the body is one slice, never a rejoin.
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const first = firstNl === -1 ? text : text.slice(0, firstNl);
  if (first !== '---') return { error: 'no front matter' };
  if (firstNl === -1) return { error: 'the front matter is not closed' };

  // Find the closing line first: an unclosed block is refused as such,
  // whatever its lines hold.
  const ranges = [];
  let closeEnd = -1;
  let p = firstNl + 1;
  for (;;) {
    const e = text.indexOf('\n', p);
    const le = e === -1 ? text.length : e;
    if (text.slice(p, le) === '---') {
      closeEnd = e === -1 ? text.length : e + 1;
      break;
    }
    ranges.push([p, le]);
    if (e === -1) break;
    p = e + 1;
    if (p === text.length) { ranges.push([p, p]); break; }
    if (p > text.length) break;
  }
  if (closeEnd === -1) return { error: 'the front matter is not closed' };

  const data = {};
  for (let r = 0; r < ranges.length; r++) {
    const line = text.slice(ranges[r][0], ranges[r][1]);
    if (isBlankLine(line) || line.startsWith('#')) continue;
    // "key: value": a key of a-z and _, a colon, then end-of-line or one
    // space and the value.
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || line[k] !== ':') return { error: `line ${r + 2} is not "key: value"` };
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line[k + 1] === ' ') raw = line.slice(k + 2);
    else return { error: `line ${r + 2} is not "key: value"` };
    raw = raw.replace(/[ \t]+$/, '');
    const key = line.slice(0, k);
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ---------------------------------------------------------------- markdown

/** A fence opener's language, or null when `line` opens no fence. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let k = 3;
  while (k < line.length) {
    const c = line[k];
    const ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
      c === '_' || c === '+' || c === '-';
    if (!ok) break;
    k++;
  }
  for (let j = k; j < line.length; j++) {
    if (line[j] !== ' ' && line[j] !== '\t') return null;
  }
  return line.slice(3, k);
}

/** Whether `line` closes a fence: three backticks, then blanks only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    if (line[j] !== ' ' && line[j] !== '\t') return false;
  }
  return true;
}

/** A heading line's { depth, text }, or null when it is not a heading. */
function headingOf(line) {
  let d = 0;
  while (d < line.length && line[d] === '#') d++;
  if (d === 0 || d > 6 || d >= line.length) return null;
  if (line[d] !== ' ' && line[d] !== '\t') return null;
  let s = d;
  while (s < line.length && (line[s] === ' ' || line[s] === '\t')) s++;
  let e = line.length;
  while (e > s && (line[e - 1] === ' ' || line[e - 1] === '\t')) e--;
  if (e <= s) return null;
  return { depth: d, text: line.slice(s, e) };
}

/** Whether `line` is a thematic break: --- or ***, then blanks only. */
function isBreak(line) {
  const a = line[0];
  if (a !== '-' && a !== '*') return false;
  if (line[1] !== a || line[2] !== a) return false;
  for (let j = 3; j < line.length; j++) {
    if (line[j] !== ' ' && line[j] !== '\t') return false;
  }
  return true;
}

/** A bullet item's text, or null: "- " or "* ", then anything. */
function bulletOf(line) {
  if ((line[0] === '-' || line[0] === '*') && line[1] === ' ') return line.slice(2);
  return null;
}

/** An ordered item's { num, text }, or null: 1-9 digits, ". ", anything. */
function orderedOf(line) {
  let d = 0;
  while (d < line.length) {
    const c = line.charCodeAt(d);
    if (c >= 48 && c <= 57) d++;
    else break;
  }
  if (d === 0 || d > 9) return null;
  if (line[d] !== '.' || line[d + 1] !== ' ') return null;
  return { num: Number(line.slice(0, d)), text: line.slice(d + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  if (line[0] !== ' ' || line[1] !== ' ') return false;
  let k = 0;
  while (k < line.length && line[k] === ' ') k++;
  if (k >= line.length) return false;
  return !isWsCode(line.charCodeAt(k));
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraph(line) {
  return isBlankLine(line) || fenceLang(line) !== null || headingOf(line) !== null || isBreak(line);
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index in [from, hi) holding `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, hi) {
  const wl = what.length;
  for (let j = from; j <= hi - wl; j++) {
    if (s[j] === '\\' && j + 1 < hi && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * in [from, hi) (one not beside another *), outside an escape, or -1. */
function findSingleStar(s, from, hi) {
  for (let j = from; j < hi; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < hi && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

const WS_RE = /\s/;

/**
 * The range s[lo, hi) rendered inline into `out` (an array of pieces).
 * Plain runs are copied in bulk and escaped once per run; only the
 * characters that open a construct break a run.
 */
function inlineRange(s, lo, hi, link, out) {
  let i = lo;
  let run = lo;
  const flush = (upto) => { if (upto > run) out.push(esc(s.slice(run, upto))); };
  while (i < hi) {
    const c = s[i];
    if (c === '\\' && i + 1 < hi && ESCAPABLE.has(s[i + 1])) {
      flush(i);
      out.push(esc(s[i + 1]));
      i += 2;
      run = i;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < hi && j > i + 1) {
        flush(i);
        out.push('<code>', esc(s.slice(i + 1, j)), '</code>');
        i = j + 1;
        run = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === '*') {
      if (i + 1 < hi && s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2, hi);
        if (j > i + 2) {
          flush(i);
          out.push('<strong>');
          inlineRange(s, i + 2, j, link, out);
          out.push('</strong>');
          i = j + 2;
          run = i;
          continue;
        }
        i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1, hi);
      if (j > i + 1) {
        flush(i);
        out.push('<em>');
        inlineRange(s, i + 1, j, link, out);
        out.push('</em>');
        i = j + 1;
        run = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1, hi);
      let m = -1;
      if (k !== -1 && k + 1 < hi && s[k + 1] === '(') {
        const at = s.indexOf(')', k + 2);
        if (at !== -1 && at < hi) m = at;
      }
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !WS_RE.test(target)) {
        flush(i);
        out.push('<a href="', esc(link(target)), '">');
        inlineRange(s, i + 1, k, link, out);
        out.push('</a>');
        i = m + 1;
        run = i;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  flush(hi);
}

/** `s` rendered inline; `link(target)` resolves a link's href. */
function inline(s, link) {
  const out = [];
  inlineRange(s, 0, s.length, link, out);
  return out.join('');
}

/**
 * `src` rendered: its HTML (a "\n" after every block), its table of
 * contents (every level 2 and 3 heading) and its excerpt (the first
 * paragraph's inline HTML, or "").
 */
function renderMarkdown(src, link) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const parts = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }

    const lang = fenceLang(line);
    if (lang !== null) {
      let s = lang === '' ? '<pre><code>' : `<pre><code class="language-${lang}">`;
      i++;
      while (i < n && !isFenceClose(lines[i])) { s += `${esc(lines[i])}\n`; i++; }
      i++;
      parts.push(`${s}</code></pre>\n`);
      continue;
    }

    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, link);
      parts.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }

    if (isBreak(line)) { parts.push('<hr>\n'); i++; continue; }

    if (line.charCodeAt(0) === 62) {
      const kept = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const raw = lines[i];
        const t = trimLine(raw[1] === ' ' ? raw.slice(2) : raw.slice(1));
        if (t !== '') kept.push(t);
        i++;
      }
      parts.push(kept.length === 0
        ? '<blockquote>\n</blockquote>\n'
        : `<blockquote>\n<p>${inline(kept.join('\n'), link)}</p>\n</blockquote>\n`);
      continue;
    }

    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      while (i < n) {
        const l = lines[i];
        if (isOrdered) {
          const m = orderedOf(l);
          if (m !== null) { items.push([trimLine(m.text)]); i++; continue; }
        } else {
          const m = bulletOf(l);
          if (m !== null) { items.push([trimLine(m)]); i++; continue; }
        }
        if (isContinued(l)) { items[items.length - 1].push(trimLine(l)); i++; continue; }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && ordered.num !== 1 ? `<ol start="${ordered.num}">` : `<${tag}>`;
      let s = `${open}\n`;
      for (const partsOfItem of items) s += `<li>${inline(partsOfItem.join('\n'), link)}</li>\n`;
      parts.push(`${s}</${tag}>\n`);
      continue;
    }

    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) { body.push(trimLine(lines[i])); i++; }
    const html = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    parts.push(`<p>${html}</p>\n`);
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

// --------------------------------------------------------------- templates

/** A template that does not parse: its message names it and says why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;
const BLANK_TAIL_RE = /^[ \t]*$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}; a standalone {% %} takes its line. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = BLANK_TAIL_RE.test(src.slice(lineStart, open)) && BLANK_TAIL_RE.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') { body.push({ kind: 'text', text: tok.text }); continue; }
    if (tok.t === 'var' || tok.t === 'raw') { body.push({ kind: tok.t, path: tok.path }); continue; }
    const tag = tok.tag;
    const top = stack[stack.length - 1];
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
      body.push(node);
      stack.push(node);
      body = node.then;
    } else if (tag === 'else') {
      if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top.else = [];
      body = top.else;
    } else if (tag === 'endfor' || tag === 'endif') {
      if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) {
        throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      }
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
    } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
      body.push({ kind: 'include', name: m[1] });
    } else {
      throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope stack `S`: first name from the topmost scope holding it. */
function lookup(S, path) {
  const first = path[0];
  for (let s = S.length - 1; s >= 0; s--) {
    const vars = S[s];
    if (!Object.hasOwn(vars, first)) continue;
    let v = vars[first];
    for (let k = 1; k < path.length; k++) {
      if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
      v = v[path[k]];
    }
    return v;
  }
  return undefined;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array joined by ", ". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * A parsed template compiled to a function (S, P, H, D): S is the scope
 * stack, P the output pieces, H the helpers and compiled templates, D the
 * include depth. Loops push and pop one scope object, as rendering does.
 */
function compileTemplate(name, src) {
  const nodes = parseTemplate(name, src);
  const pathIds = new Map();
  const pathDecls = [];
  const pid = (path) => {
    const key = path.join('.');
    let id = pathIds.get(key);
    if (id === undefined) {
      id = pathDecls.length;
      pathIds.set(key, id);
      pathDecls.push(`const A${id}=${JSON.stringify(path)};`);
    }
    return id;
  };
  let uid = 0;
  let code = '';
  const gen = (ns) => {
    for (const nd of ns) {
      switch (nd.kind) {
        case 'text':
          code += `P.push(${JSON.stringify(nd.text)});`;
          break;
        case 'var':
          code += `P.push(H.e(H.v(H.k(S,A${pid(nd.path)}))));`;
          break;
        case 'raw':
          code += `P.push(H.v(H.k(S,A${pid(nd.path)})));`;
          break;
        case 'if': {
          code += `if(H.r(H.k(S,A${pid(nd.path)}))!==${nd.not ? 'true' : 'false'}){`;
          gen(nd.then);
          if (nd.else !== null) {
            code += '}else{';
            gen(nd.else);
          }
          code += '}';
          break;
        }
        case 'for': {
          const u = uid++;
          code += `{const _x${u}=H.k(S,A${pid(nd.path)});if(Array.isArray(_x${u})){const _n${u}=_x${u}.length;` +
            `for(let _i${u}=0;_i${u}<_n${u};_i${u}++){S.push({[${JSON.stringify(nd.name)}]:_x${u}[_i${u}],` +
            `loop:{index:_i${u}+1,first:_i${u}===0,last:_i${u}===_n${u}-1,length:_n${u}}});`;
          gen(nd.body);
          code += 'S.pop();}}}';
          break;
        }
        case 'include':
          code += `if(D<8){const _f=H.m.get(${JSON.stringify(nd.name)});if(_f!==undefined)_f(S,P,H,D+1);}`;
          break;
      }
    }
  };
  gen(nodes);
  return new Function('S', 'P', 'H', 'D', pathDecls.join('') + code);
}

// ------------------------------------------------------------------- build

const RESERVED = ['posts', 'tags', 'page'];

/** Whether `target` opens with a scheme such as https: or mailto:. */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true; // ':'
    const ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
      c === 43 || c === 45 || c === 46; // + - .
    if (!ok) return false;
  }
  return false;
}

/** `rel` resolved from directory `dir`, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** One site's output tree: path -> text, exactly as makefun-site builds it. */
export function run(input) {
  slugCache.clear();
  dateCache.clear();

  // Templates first, in code-unit order of name: one that does not parse
  // is reported and left out, as if it were not there.
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, compileTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // Sources in code-unit order of path; .md files are sources with their
  // line ends made "\n", everything else is static.
  const sorted = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of sorted) {
    if (f.path.endsWith('.md')) {
      sources.push({
        path: f.path,
        text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content,
      });
    } else statics.push({ path: f.path, content: f.content });
  }

  // Front matter and the drop checks, in their fixed order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: the slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, with links resolved against the pages and static files.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest date first, then by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by slug, named as first met in collection order,
  // ordered by count of posts, then slug.
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sl = slugify(name);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push(name);
      }
    }
    return out;
  };
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const sl = slugify(name);
      let tag = bySlug.get(sl);
      if (tag === undefined) {
        tag = { name, slug: sl, url: `${base}/tags/${sl}/`, posts: [] };
        bySlug.set(sl, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const sl = slugify(name);
      return bySlug.get(sl) ?? { name, slug: sl, url: '', posts: [] };
    });
  }
  const tagList = [...bySlug.values()].sort(
    (x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug),
  );

  // Cards and pages as templates read them, each built once per source.
  const cardOf = (s) => {
    if (s.card !== undefined) return s.card;
    const card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordCount(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    s.card = card;
    return card;
  };
  const linkOf = (s) => {
    if (s === null) return null;
    if (s.linkRec !== undefined) return s.linkRec;
    const rec = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    };
    s.linkRec = rec;
    return rec;
  };
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // Layouts: every page, the index pages, the tag pages, the statics.
  const output = {};
  const H = { m: templates, k: lookup, v: textOf, e: esc, r: truthy };
  const site = { title: input.site.title, base_url: base };
  const allTags = tagList.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cardOf(p));
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    const parts = [];
    fn([{ site, tags: allTags, recent, ...vars }], parts, H, 0);
    return parts.join('');
  };

  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });

  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cardOf(p)),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tagList) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;

  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every reported line and broken link, sorted, then counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.reduce((n, s) => n + (s.post ? 0 : 1), 0);
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tagList.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
