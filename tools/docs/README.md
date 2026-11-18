# tools/docs — the API site's declaration and its editor

`docs.config.js` is the site's declaration and `index.js` is `npm run docs`: the two of them state where
this site's sources are and hand them to `@nakednous/scholion/generator`, which parses, validates,
renders and writes `site/`. The pipeline is the package's — this folder holds no copy of a step. It is
also a nested npm project of its own, because the site's editor is not the repository's: it is the same
package, installed here and nowhere else.

## The nested project

```
tools/docs/
  docs.config.js      the declaration — paths, outputs, pins, references, the page's chrome
  index.js            ~8 lines: import the generator, hand it the declaration
  static/             the stylesheet, the three scripts, the font — copied verbatim
  package.json        one dependency: @nakednous/scholion
  package-lock.json   committed — the root lock is ignored by pattern, this one is not
```

Until the package is published its dependency is a `file:` path, so the order matters:

```
cd ../../../../scholion && npm run build   # the package's bundle: dist/editor.<hash>.js + dist/manifest.json
npm install --prefix tools/docs            # links the package into tools/docs/node_modules
npm run build                              # this repository's IIFE, dist/p5.tree.js
npm run docs                               # copies the hashed asset into site/assets and writes every page
```

`scholion` is at `~/books/scholion` — the one package both instances' sites share. The library's root
`package.json` and lockfile are untouched: `npm run docs` reads the nested install and nothing else. The
Pages workflow installs the root and then the nested project (`npm ci --prefix tools/docs`); with a
`file:` dependency that step resolves only on a machine that has the package checkout, which is why this
project is not deployed yet — the first publish comes first.

## What the declaration says

`docs.config.js` carries the things only this site can know, and nothing it could compute:

- **the paths** — `src`, the IIFE build of the same commit, the README's own image, `static/`, `site/`;
- **the outputs** — the names the page finds them under, the search index, the editor's directory and
  its notices file;
- **the pins** — p5's version and the one artifact a page's every example loads, one version and no
  `latest`;
- **the references** — p5's documentation grammar (its base and a URL template per name shape, the
  `Tree` namespace it does not claim, and the prefix dropped from a link's text) and the eight class →
  factory aliases; the README's own prose is rendered as written, so a name in passing there stays
  code;
- **the surface** — the IIFE installs onto the `p5` it is handed and leaves nothing of its own, so the
  surface is that host, evaluated with a stub whose `registerAddon` calls back; `owners` says where each
  documented owner lives in it, `ownerOrder` that the sketch's own functions come first;
- **the rules** — a block above an `export` or carrying `@function`/`@constant`/`@typedef` is public,
  the underscored constants are documented on purpose, an example is a complete global-mode sketch that
  defines `setup()`;
- **the page** — `mode: 'esm'`, the stylesheet, and the runner's config block with its `{pin:…}`,
  `{bundle}`, `{index}`, `{editor}` tokens.

## What the build puts on a page

- `#docs-config`: a `<script type="application/json">` block holding `{ p5, lib, font, index, editor }`.
  The runner and the search script read it with `textContent` and `JSON.parse`; no page writes a global
  and no page holds code in an HTML attribute.
- `assets/editor.<hash>.js`: the package's bundle, copied under the name its manifest states. The build
  re-hashes the copy and refuses to write the site if it does not match the manifest's SHA-256, so a
  page can never carry a URL the artifact does not have.
- `assets/runner.js`, `assets/search.js`, `assets/chrome.js`: ES modules, deferred by the browser. The
  runner wires every figure's Run and Reset to the textarea, then imports the editor bundle — only on a
  page that has a `textarea.source` — mounts it, and marks a figure `data-editor="fallback"` if the
  import or the mount fails.
- The editor's look is split: the package ships the structure and the token-role mapping, this site
  states the values — `--cm-*` per role out of its own accent and neutral variables, and the type,
  leading and insets of its code fences. Nothing about a palette lives in the package.
- `assets/editor.LICENSES.txt`: the bundled packages' notices, copied out of the release manifest and
  linked from every page's footer. The bundle carries no legal comments of its own, so this file is the
  notice a reader can reach.
- Every earlier `assets/editor.<hash>.js` is kept when the site is rebuilt: a page served from a cache
  still asks for the editor it was built against.

## The runner

`static/assets/runner.js` is the site's own and stays so: a same-origin `srcdoc` iframe assembled from
p5 (CDN, pinned) + the site-local bundle + the box, run as a classic global-mode sketch; an
IntersectionObserver mounts a figure as it nears the viewport and unmounts it off-screen, at most eight
live at once, losing each WebGL context explicitly. The editor is the package's, imported only where
there is an example. The examples in Chromium are the maintainer's gate; this folder carries no browser
probe, and adding one is a decision the design has not taken.
