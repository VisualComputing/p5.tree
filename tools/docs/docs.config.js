/**
 * @file The API site's declaration — what this site states, and nothing it does.
 * @module tools/docs/docs.config
 * @license AGPL-3.0-only
 *
 * `npm run docs` hands this object to `@nakednous/scholion/generator`, which
 * parses, validates, renders and writes the site. Add a field here to say
 * something; add a plugin to do something.
 *
 * Every version below is an exact pin. Advancing one is a deliberate edit
 * here, never an implicit `latest`.
 */

/**
 * p5 — the host the addon registers onto, and the global every example reads.
 * `lib/p5.min.js` is the build a page's examples load.
 */
const p5 = { version: '2.3.4', script: 'lib/p5.min.js' };

/**
 * The p5 addon API, as the build reads it: `registerAddon` calls back with the
 * p5 namespace, the prototype the sketch-level functions are installed on, and
 * the lifecycles (which this site's pages never run). `Tree`, `Renderer3D` and
 * `Camera` are what the addon installs onto.
 */
const p5AddonHost = {
  prototype: {},
  Tree: {},
  Renderer3D: { prototype: {} },
  Camera: { prototype: {} },
  registerAddon(install) {
    install(this, this.prototype, {});
  },
};

export default {
  /** Repo-relative paths: the inputs a build reads and the builds it copies. */
  paths: {
    pkg: 'package.json',
    readme: 'README.md',
    readmeAssets: ['p5.tree.png'],   // the README's own relative image, served beside it
    src: 'src',
    bundle: 'dist/p5.tree.js',       // IIFE build of the same commit, read by every example
    static: 'tools/docs/static',     // copied verbatim into the site (assets/, fonts/)
    site: 'site',
  },

  /** What the build writes, as the page names it. */
  outputs: {
    bundle: 'p5.tree.js',
    index: 'search.json',
    editor: 'assets',                                // the editor bundle, under its content-hashed name
    notices: 'assets/editor.LICENSES.txt',           // the bundled packages' notices, served beside it
  },

  /**
   * Publicity: a block above an `export` names it; a `@function`, `@constant`
   * or `@typedef` block names itself. The documented constants carry a leading
   * underscore and are public on this site on purpose. The tag vocabulary is
   * the site's own closed set: a teaching structure p5.tree does not have is
   * refused rather than ignored.
   */
  parse: {
    surface: false,
    members: null,
    ignore: 'skip',
    private: 'keep',
    vocabulary: ['file', 'module', 'license', 'function', 'memberof', 'param', 'returns', 'constant', 'typedef', 'property', 'example', 'details'],
  },

  /**
   * Every example is a complete sketch that calls p5's globals directly: no
   * import, `async setup()` awaited for the site's font — which is why the
   * syntax is not narrowed to a classic script's, and no global must be read.
   */
  examples: { syntax: 'any', global: null, required: true, setup: true },

  /**
   * The build, evaluated once: the IIFE installs onto the p5 it is handed and
   * leaves nothing of its own, so the surface is the addon host itself.
   */
  surface: { global: 'p5', globals: { p5: p5AddonHost }, check: 'all' },

  /**
   * Where each owner lives in the build: a path from the `p5` host, or several
   * when the addon installs one documented owner in more than one place.
   * `Handle`, `PointerRouter` and `TrackHandles` are constructed inside the
   * install closure and are reachable only from the sketch, so they are
   * documented and not checked.
   */
  owners: {
    p5:              ['prototype', 'Renderer3D.prototype'],   // sketch functions, and the renderer's gizmos
    'p5.Tree':       'Tree',
    'p5.Camera':     'Camera.prototype',
    PoseHelm:        'prototype.createPoseHelm()',   // the object, and the `bind` its factory attaches
    Handle:          null,
    PointerRouter:   null,
    TrackHandles:    null,
  },

  /**
   * The sketch comes first: on every page `p5` opens the sections, and a bare
   * name several owners share (`mat4Proj`, `applyPose`) is the sketch's.
   */
  ownerOrder: ['p5'],

  /** No owner is written as a prefix in a signature: the page's sections carry it. */
  namespaces: [],

  /** The pinned third-party build a page loads, and the artifact it names. */
  pins: { p5 },

  /**
   * Where a name in prose resolves to. The README is the library's own index
   * and is rendered as written: it names methods in passing, and a bare name
   * there is not a doc-block page's. No package is named in this site's prose,
   * so a doc-block page's text resolves through the doclet table, its aliases
   * and p5's own reference.
   */
  references: {
    readme: 'plain',
    packages: {},
    externals: [{
      prefix: 'p5',
      base: 'https://p5js.org/reference/',
      url: {
        // p5.createCanvas → reference/p5/createCanvas/, p5.Vector → reference/p5/p5.Vector/,
        // p5.Camera.perspective → reference/p5.Camera/perspective/.
        qualified: 'p5.{ns}/{member}/',
        one: 'p5/{member}/',
        classes: '^[A-Z][a-z]',
        class: 'p5/p5.{member}/',
      },
      // `p5.Tree` is this addon's namespace, not p5's: the reference has no page for it.
      exclude: ['Tree'],
      text: '{rest}',
    }],
    // A class named in prose links to the factory that makes it.
    aliases: {
      Handle:        'createHandle',
      PointerRouter: 'createPointerRouter',
      PoseTrack:     'createPoseTrack',
      CameraTrack:   'createCameraTrack',
      TrackHandles:  'createPoseTrack',
      PoseHelm:      'createPoseHelm',
      CameraHelm:    'createCameraHelm',
      Panel:         'createPanel',
    },
  },

  /** The deployed address: a README link into it must name a page and a name this build writes. */
  home: 'https://nakednous.github.io/p5.tree/',

  /** The page's own scripts are ES modules; the shell hands them a JSON config block. */
  mode: 'esm',

  shell: {
    // The rail's badge in place of the version line: on every page, and the
    // landing page keeps its space.
    badge: {
      src: 'https://img.shields.io/badge/dynamic/json?url=https://registry.npmjs.org/p5.tree&query=$.dist-tags.latest&label=npm&color=007e69',
      href: 'https://www.npmjs.com/package/p5.tree',
    },
    stylesheet: 'assets/style.css',
    favicon: [],                    // no icon of its own
  },

  /**
   * The runner's contract: the page's config block, its `{tokens}` resolved by
   * the build — `{bundle}`, `{index}`, `{editor}`, `{pin:<name>:<field>}`.
   * `font` is the file every sketch's `loadFont` reads, served beside the page.
   */
  runner: {
    script: 'assets/runner.js',
    search: 'assets/search.js',
    chrome: 'assets/chrome.js',    // theme picker and collapsible navigation
    config: {
      p5: '{pin:p5:script}',
      lib: '{bundle}',
      font: 'fonts/noto_sans.ttf',
      index: '{index}',
      editor: '{editor}',
    },
  },

  /** This site's own checks: its `@constant` blocks against the CONST(...) entries. */
  plugins: ['constants'],
};
