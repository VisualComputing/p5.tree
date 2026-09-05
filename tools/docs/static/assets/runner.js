/**
 * @file Example runner — an editable code box and a live p5 canvas per
 * `@example`, with a viewport-driven iframe lifecycle.
 * @license AGPL-3.0-only
 *
 * Classic deferred script on every page; no-op where there are no examples.
 * Config arrives in `window.p5treeDocs` ({ p5, lib, font }); markup is the
 * renderer's `figure.example` (`textarea.source`, `[data-stage]`,
 * `[data-run]`, `[data-reset]`).
 *
 * - Editor: CodeMirror 5 over the source textarea; the bare textarea is the
 *   fallback when CodeMirror is absent.
 * - Canvas: a sandboxed `srcdoc` iframe assembled from p5 (CDN, pinned) +
 *   the site-local bundle + the box contents. `srcdoc` inherits the page's
 *   base URL, so the bundle and `fonts/` resolve relatively.
 * - Run reassembles the iframe from the box; Reset restores the source text.
 *   Edits are page-local — nothing persists.
 * - Lifecycle: an IntersectionObserver mounts an iframe as its figure nears
 *   the viewport and unmounts it once far off-screen; at most LIVE_MAX are
 *   live at once, least recently neared out first. Unmounting stops the
 *   sketch and loses its WebGL context explicitly — Chromium caps concurrent
 *   contexts (~16).
 */

(function () {
  'use strict';

  const cfg     = window.p5treeDocs;
  const figures = document.querySelectorAll('figure.example');
  if (!cfg || !figures.length) return;

  const LIVE_MAX = 8;
  const NEAR     = '300px 0px';   // mount when the figure is within this margin of the viewport
  const FAR      = '1500px 0px';  // unmount once it is beyond this margin
  const STAGE_BG = '#0a0a0e';     // fixed stage — never the page theme

  // `allow-same-origin` keeps the frame on the page's origin: WebHID
  // permissions and the font fetch both need a real (non-opaque) origin.
  // Drop it for a strict sandbox at the cost of both.
  const SANDBOX  = 'allow-scripts allow-same-origin';

  const attr = (s) => String(s).replace(/"/g, '&quot;');

  /** The iframe document: pinned p5, site-local bundle, then the sketch. */
  function srcdoc(code) {
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
    } catch (_) { /* opaque origin under a stricter SANDBOX — removal has to do */ }
    frame.remove();
  }

  function editorOf(textarea, run) {
    if (!window.CodeMirror) return null;
    return window.CodeMirror.fromTextArea(textarea, {
      mode:           'javascript',
      lineNumbers:    true,
      indentUnit:     2,
      tabSize:        2,
      viewportMargin: Infinity,   // render every line — the box grows to fit the sketch
      extraKeys:      { 'Ctrl-Enter': run, 'Cmd-Enter': run },
    });
  }

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
    f.setAttribute('sandbox', SANDBOX);
    f.setAttribute('allow', 'hid');
    f.srcdoc = srcdoc(code(r));
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
    const reset = () => (r.editor ? r.editor.setValue(r.source) : (textarea.value = r.source));

    r.editor = editorOf(textarea, run);
    figure.querySelector('[data-run]')?.addEventListener('click', run);
    figure.querySelector('[data-reset]')?.addEventListener('click', reset);

    runners.set(figure, r);
    near.observe(figure);
    far.observe(figure);
  }
})();
