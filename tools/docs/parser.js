/**
 * @file Doc-block parser — src/*.js → module table + doclet table.
 * @module tools/docs/parser
 * @license AGPL-3.0-only
 *
 * Public-symbol rule. A doc block is public iff:
 *   - it sits directly above an `export` (name inferred from the following
 *     code line), or
 *   - it carries `@function name` (validated to also carry `@memberof`),
 *     `@constant {T} NAME`, or `@typedef {T} Name`.
 * Every other block is internal and ignored. `@memberof` defaults to the
 * module. Dotted `@param` / `@property` names group under their parent.
 *
 * Audience rule. The rendered description is the block's prose before its
 * first tag, written for a p5 user: what it does, the key options, what it
 * needs. Technical prose stays in the source under `@details`, a tag the
 * parser accepts and never renders.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'comment-parser';

const EXPORT_RE  = /^export\s+(?:async\s+)?(function|class|const|let|var)\*?\s+([A-Za-z_$][\w$]*)/;
const CAPTION_RE = /^<caption>([\s\S]*?)<\/caption>\s*$/;
const CONST_RE   = /^\s*([A-Za-z_$][\w$]*)\s*:\s*CONST\(/gm;

// ── Token reconstruction ────────────────────────────────────────────────────
// comment-parser tokenizes every tag line into name / type / description, so a
// tag whose payload is free text (@example, @returns, @file) loses its first
// word into `name`. Rebuild from the raw tokens instead. With
// `spacing: 'preserve'` a continuation line's indentation lives in
// `postDelimiter` (one space past the `*` is the standard gutter).

/** Text after `@tag` (and after `{type}` on the first line), all lines. */
function tail(tag) {
  return tag.source.map((s, i) => {
    const k = s.tokens;
    if (i === 0) return k.name + k.postName + k.description;
    return k.postDelimiter.slice(1) + k.tag + k.postTag + k.name + k.postName +
           k.type + k.postType + k.description;
  }).join('\n').replace(/\s+$/, '');
}

/** Continuation lines only (everything after the tag's own line). */
function continuation(tag) {
  return tag.source.slice(1).map((s) => {
    const k = s.tokens;
    return k.postDelimiter.slice(1) + k.tag + k.postTag + k.name + k.postName +
           k.type + k.postType + k.description;
  }).join('\n').replace(/^\n+|\s+$/g, '');
}

/** Drop the blank lines an example carries at either end. */
function trimBlank(code) {
  const lines = code.split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n');
}

/**
 * An @example: optional `<caption>` as its first line (on the tag line or
 * the line after), code on the rest.
 */
function exampleOf(tag) {
  const k     = tag.source[0].tokens;
  const head  = (k.name + k.postName + k.type + k.postType + k.description).trim();
  const lines = (head ? [head] : []).concat(continuation(tag).split('\n'));
  const cap   = CAPTION_RE.exec(lines[0].trim());
  return {
    caption: cap ? cap[1].trim() : null,
    code:    trimBlank((cap ? lines.slice(1) : lines).join('\n')),
  };
}

/** A @param / @property row. */
function fieldOf(tag) {
  return {
    name:        tag.name,
    type:        tag.type,
    optional:    tag.optional,
    default:     tag.default ?? null,
    description: tag.description.trim(),
    children:    [],
  };
}

/**
 * Nest dotted names under their parent (`opts.display` under `opts`).
 * @returns {{ roots: Object[], orphans: string[] }} orphans name parents that
 *   were never declared; the row is kept as a root so nothing is lost.
 */
function groupDotted(rows) {
  const roots = [], byName = new Map(), orphans = [];
  for (const r of rows) {
    const dot = r.name.lastIndexOf('.');
    const parent = dot > 0 ? byName.get(r.name.slice(0, dot)) : null;
    if (dot > 0 && !parent) orphans.push(r.name);
    (parent ? parent.children : roots).push(r);
    byName.set(r.name, r);
  }
  return { roots, orphans };
}

/** First non-blank line at or after `from`. */
function nextCodeLine(lines, from) {
  for (let i = from; i < lines.length; i++) {
    if (lines[i].trim()) return lines[i].trim();
  }
  return null;
}

// ── Per-file parse ──────────────────────────────────────────────────────────

