/**
 * @file Validator — the doclet table against the closed tag vocabulary.
 * @module tools/docs/validator
 * @license AGPL-3.0-only
 *
 * Errors fail the build; warnings print and continue.
 */

const VOCABULARY = new Set([
  'file', 'module', 'license',
  'function', 'memberof',
  'param', 'returns',
  'constant',
  'typedef', 'property',
  'example',
  'details',
]);

const LINK_RE  = /\{@link\s+([^}\s]+)\s*\}/g;
const SETUP_RE = /(^|[^\w$])(?:async\s+)?function\s+setup\s*\(/;

/** Split markdown into [text, fence, text, fence, …] so links inside fenced code are left alone. */
export function splitFences(md) {
  return md.split(/(```[\s\S]*?```)/g);
}

/** Every `{@link name}` target in a markdown string, fenced code excluded. */
function linkTargets(md) {
  const out = [];
  splitFences(md).forEach((seg, i) => {
    if (i % 2) return;
    for (const m of seg.matchAll(LINK_RE)) out.push(m[1]);
  });
  return out;
}

function* fields(rows) {
  for (const r of rows) { yield r; yield* fields(r.children); }
}

/** Every free-text field of a doclet that may carry `{@link}`. */
function* texts(d) {
  yield d.description;
  yield d.tagDescription;
  if (d.returns) yield d.returns.description;
  for (const f of fields(d.params))     yield f.description;
  for (const f of fields(d.properties)) yield f.description;
}

/**
 * Build the link table: `owner.name`, bare `name` (first wins, `p5` owner
 * preferred), and module names.
 * @returns {Map<string, Object>}
 */
export function linkTable({ modules, doclets }) {
  const table = new Map();
  for (const m of modules) table.set(m.name, { module: m });
  const rank = (d) => (d.owner === 'p5' ? 0 : 1);
  const bare = [...doclets].sort((a, b) => rank(a) - rank(b));
  for (const d of doclets) table.set(`${d.owner}.${d.name}`, { doclet: d });
  for (const d of bare)    if (!table.has(d.name)) table.set(d.name, { doclet: d });
  return table;
}

/**
 * @param {{ modules, doclets, blocks, constNames }} parsed
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function validate(parsed) {
  const { modules, doclets, blocks, constNames } = parsed;
  const errors = [], warnings = [];
  const at   = (x) => `${x.file}:${x.line}`;
  const fail = (x, msg) => errors.push(`${at(x)}  ${msg}`);
  const warn = (x, msg) => warnings.push(`${at(x)}  ${msg}`);

  // Vocabulary — public blocks and module headers only; internal blocks are ignored.
  for (const b of blocks) {
    if (!b.public && !b.module) {
      if (b.tags.includes('memberof') || b.tags.includes('example')) {
        warn(b, 'internal block carries @memberof/@example but no @function/@constant/@typedef and no export — ignored');
      }
      continue;
    }
    for (const t of b.tags) {
      if (!VOCABULARY.has(t)) fail(b, `tag @${t} is outside the vocabulary`);
    }
  }

  // Module coverage — a file with public blocks needs a header.
  for (const d of doclets) {
    if (!d.module) fail(d, `no @module header in ${d.file}`);
  }

  // Names and owners.
  const seen = new Map();
  for (const d of doclets) {
    if (d.explicitName && d.exportName && d.explicitName !== d.exportName) {
      fail(d, `@function ${d.explicitName} contradicts export ${d.exportName}`);
    }
    if (d.via === 'function' && !blocks.find((b) => b.doclet === d).tags.includes('memberof')) {
      fail(d, `@function ${d.name} without @memberof`);
    }
    const key = `${d.owner}.${d.name}`;
    if (seen.has(key)) warn(d, `duplicate ${key} (first at ${seen.get(key)})`);
    else seen.set(key, at(d));
    for (const o of d.orphans) warn(d, `dotted @param ${o} has no parent parameter`);
  }

  // Links.
  const table = linkTable(parsed);
  for (const d of doclets) {
    for (const t of texts(d)) {
      for (const target of linkTargets(t)) {
        if (!table.has(target)) fail(d, `unresolved {@link ${target}}`);
      }
    }
  }
  for (const m of modules) {
    for (const target of linkTargets(m.description)) {
      if (!table.has(target)) fail(m, `unresolved {@link ${target}}`);
    }
  }

  // Examples — every one is a complete global-mode sketch.
  for (const d of doclets) {
    d.examples.forEach((ex, i) => {
      if (!SETUP_RE.test(ex.code)) fail(d, `@example #${i + 1} of ${d.name} does not define setup()`);
    });
    if (d.kind === 'function' && d.examples.length === 0) warn(d, `${d.owner}.${d.name} has no @example`);
  }

  // @constant ↔ CONST(...) — 1:1 in both directions.
  const tagged = new Map(doclets.filter((d) => d.via === 'constant').map((d) => [d.name, d]));
  for (const n of constNames) {
    if (!tagged.has(n)) errors.push(`constants.js  CONST entry ${n} has no @constant block`);
  }
  for (const [n, d] of tagged) {
    if (!constNames.includes(n)) fail(d, `@constant ${n} has no CONST entry in constants.js`);
  }

  return { errors, warnings };
}
