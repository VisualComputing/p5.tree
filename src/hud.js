/**
 * @file Drawing in screen space over the scene.
 * @module p5.tree/hud
 * @license AGPL-3.0-only
 *
 * Draw 2D overlays — text, cursors, gauges — on top of a WEBGL scene using
 * plain pixel coordinates. Call `beginHUD()`, draw as in 2D mode with the
 * origin at the top-left corner of the canvas, then call `endHUD()` to return
 * to 3D.
 *
 * Reach for it whenever a readout or a marker should sit at a fixed spot on
 * the canvas, whatever the camera does.
 *
 * @details
 * Coordinates: (x, y) ∈ [0, width] × [0, height], origin top-left,
 * y increasing downward.
 *
 * ```js
 * beginHUD()
 * text('FPS: ' + frameRate().toFixed(1), 10, 20)
 * endHUD()
 * ```
 */

'use strict';

// Install beginHUD() and endHUD() on fn.
export function installHud(p5, fn) {

  fn.beginHUD = function (...args) { this._renderer?.beginHUD?.(...args); return this; };
  fn.endHUD   = function (...args) { this._renderer?.endHUD?.(...args);   return this; };

  /**
   * Start drawing in screen space over the 3D scene: pixel coordinates with the
   * origin at the top-left corner of the canvas, as in 2D mode. Pair every call
   * with `endHUD()` (see the frame-rate example). Needs a `p5.WEBGL` canvas; text
   * needs a loaded font.
   *
   * @details
   * Begin drawing in screen space (HUD mode).
   *
   * Clears depth, installs an orthographic camera matching canvas pixel
   * dimensions, origin top-left. Pair with `endHUD()`.
   *
   * @function beginHUD
   * @memberof p5
   * @returns {p5} this
   * @example
   * <caption>Frame-rate readout over a 3D scene</caption>
   * async function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   textFont(await loadFont('fonts/noto_sans.ttf'))
   *   textSize(14)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   stroke('white')
   *   noFill()
   *   box(60)
   *   beginHUD()
   *   noStroke()
   *   fill('white')
   *   text('fps ' + frameRate().toFixed(0), 10, 20)
   *   endHUD()
   * }
   */
  p5.Renderer3D.prototype.beginHUD = function () {
    if (this._hudActive === true) return;
    const p = this._pInst;
    const states = this.states;
    if (!p || !states) return;
    p.push();
    p.resetShader();
    p.resetMatrix();
    this._hudPrevCam = states.curCamera;
    this._hudDepthMode = undefined;
    this._hudDepthWasEnabled = undefined;
    if (typeof this.clearDepth === 'function') {
      this.flushDraw?.();
      this.clearDepth(1);
      this._hudDepthMode = 'clearDepth';
    } else {
      const gl = this.drawingContext;
      if (gl && typeof gl.isEnabled === 'function' && gl.DEPTH_TEST !== undefined) {
        this._hudDepthWasEnabled = gl.isEnabled(gl.DEPTH_TEST);
        gl.flush?.();
        gl.disable(gl.DEPTH_TEST);
        this._hudDepthMode = 'depthTestToggle';
      }
    }
    if (this._hudCam === undefined) this._hudCam = p.createCamera();
    const z = 1e6;
    this._hudCam.ortho(0, p.width, -p.height, 0, -z, z);
    this._hudCam.camera(0, 0, 1, 0, 0, 0, 0, 1, 0);
    p.setCamera(this._hudCam);
    this._hudActive = true;
  };

  /**
   * End HUD mode, restoring the 3D camera and depth state.
   *
   * @function endHUD
   * @memberof p5
   * @returns {p5} this
   * @example
   * <caption>3D drawing resumes after endHUD()</caption>
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   beginHUD()
   *   noStroke()
   *   fill('#ff4fd8')
   *   circle(mouseX, mouseY, 16)
   *   endHUD()
   *   stroke('white')
   *   noFill()
   *   box(60)
   * }
   */
  p5.Renderer3D.prototype.endHUD = function () {
    if (this._hudActive !== true) return;
    const p = this._pInst;
    if (!p) return;
    if (this._hudDepthMode === 'depthTestToggle') {
      const gl = this.drawingContext;
      if (gl && gl.DEPTH_TEST !== undefined) {
        gl.flush?.();
        this._hudDepthWasEnabled ? gl.enable(gl.DEPTH_TEST) : gl.disable(gl.DEPTH_TEST);
      }
    }
    p.pop();
    this._hudPrevCam !== undefined && p.setCamera(this._hudPrevCam);
    this._hudPrevCam = undefined;
    this._hudDepthWasEnabled = undefined;
    this._hudDepthMode = undefined;
    this._hudActive = false;
  };
}