function parseFile(srcDir, file) {
  const text   = readFileSync(join(srcDir, file), 'utf8');
  const lines  = text.split('\n');
  const result = { file, module: null, blocks: [] };

  for (const b of parse(text, { spacing: 'preserve' })) {
    const line  = b.source[0].number + 1;                          // 1-based
    const last  = b.source[b.source.length - 1].number;
    const next  = nextCodeLine(lines, last + 1);
    const exp   = next ? EXPORT_RE.exec(next) : null;
    const tagOf = (n) => b.tags.find((t) => t.tag === n) ?? null;
    const all   = (n) => b.tags.filter((t) => t.tag === n);

    const block = {
      file, line,
      tags:       b.tags.map((t) => t.tag),
      exportName: exp ? exp[2] : null,
      exportKind: exp ? exp[1] : null,
      public:     false,
      doclet:     null,
    };
    result.blocks.push(block);

    // Module header — @file / @module / @license, prose before or after.
    const moduleTag = tagOf('module');
    if (moduleTag) {
      const lastTag = b.tags[b.tags.length - 1];
      const prose   = [b.description.trim(), continuation(lastTag)].filter(Boolean).join('\n\n');
      block.module = {
        name:        moduleTag.name,
        file,
        line,
        title:       tagOf('file') ? tail(tagOf('file')).trim() : '',
        license:     tagOf('license')?.name ?? '',
        description: prose,
      };
      if (!result.module) result.module = block.module;
      continue;
    }

    // Public? — explicit name tag wins over the export inference.
    const fnTag = tagOf('function'), constTag = tagOf('constant'), tdTag = tagOf('typedef');
    let via = null, name = null, kind = null;
    if (fnTag)          { via = 'function'; name = fnTag.name;    kind = 'function'; }
    else if (constTag)  { via = 'constant'; name = constTag.name; kind = 'constant'; }
    else if (tdTag)     { via = 'typedef';  name = tdTag.name;    kind = 'typedef';  }
    else if (block.exportName) {
      via  = 'export';
      name = block.exportName;
      kind = /^(function|class)$/.test(block.exportKind) ? 'function' : 'constant';
    }
    if (!via) continue;

    const params = groupDotted(all('param').map(fieldOf));
    const props  = groupDotted(all('property').map(fieldOf));
    const ret    = tagOf('returns');

    block.public = true;
    block.doclet = {
      kind, via, name,
      owner:         tagOf('memberof')?.name ?? null,   // null → module (filled by parseSources)
      module:        null,
      file, line,
      description:   b.description.trim(),
      params:        params.roots,
      properties:    props.roots,
      orphans:       [...params.orphans, ...props.orphans],
      returns:       ret ? { type: ret.type, description: tail(ret).trim() } : null,
      examples:      all('example').map(exampleOf),
      type:          constTag?.type ?? tdTag?.type ?? null,
      tagDescription: (constTag ?? tdTag)?.description.trim() ?? '',
      explicitName:  fnTag?.name ?? null,
      exportName:    block.exportName,
    };
  }
  return result;
}

// ── Entry ───────────────────────────────────────────────────────────────────

/**
 * Parse every `*.js` under `srcDir`.
 * @param {string} srcDir
 * @returns {{ modules: Object[], doclets: Object[], blocks: Object[], constNames: string[] }}
 */
export function parseSources(srcDir) {
  const files   = readdirSync(srcDir).filter((f) => f.endsWith('.js')).sort();
  const modules = [], doclets = [], blocks = [];

  for (const file of files) {
    const r = parseFile(srcDir, file);
    if (r.module) modules.push(r.module);
    for (const b of r.blocks) {
      blocks.push(b);
      if (!b.doclet) continue;
      b.doclet.module = r.module?.name ?? null;
      b.doclet.owner ??= b.doclet.module;
      doclets.push(b.doclet);
    }
  }

  // `NAME: CONST(...)` entries — the ground truth for the @constant check.
  const constNames = [];
  const constFile = join(srcDir, 'constants.js');
  try {
    const src = readFileSync(constFile, 'utf8');
    for (const m of src.matchAll(CONST_RE)) constNames.push(m[1]);
  } catch (_) { /* no constants.js — nothing to cross-check */ }

  return { modules, doclets, blocks, constNames };
}
