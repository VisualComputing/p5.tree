/**
 * @file Matrix queries, space transforms, and HUD — p5 bridge layer.
 * @module p5.tree/matrix
 * @license GPL-3.0-only
 *
 * Module-level scratch allocated at import time. _ndcZ detected in postsetup.
 */

import {
  WORLD, EYE, NDC, SCREEN, MODEL, MATRIX, WEBGL, WEBGPU,
  mat4Mul, mat4Invert, mat3NormalFromMat4,
  mat4Location, mat3Direction,
  mapLocation as coreMapLocation,
  mapDirection as coreMapDirection,
  projIsOrtho, projNear, projFar, projFov, projHfov,
  projLeft, projRight, projTop, projBottom,
  pixelRatio as corePixelRatio,
} from '@nakednous/tree';

// ═══════════════════════════════════════════════════════════════════════════
// Module-level scratch — allocated once at import time
// ═══════════════════════════════════════════════════════════════════════════

const _pv   = new Float32Array(16);
const _ipv  = new Float32Array(16);
const _inv  = new Float32Array(16);
const _inv2 = new Float32Array(16);  // separate scratch for toFrameInv
const _nMat = new Float32Array(9);
const _v3   = new Float32Array(3);

// ═══════════════════════════════════════════════════════════════════════════
// NDC convention — detected once in postsetup
// ═══════════════════════════════════════════════════════════════════════════

let _ndcZ = WEBGL;

