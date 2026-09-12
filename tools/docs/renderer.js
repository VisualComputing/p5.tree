/**
 * @file Renderer — module + doclet tables → static HTML (one page per module,
 * README as the landing page).
 * @module tools/docs/renderer
 * @license AGPL-3.0-only
 *
 * Every URL emitted is relative, so the site serves unchanged under the
 * `/p5.tree/` base path. Types render verbatim — nothing here parses a type
 * expression.
 */

import { Marked } from 'marked';
import { splitFences, linkTable } from './validator.js';
import { p5, codemirror, site, p5RefUrl, p5RefText } from './config.js';

const LINK_RE = /\{@link\s+([^}\s]+)\s*\}/g;
// A backticked identifier in prose — `createHandle`, `update()`, `p5.Tree.NEAR`,
// `p5.createCanvas` — that is not already a link's text.
const CODE_RE = /(^|[^[`\\])`((?:[\w$]+\.)*[\w$]+)(\(\))?`/g;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/** GitHub-style heading slug — the README's own TOC links depend on it. */
const slug = (s) => s.toLowerCase().replace(/[^\w\- ]+/g, '').replace(/ /g, '-');

const marked = new Marked({
  renderer: {
    heading({ tokens, depth }) {
      const html = this.parser.parseInline(tokens);
      const text = this.parser.parseInline(tokens, this.parser.textRenderer);
      return `<h${depth} id="${slug(text)}">${html}</h${depth}>\n`;
    },
  },
});

// ── Addresses ───────────────────────────────────────────────────────────────

/** `p5.tree/gizmos` → `gizmos.html`; a bare `p5.tree` → `p5.tree.html`. */
export function pageOf(moduleName) {
  const i = moduleName.lastIndexOf('/');
  return (i < 0 ? moduleName : moduleName.slice(i + 1)) + '.html';
}

const anchorOf = (d) => `${d.owner}.${d.name}`;
const hrefOf   = (entry) => entry.module
  ? pageOf(entry.module.name)
  : `${pageOf(entry.doclet.module)}#${anchorOf(entry.doclet)}`;

/**
 * A name as a markdown link: to its page when documented, to p5's reference
 * when `p5.`-prefixed (shown without the prefix), else plain code.
 */
function linkTo(name, call, table) {
  const entry = table.get(name);
  const code = `\`${name}${call}\``;
  if (entry) return `[${code}](${hrefOf(entry)})`;
  const href = p5RefUrl(name);
  return href ? `[\`${p5RefText(name)}${call}\`](${href})` : code;
}

/**
 * Links in prose, fenced code left untouched: `{@link name}` becomes a link
 * to the documented name (or to p5's reference for a `p5.`-prefixed one),
 * and so does any backticked identifier that resolves the same way — with
 * or without a trailing `()`. A bare name shared by several owners, none of
 * them `p5`, stays plain code unless written as `Owner.name`.
 */
function resolveLinks(text, table) {
  return splitFences(text).map((seg, i) => i % 2 ? seg : seg
    .replace(LINK_RE, (_, name) => linkTo(name, '', table))
    .replace(CODE_RE, (all, pre, name, call) =>
      table.ambiguous.has(name) ? all : pre + linkTo(name, call || '', table))).join('');
}

/** Bare names several owners share, none of them `p5`: auto-links leave them alone. */
function ambiguousNames(doclets) {
  const owners = new Map();
  for (const d of doclets) {
    if (!owners.has(d.name)) owners.set(d.name, new Set());
    owners.get(d.name).add(d.owner);
  }
  return new Set([...owners].filter(([, s]) => s.size > 1 && !s.has('p5')).map(([n]) => n));
}

const md       = (text, table) => text ? marked.parse(resolveLinks(text, table)) : '';
const mdInline = (text, table) => text ? marked.parseInline(resolveLinks(text, table)) : '';

// ── Fragments ───────────────────────────────────────────────────────────────

const type = (t) => t ? `<code class="type">${esc(t)}</code>` : '';

function signature(d) {
  const list = d.params.map((p) => (p.optional ? `[${p.name}]` : p.name)).join(', ');
  return `${esc(d.name)}(${esc(list)})`;
}

function fieldRows(rows, table, depth = 0) {
  return rows.map((r) => `
      <tr class="depth-${depth}">
        <td><code>${esc(r.name)}</code>${r.optional ? ' <span class="opt">optional</span>' : ''}</td>
        <td>${type(r.type)}</td>
        <td>${r.default != null ? `<code>${esc(r.default)}</code>` : ''}</td>
        <td>${mdInline(r.description, table)}</td>
      </tr>${fieldRows(r.children, table, depth + 1)}`).join('');
}

function fieldTable(rows, table, caption) {
  if (!rows.length) return '';
  return `
    <table class="fields">
      <thead><tr><th>${caption}</th><th>Type</th><th>Default</th><th>Description</th></tr></thead>
      <tbody>${fieldRows(rows, table)}
      </tbody>
    </table>`;
}

function example(ex, id, i) {
  const eid = `${id}-example-${i + 1}`;
  return `
    <figure class="example" id="${esc(eid)}">
      ${ex.caption ? `<figcaption>${esc(ex.caption)}</figcaption>` : ''}
      <div class="editor"><textarea class="source" spellcheck="false" aria-label="sketch source">${esc(ex.code)}</textarea></div>
      <div class="stage" data-stage></div>
      <div class="toolbar">
        <button type="button" data-run>Run</button>
        <button type="button" data-reset>Reset</button>
      </div>
    </figure>`;
}

function functionDoclet(d, table) {
  const id = anchorOf(d);
  return `
  <article class="doclet function" id="${esc(id)}">
    <h3><a class="anchor" href="#${esc(id)}"><code>${signature(d)}</code></a></h3>
    <div class="description">${md(d.description, table)}</div>
    ${fieldTable(d.params, table, 'Parameter')}
    ${d.returns ? `<p class="returns"><strong>Returns</strong> ${type(d.returns.type)} ${mdInline(d.returns.description, table)}</p>` : ''}
    ${d.examples.length ? `<div class="examples">${d.examples.map((ex, i) => example(ex, id, i)).join('')}</div>` : ''}
  </article>`;
}

function typedefDoclet(d, table) {
  const id = anchorOf(d);
  return `
  <article class="doclet typedef" id="${esc(id)}">
    <h3><a class="anchor" href="#${esc(id)}"><code>${esc(d.name)}</code></a> ${type(d.type)}</h3>
    <div class="description">${md(d.description || d.tagDescription, table)}</div>
    ${fieldTable(d.properties, table, 'Property')}
  </article>`;
}

function constantsTable(list, table) {
  return `
  <table class="constants">
    <thead><tr><th>Name</th><th>Type</th><th>Description</th></tr></thead>
    <tbody>${list.map((d) => `
      <tr id="${esc(anchorOf(d))}">
        <td><a class="anchor" href="#${esc(anchorOf(d))}"><code>${esc(d.name)}</code></a></td>
        <td>${type(d.type)}</td>
        <td>${mdInline(d.description || d.tagDescription, table)}</td>
      </tr>`).join('')}
    </tbody>
  </table>`;
}

function ownerSection(owner, list, table) {
  const consts = list.filter((d) => d.kind === 'constant');
  const rest   = list.filter((d) => d.kind !== 'constant');
  return `
  <section class="owner" id="${esc(owner)}">
    <h2>${esc(owner)}</h2>
    ${consts.length ? constantsTable(consts, table) : ''}
    ${rest.map((d) => (d.kind === 'typedef' ? typedefDoclet(d, table) : functionDoclet(d, table))).join('')}
  </section>`;
}

// ── Page shell ──────────────────────────────────────────────────────────────

function shell({ title, active, body, nav, pkg, examples }) {
  const cm = examples ? `
  <link rel="stylesheet" href="${codemirror.css}">
  ${codemirror.js.map((u) => `<script src="${u}"></script>`).join('\n  ')}` : '';
  const cfg = { p5: p5.url, lib: site.bundle, font: site.font };
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} — ${esc(pkg.name)}</title>
  <link rel="stylesheet" href="${site.style}">${cm}
  <script>window.p5treeDocs = ${JSON.stringify(cfg)};</script>
  <script src="${site.runner}" defer></script>
</head>
<body>
  <nav class="sidebar">
    <a class="brand" href="index.html">${esc(pkg.name)}</a>
    <ul>${nav.map((n) => `
      <li><a href="${n.href}"${n.href === active ? ' aria-current="page"' : ''}>${esc(n.label)}</a></li>`).join('')}
    </ul>
  </nav>
  <main>
${body}
    <footer>${esc(pkg.name)} v${esc(pkg.version)} · ${esc(pkg.license ?? '')}</footer>
  </main>
</body>
</html>
`;
}

// ── Entry ───────────────────────────────────────────────────────────────────

/**
 * @param {{ modules, doclets }} parsed
 * @param {{ pkg: Object, readme: string }} ctx
 * @returns {Map<string, string>} filename → HTML
 */
export function render(parsed, { pkg, readme }) {
  const table = linkTable(parsed);
  table.ambiguous = ambiguousNames(parsed.doclets);
  const pages = new Map();

  // Modules with at least one public doclet, in source order.
  const byModule = new Map();
  for (const d of parsed.doclets) {
    if (!byModule.has(d.module)) byModule.set(d.module, []);
    byModule.get(d.module).push(d);
  }
  const modules = parsed.modules.filter((m) => byModule.has(m.name));
  const nav = modules.map((m) => ({ href: pageOf(m.name), label: m.name.slice(m.name.lastIndexOf('/') + 1) }));

  pages.set('index.html', shell({
    title: 'README', active: 'index.html', nav, pkg, examples: false,
    body: `    <article class="readme">${marked.parse(readme)}</article>`,
  }));

  for (const m of modules) {
    const list = byModule.get(m.name);
    // Sketch-level `p5` first, then owners in order of first appearance.
    const owners = [...new Set(list.map((d) => d.owner))]
      .sort((a, b) => (a === 'p5' ? 0 : 1) - (b === 'p5' ? 0 : 1));
    const body = `
    <header class="module">
      <h1>${esc(m.name)}</h1>
      ${m.title ? `<p class="lead">${mdInline(m.title, table)}</p>` : ''}
      <div class="description">${md(m.description, table)}</div>
    </header>
    ${owners.map((o) => ownerSection(o, list.filter((d) => d.owner === o), table)).join('')}`;
    pages.set(pageOf(m.name), shell({
      title: m.name, active: pageOf(m.name), nav, pkg,
      examples: list.some((d) => d.examples.length > 0),
      body,
    }));
  }

  return pages;
}
