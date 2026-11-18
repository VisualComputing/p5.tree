/**
 * @file Example runner — an editable code box and a live p5 canvas per
 * `@example`, with a viewport-driven iframe lifecycle.
 * @license AGPL-3.0-only
 *
 * ES module on every page; no-op where there are no examples. The page's
 * configuration is the `application/json` block `#docs-config` ({ p5, lib,
 * font, index, editor }); the markup is the renderer's `figure.example`
 * (`textarea.source`, `[data-stage]`, `[data-run]`, `[data-reset]`).
 *
 * - Editor: the package's `mountEditor` over the source textarea, imported with
 *   a dynamic `import()` on a page that has one — a page without examples never
 *   asks for the bundle. Until the mount succeeds the textarea is the carrier:
 *   Run and Reset work from it, an edit made while the import is in flight is
 *   kept, and a failed import or mount leaves the textarea in place and marks
 *   the figure `data-editor="fallback"`.
 * - Canvas: a same-origin `srcdoc` iframe, unsandboxed (the examples are the
 *   site's own code; the runner reaches into each frame to stop the sketch and
 *   release its WebGL context, and WebHID and the font fetch need the page's
 *   origin), assembled from p5 (CDN, pinned) + the site-local bundle + the box
 *   contents. `srcdoc` inherits the page's base URL, so the bundle and `fonts/`
 *   resolve relatively.
 * - Run reassembles the iframe from the box; Reset restores the source text.
 *   Edits are page-local — nothing persists.
 * - Lifecycle: an IntersectionObserver mounts an iframe as its figure nears
 *   the viewport and unmounts it once far off-screen; at most LIVE_MAX are
 *   live at once, least recently neared out first. Unmounting stops the
 *   sketch and loses its WebGL context explicitly — Chromium caps concurrent
 *   contexts (~16).
 */

const LIVE_MAX = 8;
const NEAR     = '300px 0px';   // mount when the figure is within this margin of the viewport
const FAR      = '1500px 0px';  // unmount once it is beyond this margin
const STAGE_BG = '#0a0a0e';     // fixed stage — never the page theme

const attr = (s) => String(s).replace(/"/g, '&quot;');

/** The page's configuration: read once from the JSON block, or null. */
function readConfig() {
  const block = document.getElementById('docs-config');
  if (!block) return null;
  try {
    return JSON.parse(block.textContent);
  } catch (_) {
    return null;
  }
}

/** The iframe document: pinned p5, site-local bundle, then the sketch. */
function srcdoc(cfg, code) {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>html,body{margin:0;overflow:hidden;background:${STAGE_BG}}canvas{display:block}</style>
<script src="${attr(cfg.p5)}"></script>
<script src="${attr(cfg.lib)}"></script>
</head><body>
<script>
${code.replace(/<\/(script)/gi, '<\\/$1')}
</script>
</body></html>`;
}

/** Stop the sketch and release its WebGL context, then drop the frame. */
function dispose(frame) {
  try {
    const w      = frame.contentWindow;
    const canvas = w.document.querySelector('canvas');
    if (typeof w.remove === 'function') w.remove();   // p5 global-mode remove()
    const gl = canvas && (canvas.getContext('webgl2') || canvas.getContext('webgl'));
    if (gl) gl.getExtension('WEBGL_lose_context')?.loseContext();
  } catch (_) { /* the frame's document is already gone — removal has to do */ }
  frame.remove();
}

function start(cfg) {
  const figures = document.querySelectorAll('figure.example');
  if (!figures.length) return;

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  const runners = new Map();   // figure → runner
  const live    = [];          // mounted runners, least recently neared first

  const code = (r) => (r.editor ? r.editor.getValue() : r.textarea.value);

  function unmount(r) {
    if (!r.frame) return;
    dispose(r.frame);
    r.frame = null;
    const i = live.indexOf(r);
    if (i >= 0) live.splice(i, 1);
  }

  function mount(r) {
    unmount(r);
    while (live.length >= LIVE_MAX) unmount(live[0]);
    const f = document.createElement('iframe');
    f.className = 'sketch';
    f.title     = r.title;
    f.setAttribute('allow', 'hid');
    f.srcdoc = srcdoc(cfg, code(r));
    r.stage.replaceChildren(f);
    r.frame = f;
    live.push(r);
  }

  function touch(r) {
    const i = live.indexOf(r);
    if (i >= 0) live.push(...live.splice(i, 1));
  }

  const near = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const r = runners.get(e.target);
      r.frame ? touch(r) : mount(r);
    }
  }, { rootMargin: NEAR });

  const far = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) unmount(runners.get(e.target));
    }
  }, { rootMargin: FAR });

  // ── The editor, where there is one to mount ───────────────────────────────

  /**
   * Import the bundle once and mount every box. The textarea has been carrying
   * Run and Reset until now: the import is started after the wiring, and its
   * failure is the fallback, not an unhandled rejection.
   */
  async function mountEditors() {
    let mountEditor;
    try {
      ({ mountEditor } = await import(new URL(cfg.editor, document.baseURI).href));
    } catch (_) {
      for (const r of runners.values()) r.figure.dataset.editor = 'fallback';
      return;
    }
    for (const r of runners.values()) {
      try {
        r.editor = mountEditor(r.textarea, { value: r.source, onRun: () => mount(r), wrap: false });
      } catch (_) {
        r.editor = null;
        r.figure.dataset.editor = 'fallback';
      }
      // The adapter handles a mount failure itself and hands back the textarea's
      // verbs; its marker is the one to carry up to the figure.
      if (r.textarea.dataset.editor === 'fallback') r.figure.dataset.editor = 'fallback';
    }
  }

  // ── Wire every example ────────────────────────────────────────────────────

  for (const figure of figures) {
    const textarea = figure.querySelector('textarea.source');
    const stage    = figure.querySelector('[data-stage]');
    if (!textarea || !stage) continue;

    const r = {
      figure, stage, textarea,
      source: textarea.value,
      title:  figure.querySelector('figcaption')?.textContent.trim() || figure.id,
      editor: null,
      frame:  null,
    };
    const run   = () => mount(r);
    const reset = () => (r.editor ? r.editor.reset() : (textarea.value = r.source));

    runners.set(figure, r);
    near.observe(figure);
    far.observe(figure);

    figure.querySelector('[data-run]')?.addEventListener('click', run);
    figure.querySelector('[data-reset]')?.addEventListener('click', reset);
  }

  mountEditors();
}

const config = readConfig();
if (config) start(config);
