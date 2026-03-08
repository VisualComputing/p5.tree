/**
 * @file Post-processing pipeline (pipe + releasePipe).
 * @module p5.tree/pipe
 * @license GPL-3.0-only
 *
 * Contains the `fn.pipe()` and `fn.releasePipe()` functions.
 */

'use strict';

/**
 * Install pipe() and releasePipe() on fn.
 * @param {p5} p5  The p5 constructor.
 * @param {Object} fn  p5 prototype.
 */
export function installPipe(p5, fn) {
  /**
   * Pipes a source through one or more post-processing passes (filters), optionally displaying
   * the final output on the main canvas.
   *
   * By default, pipe allocates and caches internal ping/pong framebuffers (keyed) and lazily
   * resizes them to match the source. Advanced users may override ping/pong explicitly.
   *
   * Args may be provided in any order (source, pass(es), opt).
   *
   * Logical args:
   * - source: p5.Framebuffer|p5.Texture|p5.Image|p5.Graphics (if a p5.Framebuffer is provided, its .color is used)
   * - passes: a pass or array of passes (e.g. baseFilterShader().modify(...)); falsy entries ignored
   * - opt: options object
   *
   * @method pipe
   * @for p5
   * @param {...*} args Source, pass(es), and options in any order.
   * @param {boolean} [opt.display=true] If true, draw the final output to the main canvas.
   * @param {boolean} [opt.allocate=true] If true, allocate internal ping/pong when missing (cached per key).
   * @param {string} [opt.key='default'] Cache key for internal ping/pong (advanced; useful for multiple independent pipelines).
   * @param {p5.Framebuffer} [opt.ping] Optional user-provided ping framebuffer (advanced override; not cached internally).
   * @param {p5.Framebuffer} [opt.pong] Optional user-provided pong framebuffer (advanced override; not cached internally).
   * @param {boolean} [opt.clear=true] If true, clear each ping/pong pass target before drawing into it.
   * @param {boolean} [opt.clearDisplay=true] If true and opt.display is true, clear the main canvas before drawing final output.
   * @param {function} [opt.clearFn] Clear strategy for ping/pong passes. Defaults to () => this.background(0).
   * @param {function} [opt.clearDisplayFn] Clear strategy for display stage. Defaults to opt.clearFn.
   * @param {function} [opt.draw] Draw strategy used to place the current texture on the current render target. Defaults to full-canvas blit.
   * @returns {p5.Framebuffer|null} The final framebuffer used (ping or pong) when ping/pong are available; otherwise null.
   */
  fn.pipe = function (...args) {
    const p = this;
    let source;
    let passes = [];
    let opt = {};
    args.forEach(arg => {
      if (Array.isArray(arg) || arg instanceof p5.Shader) {
        passes = arg;
      } else if (arg && typeof arg === 'object') {
        const isFramebuffer = typeof p5.Framebuffer !== 'undefined' && arg instanceof p5.Framebuffer;
        const isGraphics = arg instanceof p5.Graphics;
        const isImage = arg instanceof p5.Image;
        const isTexture = typeof p5.Texture !== 'undefined' && arg instanceof p5.Texture;
        (isFramebuffer || isGraphics || isImage || isTexture) ? (source = arg) : (opt = arg);
      } else if (arg) {
        source = arg;
      }
    });
    const _rawPasses = Array.isArray(passes) ? passes : [passes];
    const _passes = (_rawPasses || []).filter(Boolean);
    const _opt = opt || {};
    const display = _opt.display ?? true;
    const allocate = _opt.allocate ?? true;
    const key = _opt.key ?? 'default';
    const clearPasses = _opt.clear ?? true;
    const clearDisplay = _opt.clearDisplay ?? true;
    const defaultClear = () => p.background(0);
    const clearFn = typeof _opt.clearFn === 'function' ? _opt.clearFn : defaultClear;
    const clearDisplayFn = typeof _opt.clearDisplayFn === 'function' ? _opt.clearDisplayFn : clearFn;
    const defaultDraw = (tex) => {
      p.imageMode(p.CORNER);
      p.image(tex, -p.width / 2, -p.height / 2, p.width, p.height);
    };
    const draw = typeof _opt.draw === 'function' ? _opt.draw : defaultDraw;
    const srcTex = source?.color ?? source;
    if (!_passes.length) {
      if (display && srcTex) {
        clearDisplay && clearDisplayFn();
        draw(srcTex);
      }
      return null;
    }
    const sizeFrom = (s) => {
      const w = s?.width ?? s?.color?.width ?? p.width;
      const h = s?.height ?? s?.color?.height ?? p.height;
      return [w, h];
    };
    const [w, h] = sizeFrom(source);
    const ensureSize = (fb) => {
      fb && (fb.width !== w || fb.height !== h) && fb.resize(w, h);
    };
    const applyPassClear = () => {
      clearPasses && clearFn();
    };
    const applyDisplayClear = () => {
      clearDisplay && clearDisplayFn();
    };
    const hasPing = Object.prototype.hasOwnProperty.call(_opt, 'ping');
    const hasPong = Object.prototype.hasOwnProperty.call(_opt, 'pong');
    p._tree ||= {};
    p._tree._pipe ||= {};
    p._tree._pipe[key] ||= {};
    const store = p._tree._pipe[key];
    let ping = hasPing ? _opt.ping : store.ping;
    let pong = hasPong ? _opt.pong : store.pong;
    if (allocate) {
      !ping && !hasPing && (ping = p.createFramebuffer());
      !pong && !hasPong && (pong = p.createFramebuffer());
      !hasPing && (store.ping = ping);
      !hasPong && (store.pong = pong);
    }
    if (ping && pong) {
      ensureSize(ping);
      ensureSize(pong);
    }
    if (!ping || !pong) {
      if (display && srcTex) {
        applyDisplayClear();
        draw(srcTex);
        p.filter(_passes[0]);
      }
      return null;
    }
    let readTex = srcTex;
    let out = null;
    for (let i = 0; i < _passes.length; i++) {
      const dst = (i % 2 === 0) ? ping : pong;
      dst.begin();
      applyPassClear();
      draw(readTex);
      p.filter(_passes[i]);
      dst.end();
      readTex = dst.color;
      out = dst;
    }
    if (display && readTex) {
      applyDisplayClear();
      draw(readTex);
    }
    return out;
  };
  
  /**
   * Release internal cached pipe framebuffers created by pipe() when opt.allocate is true.
   * Does NOT remove user-provided ping/pong passed via opt.ping/opt.pong.
   *
   * @method releasePipe
   * @for p5
   * @param {string|boolean} [key] If omitted, releases the default key ('default').
   *                              If a string, releases only that key.
   *                              If true, releases all keys.
   */
  fn.releasePipe = function (key) {
    const p = this;
    const store = p._tree?._pipe;
    if (!store) return;
    const releasePair = (pair) => {
      pair?.ping && pair.ping.remove();
      pair?.pong && pair.pong.remove();
    };
    if (key === true) {
      Object.keys(store).forEach(k => {
        releasePair(store[k]);
        delete store[k];
      });
      return;
    }
    const k = typeof key === 'string' ? key : 'default';
    releasePair(store[k]);
    delete store[k];
  };
}

/**
 * Release all pipe framebuffers. Called from lifecycles.remove.
 * @param {p5} pInst  The p5 instance.
 */
export function releaseAllPipes(pInst) {
  if (typeof pInst.releasePipe === 'function') {
    pInst.releasePipe(true);
  }
}