/** Called from addon index.js lifecycles.postsetup. */
export function detectNDC(renderer) {
  // The renderer type determines the NDC Z convention.
  // In p5.js, WEBGL and WEBGPU are the 3rd param to createCanvas.
  // We detect based on the rendering context type.
  if (renderer.drawingContext &&
      typeof WebGL2RenderingContext !== 'undefined' &&
      renderer.drawingContext instanceof WebGL2RenderingContext) {
    _ndcZ = WEBGL;
  } else {
    // WebGPU or future backends
    _ndcZ = WEBGPU;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Raw p5 state access — direct Float32Array refs, no copies
// ═══════════════════════════════════════════════════════════════════════════

function _projMat4(renderer) {
  return renderer.states.uPMatrix.mat4;
}

function _viewMat4(renderer) {
  return renderer.states.curCamera.cameraMatrix.mat4;
}

function _modelMat4(renderer) {
  return renderer.states.uModelMatrix.mat4;
}

// ═══════════════════════════════════════════════════════════════════════════
// Install
// ═══════════════════════════════════════════════════════════════════════════

export function installMatrix(p5, fn) {

  // ── Private immutable wrappers (p5.Matrix level) ────────────────────────

  const _invert = function (matrix) {
    const out = matrix.clone();
    out.invert(matrix);
    return out;
  };

  const _transpose = function (matrix) {
    const m4 = matrix.mat4;
    if (m4) {
      return new p5.Matrix([
        m4[0],m4[4],m4[8],m4[12],
        m4[1],m4[5],m4[9],m4[13],
        m4[2],m4[6],m4[10],m4[14],
        m4[3],m4[7],m4[11],m4[15]
      ]);
    }
    const m3 = matrix.mat3;
    if (m3) {
      return new p5.Matrix([
        m3[0],m3[3],m3[6],
        m3[1],m3[4],m3[7],
        m3[2],m3[5],m3[8]
      ]);
    }
  };

  // ── p5.Matrix operations ─────────────────────────────────────────────

  fn.tMatrix = function (matrix) { return _transpose(matrix); };
  fn.iMatrix = function (matrix) { return _invert(matrix); };
  fn.axbMatrix = function (a, b) { return a.clone().mult(b); };
  fn.createMatrix = (...args) => new p5.Matrix(...args);

  // ── Matrix queries (immutable copies) ──────────────────────────────

  p5.Renderer3D.prototype.pMatrix = function () { return this.states.uPMatrix.clone(); };
  fn.pMatrix = function () { return this._renderer.pMatrix(); };

  p5.Renderer3D.prototype.mMatrix = function () { return this.states.uModelMatrix.clone(); };
  fn.mMatrix = function () { return this._renderer.mMatrix(); };

  p5.Camera.prototype.vMatrix = function () { return this.cameraMatrix.clone(); };

  p5.Camera.prototype.eMatrix = function () {
    mat4Invert(_inv, this.cameraMatrix.mat4);
    return new p5.Matrix(Array.from(_inv));
  };

  p5.Renderer3D.prototype.vMatrix = function () { return this.states.curCamera.vMatrix(); };
  fn.vMatrix = function () { return this._renderer.vMatrix(); };

  p5.Renderer3D.prototype.eMatrix = function () { return this.states.curCamera.eMatrix(); };
  fn.eMatrix = function () { return this._renderer.eMatrix(); };

  // ── lMatrix / dMatrix ──────────────────────────────────────────────
  
  p5.Renderer3D.prototype.lMatrix = function ({ from = new p5.Matrix(4), to = this.eMatrix() } = {}) {
    mat4Location(_inv, from.mat4, to.mat4);
    return new p5.Matrix(Array.from(_inv));
  };
  fn.lMatrix = function (opts = {}) { return this._renderer.lMatrix(opts); };
  
  p5.Renderer3D.prototype.dMatrix = function ({ from = new p5.Matrix(4), to = this.eMatrix() } = {}) {
    mat3Direction(_nMat, from.mat4, to.mat4);
    return new p5.Matrix(Array.from(_nMat));
  };
  fn.dMatrix = function (opts = {}) { return this._renderer.dMatrix(opts); };

  // ── Derived matrices (use core ops on raw buffers) ────────────────

  p5.Renderer3D.prototype.mvMatrix = function ({ vMatrix, mMatrix } = {}) {
    return (mMatrix || this.states.uModelMatrix).clone().mult(vMatrix || this.states.curCamera.cameraMatrix);
  };
  fn.mvMatrix = function (opts = {}) { return this._renderer.mvMatrix(opts); };

  p5.Renderer3D.prototype.nMatrix = function ({ vMatrix, mMatrix, mvMatrix = this.mvMatrix({ mMatrix, vMatrix }) } = {}) {
    mat3NormalFromMat4(_nMat, mvMatrix.mat4);
    return new p5.Matrix(Array.from(_nMat));
  };
  fn.nMatrix = function (opts = {}) { return this._renderer.nMatrix(opts); };

  p5.Renderer3D.prototype.pmvMatrix = function ({ pMatrix = this.pMatrix(), vMatrix, mMatrix, mvMatrix } = {}) {
    return (mvMatrix ? mvMatrix.clone() : this.mvMatrix({ mMatrix, vMatrix })).mult(pMatrix);
  };
  fn.pmvMatrix = function (opts = {}) { return this._renderer.pmvMatrix(opts); };

  p5.Renderer3D.prototype.pvMatrix = function ({ pMatrix = this.pMatrix(), vMatrix } = {}) {
    return (vMatrix || (this.states.uViewMatrix || this.states.curCamera.cameraMatrix)).clone().mult(pMatrix);
  };
  fn.pvMatrix = function (opts = {}) { return this._renderer.pvMatrix(opts); };

  p5.Renderer3D.prototype.ipvMatrix = function ({ pMatrix, vMatrix, pvMatrix = this.pvMatrix({ pMatrix, vMatrix }) } = {}) {
    return _invert(pvMatrix);
  };
  fn.ipvMatrix = function (opts = {}) { return this._renderer.ipvMatrix(opts); };

  // ── Projection queries ────────────────────────────────────────────

  p5.Matrix.prototype.isOrtho = function () { return projIsOrtho(this.mat4); };
  p5.Renderer3D.prototype.isOrtho = function () { return projIsOrtho(_projMat4(this)); };
  fn.isOrtho = function () { return this._renderer.isOrtho(); };

  p5.Matrix.prototype.nPlane = function () { return projNear(this.mat4, _ndcZ); };
  p5.Matrix.prototype.fPlane = function () { return projFar(this.mat4); };
  p5.Matrix.prototype.lPlane = function () { return projLeft(this.mat4, _ndcZ); };
  p5.Matrix.prototype.rPlane = function () { return projRight(this.mat4, _ndcZ); };
  p5.Matrix.prototype.tPlane = function () { return projTop(this.mat4, _ndcZ); };
  p5.Matrix.prototype.bPlane = function () { return projBottom(this.mat4, _ndcZ); };

  p5.Renderer3D.prototype.nPlane = function () { return projNear(_projMat4(this), _ndcZ); };
  p5.Renderer3D.prototype.fPlane = function () { return projFar(_projMat4(this)); };
  p5.Renderer3D.prototype.lPlane = function () { return projLeft(_projMat4(this), _ndcZ); };
  p5.Renderer3D.prototype.rPlane = function () { return projRight(_projMat4(this), _ndcZ); };
  p5.Renderer3D.prototype.tPlane = function () { return projTop(_projMat4(this), _ndcZ); };
  p5.Renderer3D.prototype.bPlane = function () { return projBottom(_projMat4(this), _ndcZ); };

  fn.nPlane = function () { return this._renderer.nPlane(); };
  fn.fPlane = function () { return this._renderer.fPlane(); };
  fn.lPlane = function () { return this._renderer.lPlane(); };
  fn.rPlane = function () { return this._renderer.rPlane(); };
  fn.tPlane = function () { return this._renderer.tPlane(); };
  fn.bPlane = function () { return this._renderer.bPlane(); };

  p5.Matrix.prototype.fov = function () {
    if (this.mat4[15] !== 0) { console.error('[tree.matrix] fov only works for a perspective projection.'); return; }
    return projFov(this.mat4);
  };
  p5.Matrix.prototype.hfov = function () {
    if (this.mat4[15] !== 0) { console.error('[tree.matrix] hfov only works for a perspective projection.'); return; }
    return projHfov(this.mat4);
  };

  p5.Renderer3D.prototype.fov = function () { return this.states.uPMatrix.fov(); };
  p5.Renderer3D.prototype.hfov = function () { return this.states.uPMatrix.hfov(); };
  fn.fov = function () { return this._renderer.fov(); };
  fn.hfov = function () { return this._renderer.hfov(); };

  // ── HUD (beginHUD / endHUD) ──────────────────────────────────────

  fn.beginHUD = function (...args) { this._renderer?.beginHUD?.(...args); return this; };
  fn.endHUD = function (...args) { this._renderer?.endHUD?.(...args); return this; };

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

  // ── _parseTransformArgs ──────────────────────────────────────────

  p5.Renderer3D.prototype._parseTransformArgs = function (defaultMainArg, ...args) {
    let mainArg = defaultMainArg;
    const options = {};
    for (const arg of args) {
      if (arg instanceof p5.Vector || Array.isArray(arg)) { mainArg = arg; }
      else if (arg && typeof arg === 'object') { Object.assign(options, arg); }
    }
    return { mainArg, options };
  };

  // ── mapLocation ──────────────────────────────────────────────────

  fn.mapLocation = function (...args) { return this._renderer.mapLocation(...args); };

  p5.Renderer3D.prototype.mapLocation = function (...args) {
    const { mainArg, options } = this._parseTransformArgs(p5.Tree.ORIGIN, ...args);

    const px = mainArg.x ?? mainArg[0] ?? 0;
    const py = mainArg.y ?? mainArg[1] ?? 0;
    const pz = mainArg.z ?? mainArg[2] ?? 0;

    let from = options.from ?? p5.Tree.EYE;
    let to   = options.to   ?? p5.Tree.WORLD;

    // Resolve MODEL → model matrix
    if (from == p5.Tree.MODEL) from = this.mMatrix();
    if (to == p5.Tree.MODEL) to = this.mMatrix();

    // Build matrices bag
    const bag = {
      proj: options.pMatrix?.mat4 ?? _projMat4(this),
      view: options.vMatrix?.mat4 ?? _viewMat4(this),
      eye: null,
      pv: null,
      ipv: null,
    };

    let fromStr, toStr;

    // Resolve custom p5.Matrix frames
    if (from instanceof p5.Matrix) {
      bag.fromFrame = from.mat4; fromStr = MATRIX;
    } else { fromStr = from; }

    if (to instanceof p5.Matrix) {
      mat4Invert(_inv2, to.mat4);
      bag.toFrameInv = _inv2; bag.toFrame = to.mat4; toStr = MATRIX;
    } else { toStr = to; }

    // Pre-compute derived matrices as needed
    if (fromStr === EYE || toStr === EYE || fromStr === SCREEN || toStr === SCREEN ||
        fromStr === NDC || toStr === NDC) {
      if (options.eMatrix) { bag.eye = options.eMatrix.mat4; }
      else { mat4Invert(_inv, bag.view); bag.eye = new Float32Array(_inv); }
    }
    if (toStr === SCREEN || toStr === NDC || fromStr === SCREEN || fromStr === NDC) {
      if (options.pvMatrix) { bag.pv = options.pvMatrix.mat4; }
      else { mat4Mul(_pv, bag.proj, bag.view); bag.pv = _pv; }

      if (fromStr === SCREEN || fromStr === NDC) {
        if (options.ipvMatrix) { bag.ipv = options.ipvMatrix.mat4; }
        else { mat4Invert(_ipv, bag.pv); bag.ipv = _ipv; }
      }
    }

    const vp = [0, this.height, this.width, -this.height];

    coreMapLocation(_v3, px, py, pz, fromStr, toStr, bag, vp, _ndcZ);

    return new p5.Vector(_v3[0], _v3[1], _v3[2]);
  };

  // ── mapDirection ──────────────────────────────────────────────────

  fn.mapDirection = function (...args) { return this._renderer.mapDirection(...args); };

  p5.Renderer3D.prototype.mapDirection = function (...args) {
    const { mainArg, options } = this._parseTransformArgs(p5.Tree._k, ...args);

    const dx = mainArg.x ?? mainArg[0] ?? 0;
    const dy = mainArg.y ?? mainArg[1] ?? 0;
    const dz = mainArg.z ?? mainArg[2] ?? 0;

    let from = options.from ?? p5.Tree.EYE;
    let to   = options.to   ?? p5.Tree.WORLD;

    if (from == p5.Tree.MODEL) from = this.mMatrix();
    if (to == p5.Tree.MODEL) to = this.mMatrix();

    const bag = {
      proj: options.pMatrix?.mat4 ?? _projMat4(this),
      view: options.vMatrix?.mat4 ?? _viewMat4(this),
      eye: null,
    };

    let fromStr, toStr;
    if (from instanceof p5.Matrix) {
      bag.fromFrame = from.mat4; fromStr = MATRIX;
    } else { fromStr = from; }
    if (to instanceof p5.Matrix) {
      mat4Invert(_inv2, to.mat4);
      bag.toFrameInv = _inv2; bag.toFrame = to.mat4; toStr = MATRIX;
    } else { toStr = to; }

    // Eye matrix needed for most direction paths
    if (options.eMatrix) { bag.eye = options.eMatrix.mat4; }
    else { mat4Invert(_inv, bag.view); bag.eye = new Float32Array(_inv); }

    const vp = [0, this.height, this.width, -this.height];

    coreMapDirection(_v3, dx, dy, dz, fromStr, toStr, bag, vp, _ndcZ);

    return new p5.Vector(_v3[0], _v3[1], _v3[2]);
  };

  // ── Utilities ────────────────────────────────────────────────────

  fn.pixelRatio = function (point) { return this._renderer.pixelRatio(point); };

  p5.Renderer3D.prototype.pixelRatio = function (point = p5.Tree.ORIGIN) {
    const proj = _projMat4(this);
    if (projIsOrtho(proj)) {
      return corePixelRatio(proj, this.height, 0, _ndcZ);
    }
    // Need eye-space Z of the point
    const px = point.x ?? point[0] ?? 0;
    const py = point.y ?? point[1] ?? 0;
    const pz = point.z ?? point[2] ?? 0;
    const view = _viewMat4(this);
    // Inline WORLD→EYE for just z component
    const eyeZ = view[2]*px + view[6]*py + view[10]*pz + view[14];
    return corePixelRatio(proj, this.height, eyeZ, _ndcZ);
  };

  fn.texOffset = function (image) { return [1 / image.width, 1 / image.height]; };

  fn.mousePosition = function (flip = true) {
    const pd = this.pixelDensity();
    return [pd * this.mouseX, pd * (flip ? this.height - this.mouseY : this.mouseY)];
  };

  fn.pointerPosition = function (...args) { return this._renderer.pointerPosition(...args); };
  fn.resolution = function () { return this._renderer.resolution(); };

  p5.Renderer3D.prototype.pointerPosition = function (...args) {
    let pointerX, pointerY, flip = true;
    for (const arg of args) {
      if (typeof arg === 'number') { pointerX === undefined ? (pointerX = arg) : (pointerY = arg); }
      else if (typeof arg === 'boolean') { flip = arg; }
    }
    const pd = this.pixelDensity();
    return [pd * pointerX, pd * (flip ? this.height - pointerY : pointerY)];
  };

  p5.Renderer3D.prototype.resolution = function () {
    const pd = this.pixelDensity();
    return [pd * this.width, pd * this.height];
  };
}
