/**
 * @file Docs generator configuration — pinned CDN versions and repo paths.
 * @module tools/docs/config
 * @license AGPL-3.0-only
 *
 * Every version below is an exact pin. Advancing one is a deliberate edit
 * here, never an implicit `latest`.
 */

const CDN = 'https://cdn.jsdelivr.net/npm';

/** p5 — loaded by every example iframe. */
export const p5 = { version: '2.3.2' };
p5.url = `${CDN}/p5@${p5.version}/lib/p5.min.js`;

/** CodeMirror 5 UMD — the example editor. */
export const codemirror = { version: '5.65.21' };
codemirror.css = `${CDN}/codemirror@${codemirror.version}/lib/codemirror.min.css`;
codemirror.js  = [
  `${CDN}/codemirror@${codemirror.version}/lib/codemirror.min.js`,
  `${CDN}/codemirror@${codemirror.version}/mode/javascript/javascript.min.js`,
];

/** Repo-relative paths (resolved against the package root by index.js). */
export const paths = {
  src:          'src',
  pkg:          'package.json',
  readme:       'README.md',
  readmeAssets: ['p5.tree.png'],     // images the README references relatively
  bundle:       'dist/p5.tree.js',   // IIFE build of the same commit
  static:       'tools/docs/static', // copied verbatim into site/ (assets/, fonts/)
  site:         'site',
};

/** Site-local URLs the pages hand to the runner. */
export const site = {
  bundle: 'p5.tree.js',
  font:   'fonts/noto_sans.ttf',
  style:  'assets/style.css',
  runner: 'assets/runner.js',
};
