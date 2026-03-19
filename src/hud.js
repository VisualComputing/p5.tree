/**
 * @file HUD (Heads-Up Display) — 2D screen-space overlay mode.
 * @module p5.tree/hud
 * @license AGPL-3.0-only
 *
 * Coordinates: (x, y) ∈ [0, width] × [0, height], origin top-left,
 * y increasing downward.
 *
 * Usage:
 *   beginHUD()
 *   text('FPS: ' + frameRate().toFixed(1), 10, 20)
 *   endHUD()
 */

'use strict';

/**
 * Install beginHUD() and endHUD() on fn.
 * @param {p5}    p5
 * @param {Object} fn  p5 prototype.
 */
export function installHud(p5, fn) {

  fn.beginHUD = function (...args) { this._renderer?.beginHUD?.(...args); return this; };
  fn.endHUD   = function (...args) { this._renderer?.endHUD?.(...args);   return this; };

  /**
   * Begin drawing in screen space (HUD mode).
   *
   * Clears depth, installs an orthographic camera matching canvas pixel
   * dimensions, origin top-left. Pair with `endHUD()`.
   *
   * @method beginHUD
   * @for p5
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
   * @method endHUD
   * @for p5
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
