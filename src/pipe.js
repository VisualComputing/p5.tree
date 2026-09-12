/**
 * @file Post-processing the frame with shaders.
 * @module p5.tree/pipe
 * @license AGPL-3.0-only
 *
 * Run a drawn layer through one or more filter shaders — blur, pixelate,
 * vignette, colour grading — and show the result on the canvas, or keep it in
 * a framebuffer for further use. `pipe()` chains the passes for you;
 * `releasePipe()` frees the framebuffers it kept for a chain.
 *
 * Reach for it when a `baseFilterShader()` effect should apply to a whole
 * rendered frame rather than to a single shape.
 *
 * @details
 * Contains the `fn.pipe()` and `fn.releasePipe()` functions.
 */

'use strict';

// Install pipe() and releasePipe() on fn.
export function installPipe(p5, fn) {
  /**
   * Run a source texture through one or more filter shaders in sequence and draw
   * the result on the canvas, or keep it off-screen and use the returned
   * framebuffer with `display` set to false (see the off-screen example). The two
   * working framebuffers are managed for you; `key` separates independent chains,
   * and `ping`/`pong` let you supply your own. Needs a `p5.WEBGL` canvas, a source,
   * and filter shaders.
   *
   * @details
   * Pipes a source through one or more post-processing passes (filters), optionally displaying
   * the final output on the main canvas.
   *
   * By default, pipe allocates and caches internal ping/pong framebuffers (keyed) and lazily
   * resizes them to match the source. Advanced users may override ping/pong explicitly.
   *
   * Args may be provided in any order (source, pass(es), opt).
   *
   * @function pipe
   * @memberof p5
   * @param {p5.Framebuffer|p5.Texture|p5.Image|p5.Graphics} source  Input texture; a `p5.Framebuffer` contributes its `.color`.
   * @param {p5.Shader|p5.Shader[]} passes  A pass or array of passes (e.g. `baseFilterShader().modify(...)`); falsy entries ignored.
   * @param {Object} [opt]  Options.
   * @param {boolean} [opt.display=true] If true, draw the final output to the main canvas.
   * @param {boolean} [opt.allocate=true] If true, create the two working framebuffers when missing (kept per `key`).
   * @param {string} [opt.key='default'] Name of the working framebuffer pair; give each independent chain its own key.
   * @param {p5.Framebuffer} [opt.ping] Your own first working framebuffer (advanced; not kept by `pipe()`).
   * @param {p5.Framebuffer} [opt.pong] Your own second working framebuffer (advanced; not kept by `pipe()`).
   * @param {boolean} [opt.clear=true] If true, clear each working framebuffer before a pass draws into it.
   * @param {boolean} [opt.clearDisplay=true] If true and `display` is true, clear the main canvas before drawing the final output.
   * @param {function} [opt.clearFn] How to clear a working framebuffer before a pass. Defaults to `background(0)`.
   * @param {function} [opt.clearDisplayFn] How to clear the main canvas before the final output. Defaults to `clearFn`.
   * @param {function} [opt.draw] How to draw the current texture onto the current target. Defaults to a full-canvas copy.
   * @returns {p5.Framebuffer|null} The framebuffer holding the final result, or null when no working framebuffers were available.
   * @example
   * <caption>One pass: a pixelate filter, its level driven by the mouse</caption>
   * let layer, pixelate
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   layer = createFramebuffer()
   *   pixelate = baseFilterShader().modify(() => {
   *     const level = uniformFloat(() => map(mouseX, 0, width, 8, 120))
   *     getColor((inputs, canvasContent) => {
   *       const c = getTexture(canvasContent, floor(inputs.texCoord * level) / level)
   *       return [c.rgb, 1]
   *     })
   *   })
   * }
   *
   * function draw() {
   *   layer.begin()
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   rotateY(frameCount * 0.01)
   *   stroke('white')
   *   fill('#ff4fd8')
   *   box(60)
   *   layer.end()
   *   pipe(layer, pixelate)
   * }
   * @example
   * <caption>A chain kept off-screen: the returned framebuffer textures a pane</caption>
   * let layer, pixelate, vignette
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   layer = createFramebuffer()
   *   pixelate = baseFilterShader().modify(() => {
   *     getColor((inputs, canvasContent) => {
   *       const c = getTexture(canvasContent, floor(inputs.texCoord * 24) / 24)
   *       return [c.rgb, 1]
   *     })
   *   })
   *   vignette = baseFilterShader().modify(() => {
   *     getColor((inputs, canvasContent) => {
   *       const c = getTexture(canvasContent, inputs.texCoord)
   *       const d = length(inputs.texCoord - [0.5, 0.5])
   *       return [c.rgb * (1 - d), 1]
   *     })
   *   })
   * }
   *
   * function draw() {
   *   layer.begin()
   *   background('#ffd166')
   *   rotateY(frameCount * 0.02)
   *   stroke('white')
   *   fill('#ff4fd8')
   *   box(60)
   *   layer.end()
   *   const out = pipe(layer, [pixelate, vignette], { display: false })
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   push()
   *   rotateY(frameCount * 0.01)
   *   noStroke()
   *   pane([-80, -60, -40], [80, -60, -40], [80, 60, -40], [-80, 60, -40], { texture: out.color })
   *   pop()
   * }
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
   * Free the framebuffers `pipe()` cached for a pipeline: the default one, a named
   * `key`, or every pipeline with true (see the example). Framebuffers you
   * supplied yourself are left alone.
   *
   * @details
   * Release internal cached pipe framebuffers created by pipe() when opt.allocate is true.
   * Does NOT remove user-provided ping/pong passed via opt.ping/opt.pong.
   *
   * @function releasePipe
   * @memberof p5
   * @param {string|boolean} [key] If omitted, releases the default key ('default').
   *                              If a string, releases only that key.
   *                              If true, releases all keys.
   * @example
   * <caption>Free a keyed pipeline's buffers when its effect is switched off</caption>
   * let layer, pixelate
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   layer = createFramebuffer()
   *   pixelate = baseFilterShader().modify(() => {
   *     getColor((inputs, canvasContent) => {
   *       const c = getTexture(canvasContent, floor(inputs.texCoord * 24) / 24)
   *       return [c.rgb, 1]
   *     })
   *   })
   * }
   *
   * function draw() {
   *   layer.begin()
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   rotateY(frameCount * 0.01)
   *   stroke('white')
   *   fill('#ff4fd8')
   *   box(60)
   *   layer.end()
   *   if (mouseIsPressed) pipe(layer, pixelate, { key: 'fx' })   // allocates the fx ping/pong on first use
   *   else pipe(layer)                                            // no passes: a plain blit
   * }
   *
   * function mouseReleased() {
   *   releasePipe('fx')   // reallocated on the next press
   * }
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

// Release all pipe framebuffers. Called from lifecycles.remove.
export function releaseAllPipes(pInst) {
  if (typeof pInst.releasePipe === 'function') {
    pInst.releasePipe(true);
  }
}
