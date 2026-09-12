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
p5.reference = 'https://p5js.org/reference/';

/**
 * The p5 reference page of a `p5.`-prefixed name: `p5.createCanvas` →
 * reference/p5/createCanvas/, `p5.WEBGL` → reference/p5/WEBGL/, a class
 * `p5.Vector` → reference/p5/p5.Vector/, a method `p5.Camera.perspective`
 * → reference/p5.Camera/perspective/. Null for anything else, including the
 * addon's own `p5.Tree` names.
 */
export function p5RefUrl(name) {
  const m = /^p5\.(?:([A-Z][\w$]*)\.)?([\w$]+)$/.exec(name);
  if (!m || m[1] === 'Tree' || m[2] === 'Tree') return null;
  const isClass = !m[1] && /^[A-Z][a-z]/.test(m[2]);
  return `${p5.reference}${m[1] ? 'p5.' + m[1] : 'p5'}/${isClass ? 'p5.' : ''}${m[2]}/`;
}

/** Class names in prose link to the factory that makes them. */
export const aliases = {
  Handle:        'createHandle',
  PointerRouter: 'createPointerRouter',
  PoseTrack:     'createPoseTrack',
  CameraTrack:   'createCameraTrack',
  TrackHandles:  'createPoseTrack',
  PoseHelm:      'createPoseHelm',
  CameraHelm:    'createCameraHelm',
  Panel:         'createPanel',
};

/** The text a `p5.`-prefixed link shows: the name without the prefix (`createCanvas`, `Camera.perspective`). */
export const p5RefText = (name) => name.replace(/^p5\.(?!Tree\b)/, '');

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
  search: 'assets/search.js',
  index:  'search.json',
};
