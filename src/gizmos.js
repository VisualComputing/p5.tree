/**
 * @file Drawing axes, grids, frustums and paths.
 * @module p5.tree/gizmos
 * @license AGPL-3.0-only
 *
 * Helpers that draw the scaffolding of a 3D scene at the current drawing
 * position: `axes()` and `grid()` for a coordinate frame and a ground plane;
 * `cross()` and `bullsEye()` for canvas-space markers that keep their size as
 * the camera moves; `pane()` for a textured quad; `viewFrustum()` to show what
 * another camera sees; `hermite()` for a single curve segment; and
 * `trackPath()` to draw a `PoseTrack` or `CameraTrack` with its keyframes.
 *
 * Reach for them while building or debugging a scene, teaching camera
 * geometry, or showing an animation path.
 *
 * @details
 * - {@link axes} — coordinate frame (X/Y/Z, optional labels), semantic colouring
 * - {@link grid} — ground plane
 * - {@link cross} — canvas-space crosshair centred on the current model origin
 * - {@link bullsEye} — canvas-space bulls-eye centred on the current model origin
 * - {@link pane} — textured / untextured quad primitive (4 corners, optional UVs)
 * - {@link viewFrustum} — another camera's view frustum drawn in this renderer;
 *   NEAR and FAR planes optionally textured (e.g. the scene rendered from that
 *   camera) to visualise projection as a projection ONTO the frustum plane
 * - {@link hermite} — a single Hermite segment given endpoints and tangents
 * - {@link trackPath} — PoseTrack / CameraTrack path + control polygon +
 *   tangents + per-keyframe marker (pluggable via `marker`) + keyframe handle
 *   dots (HANDLES bit — draws `track.handles`, the track factories' `handles` opt)
 *
 * Depends on p5.tree/hud (beginHUD / endHUD), p5.tree/matrix (mapLocation,
 * pixelRatio, p5.Tree constants), and p5.tree/visibility (computePlanes).
 */

'use strict';

import {
  projIsOrtho, projNear, projFar,
  projLeft, projRight, projTop, projBottom,
  hermiteVec3,
  mat4Eye  as _mat4Eye,
  mat4Persp as _mat4Persp,
  mat4Ortho as _mat4Ortho,
} from '@nakednous/tree';

import { getNdcZ } from './matrix.js';

// ═══════════════════════════════════════════════════════════════════════════
// Module-level working buffers — never returned to caller
// ═══════════════════════════════════════════════════════════════════════════

const _sl    = new Float32Array(3);
const _wl    = new Float32Array(3);
const _eye   = new Float32Array(16);
const _proj  = new Float32Array(16);

// Scratch pose for viewFrustum's polymorphic camera dispatch — populated
// from a CameraTrack via track.eval(out), or normalised from a user-supplied
// pose spec, then consumed by _buildEyeFromPose / _buildProjFromPose.
const _vfPose = {
  eye:   [0,0,0], center: [0,0,0], up: [0,1,0],
  fov:   null,    halfHeight: null,
  near:  0.1,     far: 1000,
};

// trackPath sample buffers
const _sp    = new Float32Array(3);
const _prev  = new Float32Array(3);
const _tIn   = new Float32Array(3);
const _tOut  = new Float32Array(3);
const _kfEye = new Float32Array(16);

// Default UVs for pane() — frozen so the fallback path allocates nothing.
// Layout: p0 top-left, p1 top-right, p2 bottom-right, p3 bottom-left.
const _DEFAULT_UVS = Object.freeze([
  Object.freeze([0, 0]),
  Object.freeze([1, 0]),
  Object.freeze([1, 1]),
  Object.freeze([0, 1]),
]);

// V-flipped UVs for framebuffer color attachments — their rendered contents
// are stored bottom-up in texture space (WebGL convention), so sampling with
// the default top-down UVs produces an inverted image relative to image() and
// to geometry in the main view. Per p5's own framebuffer docs: "By default,
// a framebuffer's y-coordinates are flipped compared to images and videos."
const _FBO_UVS = Object.freeze([
  Object.freeze([0, 1]),
  Object.freeze([1, 1]),
  Object.freeze([1, 0]),
  Object.freeze([0, 0]),
]);

// ═══════════════════════════════════════════════════════════════════════════
// Local p5 state accessors
// ═══════════════════════════════════════════════════════════════════════════

const _rawMat4   = (m) => (m != null && m.mat4 != null) ? m.mat4 : m;
const _projMat4  = (r) => r.states.uPMatrix.mat4;
const _viewMat4  = (r) => r.states.curCamera.cameraMatrix.mat4;
const _modelMat4 = (r) => r.states.uModelMatrix.mat4;

const _AXIS_COLORS = ['Red', 'Lime', 'DodgerBlue'];

// ═══════════════════════════════════════════════════════════════════════════
// Polymorphic camera resolution for viewFrustum
// ═══════════════════════════════════════════════════════════════════════════
//
// `viewFrustum({ camera })` accepts three input shapes:
//
//   p5.Camera         — read pose + projection from the camera directly
//   CameraTrack       — sample track at the cursor (track.eval + track.mat4Eye)
//   pose spec object  — { eye, center?, up?, fov?, halfHeight?, near?, far? },
//                       same shape capturePose() and CameraTrack.add() use
//
// Detection is duck-typed on the public surface of each input — we test for
// the methods we'd actually call rather than instanceof, so the contract is
// "looks like X" rather than "is exactly X". Two consequences:
//
//   * a third-party object that implements .eval(poseOut) + .mat4Eye(out) +
//     keyframes[] will be detected as a CameraTrack and animate correctly
//   * a plain object literal with .eye is treated as a pose spec
//
// Order matters: track detection runs first because a track has an .eye
// keyframe in keyframes[0] which would otherwise satisfy the spec heuristic.

/**
 * @returns {boolean} true if `c` looks like a CameraTrack (cursor + lookat samplers).
 */
function _isCameraTrack(c) {
  return !!c
      && typeof c.eval === 'function'
      && typeof c.mat4Eye === 'function'
      && Array.isArray(c.keyframes);
}

/**
 * @returns {boolean} true if `c` looks like a p5.Camera (renderer-bound matrix readers).
 */
function _isP5Camera(c) {
  return !!c
      && typeof c.mat4Eye === 'function'
      && typeof c.mat4Proj === 'function'
      && !Array.isArray(c.keyframes);   // disambiguate from CameraTrack
}

/**
 * @returns {boolean} true if `c` is a plain pose spec (has .eye but no methods).
 */
function _isPoseSpec(c) {
  return !!c && Array.isArray(c.eye);
}

/**
 * Build the eye→world matrix from a pose spec via the lookAt constructor.
 * Defaults applied: center=[0,0,0], up=[0,1,0].
 * @param {Object} pose  { eye, center?, up? }
 * @param {Float32Array} out  16-element destination.
 */
function _buildEyeFromPose(pose, out) {
  const e = pose.eye;
  const c = pose.center || [0, 0, 0];
  const u = pose.up     || [0, 1, 0];
  return _mat4Eye(out, e[0], e[1], e[2], c[0], c[1], c[2], u[0], u[1], u[2]);
}

/**
 * Build the projection matrix from a pose spec's lens fields.
 * Aspect comes from the renderer (ambient state, parallel to textureMode).
 * Defaults applied: fov = π/3 if neither fov nor halfHeight, near = 0.1, far = 1000.
 * ndcYSign is hardcoded to -1 to match p5 v2's WEBGL Camera.perspective/ortho
 * convention (p[5] < 0). WEBGPU testing pending.
 * @param {Object} pose  { fov?, halfHeight?, near?, far? }
 * @param {number} aspect  width / height of the rendering surface.
 * @param {number} ndcZMin
 * @param {Float32Array} out  16-element destination.
 */
function _buildProjFromPose(pose, aspect, ndcZMin, out) {
  const near = pose.near ?? 0.1;
  const far  = pose.far  ?? 1000;
  if (typeof pose.halfHeight === 'number') {
    const top    = pose.halfHeight;
    const right  = top * aspect;
    return _mat4Ortho(out, -right, right, -top, top, near, far, ndcZMin, -1);
  }
  const fov   = (typeof pose.fov === 'number') ? pose.fov : Math.PI / 3;
  const top   = near * Math.tan(fov * 0.5);
  const right = top * aspect;
  return _mat4Persp(out, -right, right, -top, top, near, far, ndcZMin, -1);
}

// ═══════════════════════════════════════════════════════════════════════════
// Install
// ═══════════════════════════════════════════════════════════════════════════

export function installGizmos(p5, fn) {

  // ── Axes ──────────────────────────────────────────────────────────────────

  fn.axes = function (opts) { this._renderer.axes(opts); return this; };

  /**
   * Draw a 3D coordinate frame — the X, Y and Z axes with their labels — at the
   * current model origin. Choose the half-axes and labels with `bits`, the length
   * with `size`, and per-axis colours or the ambient stroke with `semantic` (see the
   * split-calls example). Needs a `p5.WEBGL` canvas.
   *
   * @details
   * Draw a 3D coordinate frame at the current model origin.
   *
   * Colouring: `semantic: true` (default) — X red, Y lime, Z blue, labels
   * inherit the axis colour; `semantic: false` — every axis and label uses the
   * ambient stroke. Bits: {@link X} {@link _X} {@link Y} {@link _Y} {@link Z}
   * {@link _Z} {@link LABELS}.
   *
   * @function axes
   * @memberof p5
   * @param {{ size?: number, semantic?: boolean, bits?: number }} [opts]
   * @param {number} [opts.size=100]  Axis length.
   * @param {boolean} [opts.semantic=true]  Semantic per-axis colours.
   * @param {number} [opts.bits=LABELS | X | Y | Z]  Which half-axes and labels to draw.
   * @returns {p5} this
   * @example
   * <caption>Default at the origin; a sized X | Y | -Z triad on an object</caption>
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   push()
   *   translate(60, -40, 20)
   *   rotateY(frameCount * 0.01)
   *   axes({ size: 40, bits: p5.Tree.X | p5.Tree.Y | p5.Tree._Z })
   *   stroke('#ff4fd8')
   *   noFill()
   *   box(20, 20, 30)
   *   pop()
   * }
   * @example
   * <caption>Split calls: one stroke per axis with semantic: false</caption>
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   const { X, _X, Y, _Y, Z, _Z } = p5.Tree
   *   stroke('white')
   *   axes({ bits: X | _X, semantic: false })
   *   stroke('#ff4fd8')
   *   axes({ bits: Y | _Y, semantic: false })
   *   stroke('#ffd166')
   *   axes({ bits: Z | _Z, semantic: false })
   * }
   */
  p5.Renderer3D.prototype.axes = function ({
    size     = 100,
    semantic = true,
    bits     = p5.Tree.LABELS | p5.Tree.X | p5.Tree.Y | p5.Tree.Z
  } = {}) {
    const p = this._pInst;
    if (!p) return;

    const setAxis = semantic ? (i) => p.stroke(_AXIS_COLORS[i]) : (_i) => {};

    p.push();
    if ((bits & p5.Tree.LABELS) !== 0) {
      const cw = size/40, ch = size/30, cs = 1.04*size;
      setAxis(0);
      p.line(cs,  cw, -ch, cs, -cw,  ch);
      p.line(cs, -cw, -ch, cs,  cw,  ch);
      setAxis(1);
      p.line( cw, cs,  ch,  0, cs,   0);
      p.line(  0, cs,   0, -cw, cs,  ch);
      p.line(-cw, cs,  ch,  0, cs,   0);
      p.line(  0, cs,   0,  0, cs, -ch);
      setAxis(2);
      p.line(-cw, -ch, cs,  cw, -ch, cs);
      p.line( cw, -ch, cs, -cw,  ch, cs);
      p.line(-cw,  ch, cs,  cw,  ch, cs);
    }
    setAxis(0);
    (bits & p5.Tree.X)  !== 0 && p.line(0,0,0,  size,0,0);
    (bits & p5.Tree._X) !== 0 && p.line(0,0,0, -size,0,0);
    setAxis(1);
    (bits & p5.Tree.Y)  !== 0 && p.line(0,0,0, 0, size,0);
    (bits & p5.Tree._Y) !== 0 && p.line(0,0,0, 0,-size,0);
    setAxis(2);
    (bits & p5.Tree.Z)  !== 0 && p.line(0,0,0, 0,0, size);
    (bits & p5.Tree._Z) !== 0 && p.line(0,0,0, 0,0,-size);
    p.pop();
  };

  // ── Grid ──────────────────────────────────────────────────────────────────

  fn.grid = function (opts) { this._renderer.grid(opts); return this; };

  /**
   * Draw a grid in the XY plane at the current model origin: `subdivisions`
   * cells per side spanning ±`size`, at the ambient stroke.
   *
   * @function grid
   * @memberof p5
   * @param {{ size?: number, subdivisions?: number }} [opts]
   * @param {number} [opts.size=100]  Half-extent.
   * @param {number} [opts.subdivisions=10]  Cells per side.
   * @returns {p5} this
   * @example
   * <caption>A ground plane: the grid lives in XY, so tilt it flat</caption>
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   stroke('white')
   *   push()
   *   rotateX(HALF_PI)
   *   grid({ size: 200, subdivisions: 20 })
   *   pop()
   *   noStroke()
   *   fill('#ff4fd8')
   *   push()
   *   translate(0, -30, 0)
   *   box(60)
   *   pop()
   * }
   */
  p5.Renderer3D.prototype.grid = function ({ size = 100, subdivisions = 10 } = {}) {
    const p = this._pInst;
    if (!p) return;
    subdivisions = Math.max(1, subdivisions);
    p.push();
    for (let i = 0; i <= subdivisions; ++i) {
      const pos = size * (2*i/subdivisions - 1);
      p.line(pos, -size, 0, pos, +size, 0);
      p.line(-size, pos, 0, +size, pos, 0);
    }
    p.pop();
  };

  // ── Circle primitive ──────────────────────────────────────────────────────

  p5.Renderer3D.prototype._circle = function ({
    filled = false, x = this.width/2, y = this.height/2, radius = 100, detail = 50
  } = {}) {
    const p = this._pInst;
    if (!p) return;
    p.push(); p.translate(x, y);
    if (filled) {
      p.beginShape(p.TRIANGLE_STRIP);
      for (let t = 0; t <= detail; t++) {
        const cx = Math.cos(t*(2*Math.PI)/detail), cy = Math.sin(t*(2*Math.PI)/detail);
        p.vertex(0, 0, 0, 0.5, 0.5);
        p.vertex(radius*cx, radius*cy, 0, cx*0.5+0.5, cy*0.5+0.5);
      }
      p.endShape();
    } else {
      const angle = (2*Math.PI)/detail;
      let lx = radius, ly = 0;
      for (let i = 1; i <= detail; i++) {
        const nx = Math.cos(i*angle)*radius, ny = Math.sin(i*angle)*radius;
        p.line(lx, ly, nx, ny); lx = nx; ly = ny;
      }
    }
    p.pop();
  };

  // ── Cross ─────────────────────────────────────────────────────────────────

  fn.cross = function (opts) { this._renderer.cross(opts); return this; };

  /**
   * Draw a canvas-space crosshair centred on the current model origin, or at
   * explicit screen coordinates `x`, `y`. Set its extent with `size` — world units at
   * the origin's depth, or pixels when screen coordinates are given (see both
   * examples). Needs a `p5.WEBGL` canvas.
   *
   * @details
   * Draw a canvas-space crosshair centred on the current model origin, or at
   * explicit screen coordinates. Drawn in HUD space at the ambient stroke.
   * Centred on the model origin, `size` is in world units at that depth
   * (the cross shrinks with distance); with `x`, `y` given, `size` is pixels.
   * The matrix opts resolve against a supplied camera instead of live state.
   *
   * @function cross
   * @memberof p5
   * @param {{
   *   x?: number, y?: number, size?: number,
   *   mat4Model?: Float32Array | ArrayLike | p5.Matrix,
   *   mat4Eye?:   Float32Array | ArrayLike | p5.Matrix,
   *   mat4Proj?:  Float32Array | ArrayLike | p5.Matrix,
   *   mat4View?:  Float32Array | ArrayLike | p5.Matrix,
   *   mat4PV?:    Float32Array | ArrayLike | p5.Matrix,
   * }} [opts]
   * @param {number} [opts.size=50]
   * @returns {p5} this
   * @example
   * <caption>Centred on the model origin: size in world units at that depth</caption>
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   push()
   *   translate(100 * cos(frameCount * 0.02), 0, 100 * sin(frameCount * 0.02))
   *   noStroke()
   *   fill('white')
   *   sphere(10)
   *   stroke('#ff4fd8')
   *   cross({ size: 40 })
   *   pop()
   * }
   * @example
   * <caption>Explicit screen coordinates: size in pixels</caption>
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   stroke('white')
   *   noFill()
   *   box(60)
   *   stroke('#ff4fd8')
   *   cross({ x: mouseX, y: mouseY, size: 24 })
   * }
   */
  p5.Renderer3D.prototype.cross = function ({
    mat4Model, x, y, size = 50, mat4Eye, mat4Proj, mat4View, mat4PV
  } = {}) {
    const p = this._pInst;
    if (!p) return;
    const mm = _rawMat4(mat4Model) ?? _modelMat4(this);
    if (x == null || y == null) {
      this.mapLocation(p5.Tree.ORIGIN, { from: mm, to: p5.Tree.SCREEN, out: _sl, mat4Proj, mat4View, mat4PV });
      x = _sl[0]; y = _sl[1];
      this.mapLocation(p5.Tree.ORIGIN, { from: mm, to: p5.Tree.WORLD, out: _wl, mat4Eye });
      size = size / this.pixelRatio(_wl);
    }
    const half = size / 2;
    this.beginHUD();
    p.line(x-half, y, x+half, y);
    p.line(x, y-half, x, y+half);
    this.endHUD();
  };

  // ── BullsEye ──────────────────────────────────────────────────────────────

  fn.bullsEye = function (opts) { this._renderer.bullsEye(opts); return this; };

  /**
   * Draw a canvas-space bulls-eye — a circle or a cornered square plus a central
   * cross — centred on the current model origin, or at explicit screen
   * coordinates `x`, `y`. Pick the outline with `shape` (`CIRCLE` or `SQUARE`) and its
   * extent with `size`: world units at the origin's depth, or pixels when screen
   * coordinates are given (see both examples). Needs a `p5.WEBGL` canvas.
   *
   * @details
   * Draw a canvas-space bulls-eye — a circle or a cornered square plus a
   * central cross — centred on the current model origin, or at explicit screen
   * coordinates. Drawn in HUD space at the ambient stroke. Centred on the model
   * origin, `size` is in world units at that depth; with `x`, `y` given, `size`
   * is pixels. The matrix opts resolve against a supplied camera instead of
   * live state.
   *
   * @function bullsEye
   * @memberof p5
   * @param {{
   *   x?: number, y?: number, size?: number, shape?: number,
   *   mat4Model?: Float32Array | ArrayLike | p5.Matrix,
   *   mat4Eye?:   Float32Array | ArrayLike | p5.Matrix,
   *   mat4Proj?:  Float32Array | ArrayLike | p5.Matrix,
   *   mat4View?:  Float32Array | ArrayLike | p5.Matrix,
   *   mat4PV?:    Float32Array | ArrayLike | p5.Matrix,
   * }} [opts]
   * @param {number} [opts.size=50]
   * @param {number} [opts.shape=CIRCLE]  {@link CIRCLE} or {@link SQUARE}.
   * @returns {p5} this
   * @example
   * <caption>Centred on two model origins: CIRCLE and SQUARE</caption>
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   const t = frameCount * 0.02
   *   noStroke()
   *   fill('white')
   *   push()
   *   translate(100 * cos(t), 0, 100 * sin(t))
   *   sphere(10)
   *   stroke('#ff4fd8')
   *   bullsEye({ size: 50 })
   *   pop()
   *   push()
   *   translate(-100 * cos(t), 0, -100 * sin(t))
   *   sphere(10)
   *   stroke('#ffd166')
   *   bullsEye({ size: 50, shape: p5.Tree.SQUARE })
   *   pop()
   * }
   * @example
   * <caption>Explicit screen coordinates: size in pixels</caption>
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   stroke('white')
   *   noFill()
   *   box(60)
   *   stroke('#ff4fd8')
   *   bullsEye({ x: mouseX, y: mouseY, size: 40 })
   * }
   */
  p5.Renderer3D.prototype.bullsEye = function ({
    mat4Model, x, y, size = 50, shape = p5.Tree.CIRCLE,
    mat4Eye, mat4Proj, mat4View, mat4PV
  } = {}) {
    const p = this._pInst;
    if (!p) return;
    const mm = _rawMat4(mat4Model) ?? _modelMat4(this);
    if (x == null || y == null) {
      this.mapLocation(p5.Tree.ORIGIN, { from: mm, to: p5.Tree.SCREEN, out: _sl, mat4Proj, mat4View, mat4PV });
      x = _sl[0]; y = _sl[1];
      this.mapLocation(p5.Tree.ORIGIN, { from: mm, to: p5.Tree.WORLD, out: _wl, mat4Eye });
      size = size / this.pixelRatio(_wl);
    }
    const half = size/2, corner = 0.6*half;
    this.beginHUD();
    if (shape === p5.Tree.CIRCLE) {
      this._circle({ x, y, radius: half });
    } else {
      p.line(x-half, y-half+corner, x-half, y-half);
      p.line(x-half, y-half, x-half+corner, y-half);
      p.line(x+half-corner, y-half, x+half, y-half);
      p.line(x+half, y-half, x+half, y-half+corner);
      p.line(x+half, y+half-corner, x+half, y+half);
      p.line(x+half, y+half, x+half-corner, y+half);
      p.line(x-half+corner, y+half, x-half, y+half);
      p.line(x-half, y+half, x-half, y+half-corner);
    }
    const ch = 0.6*half;
    p.line(x-ch, y, x+ch, y);
    p.line(x, y-ch, x, y+ch);
    this.endHUD();
  };

  // ── pane — atomic textured quad primitive ─────────────────────────────────
  //
  // "pane" as in window pane — a bounded flat quad, optionally textured.
  // Distinct from p5's native `plane(w, h)` (axis-aligned at origin) by
  // name AND signature: `pane` takes four 3D corner points. Used
  // internally by `viewFrustum` for NEAR / FAR / BODY quads and by the
  // default `CameraTrack` marker for the per-keyframe near plane.

  fn.pane = function (p0, p1, p2, p3, opts) {
    this._renderer.pane(p0, p1, p2, p3, opts);
    return this;
  };

  /**
   * Draw a quad from four 3D corner points, filled with the ambient fill or
   * textured with `texture` — an image, a graphics buffer, or a framebuffer's
   * colour attachment (see the three examples). Custom texture coordinates go in
   * `uvs`. Needs a `p5.WEBGL` canvas.
   *
   * @details
   * Draw a textured or untextured quad from four 3D corner points.
   *
   * Corners are consumed in the order given — counter-clockwise when
   * viewed from the intended front face yields outward-facing normals.
   * Default UVs place the texture origin at p0 and (1,1) at p2:
   *
   *     p0 ──── p1        uv (0,0) ──── (1,0)
   *      │       │                │         │
   *      │       │                │         │
   *     p3 ──── p2        uv (0,1) ──── (1,1)
   *
   * `texture` accepts anything p5's `texture()` accepts — `p5.Framebuffer`,
   * `p5.Image`, `p5.Graphics`, `p5.Texture`. push/pop isolates the
   * texture state so it doesn't leak into subsequent draws. `uvs`
   * overrides the default layout — supply four [u,v] pairs in p0..p3
   * order.
   *
   *     pane([-100,-100,0], [100,-100,0], [100,100,0], [-100,100,0])
   *     pane(tl, tr, br, bl, { texture: myFbo })
   *     pane(tl, tr, br, bl, { texture: myImg, uvs: [[0,1],[1,1],[1,0],[0,0]] })
   *
   * @function pane
   * @memberof p5
   * @param {number[]} p0  Corner position (CCW when viewed from the front).
   * @param {number[]} p1  Corner position.
   * @param {number[]} p2  Corner position.
   * @param {number[]} p3  Corner position.
   * @param {{ texture?:*, uvs?:number[][] }} [opts]
   * @returns {p5} this
   * @example
   * <caption>Untextured: the ambient fill and stroke</caption>
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   push()
   *   rotateY(frameCount * 0.01)
   *   stroke('white')
   *   fill('#ff4fd8')
   *   pane([-80, -60, -40], [80, -60, -40], [80, 60, -40], [-80, 60, -40])
   *   pop()
   * }
   * @example
   * <caption>A p5.Graphics texture, drawn procedurally</caption>
   * let g
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   g = createGraphics(128, 128)
   *   g.background('white')
   *   g.noStroke()
   *   g.fill('#ff4fd8')
   *   g.circle(64, 64, 90)
   *   g.fill('#ffd166')
   *   g.triangle(64, 30, 94, 84, 34, 84)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   push()
   *   rotateY(frameCount * 0.01)
   *   noStroke()
   *   pane([-80, -60, -40], [80, -60, -40], [80, 60, -40], [-80, 60, -40], { texture: g })
   *   pop()
   * }
   * @example
   * <caption>A framebuffer's colour attachment: V-flipped by default, so it reads right-side-up</caption>
   * let fbo
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   fbo = createFramebuffer({ width: 160, height: 120 })
   * }
   *
   * function draw() {
   *   fbo.begin()
   *   background('#ffd166')
   *   rotateY(frameCount * 0.02)
   *   stroke('white')
   *   fill('#ff4fd8')
   *   box(40)
   *   fbo.end()
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   noStroke()
   *   pane([-80, -60, -40], [80, -60, -40], [80, 60, -40], [-80, 60, -40], { texture: fbo.color })
   * }
   */
  p5.Renderer3D.prototype.pane = function (p0, p1, p2, p3, { texture = null, uvs = null } = {}) {
    const p = this._pInst;
    if (!p) return;
    // Default UV selection:
    //   - Explicit `uvs` — always wins (user knows what they want).
    //   - p5.FramebufferTexture (fbo.color) — V-flipped to match image() /
    //     geometry orientation. p5 stores FBO color textures bottom-up;
    //     sampling with top-down UVs produces an inverted image.
    //   - Everything else — top-down UVs.
    const u = uvs
      || (texture instanceof p5.FramebufferTexture ? _FBO_UVS : _DEFAULT_UVS);
    // p5's default textureMode is IMAGE (UVs in pixel space). Our default
    // and FBO UVs are normalized 0..1, so we switch to NORMAL while drawing.
    // Save/restore explicitly: per p5 v2's push() docs, textureMode is NOT
    // in the list of state that push/pop saves (rectMode and ellipseMode
    // are, but textureMode is not). Without this dance the NORMAL mode
    // leaks to subsequent draws — a following image() call interprets its
    // IMAGE-mode UVs against the lingering NORMAL setting and crashes
    // inside _setFillUniforms.
    const prevMode = this.states.textureMode;
    p.push();
    if (texture) {
      p.textureMode(p.NORMAL);
      p.texture(texture);
    }
    this.beginShape();
    this.vertex(p0[0], p0[1], p0[2], u[0][0], u[0][1]);
    this.vertex(p1[0], p1[1], p1[2], u[1][0], u[1][1]);
    this.vertex(p2[0], p2[1], p2[2], u[2][0], u[2][1]);
    this.vertex(p3[0], p3[1], p3[2], u[3][0], u[3][1]);
    this.endShape(p.CLOSE);
    p.pop();
    this.states.textureMode = prevMode;
  };

  // ── View frustum ──────────────────────────────────────────────────────────

  fn.viewFrustum = function (opts) { this._renderer.viewFrustum(opts); return this; };

  /**
   * Draw a second camera's frustum in the scene: its near and far planes, the
   * body, and optionally the apex lines, selected with `bits`. The camera can be
   * a `p5.Camera`, a `CameraTrack` that follows playback, or a plain pose spec (see
   * the pose-specs example), and textures can be mapped on the near and far
   * planes (see the textured example). Needs a `p5.WEBGL` canvas and a second camera
   * or pose.
   *
   * @details
   * Draw the view frustum of a secondary camera into this renderer.
   *
   * `camera` accepts three forms:
   *
   * - `p5.Camera` — eye and projection read via `cam.mat4Eye` / `cam.mat4Proj`.
   * - `CameraTrack` — sampled at the cursor via `track.eval` + `track.mat4Eye`;
   *   the frustum animates with the track's playback.
   * - pose spec `{ eye, center?, up?, fov?, halfHeight?, near?, far? }` — the
   *   shape `capturePose()` returns and `CameraTrack.add()` accepts. Defaults:
   *   `center=[0,0,0]`, `up=[0,1,0]`, `near=0.1`, `far=1000`, `fov=π/3` if
   *   neither `fov` nor `halfHeight` is set.
   *
   * Alternatively pass explicit `mat4Eye` + `mat4Proj` buffers. `mat4View`
   * defaults to the current renderer's view — override when drawing from a
   * third viewpoint.
   *
   * `bits` selects which parts render:
   *
   * - {@link NEAR} — the near plane (a closed quad; textured when `nearTexture` is set).
   * - {@link FAR} — the far plane (a closed quad; textured when `farTexture` is set).
   * - {@link BODY} — the four edges joining near corners to far corners.
   * - {@link APEX} — perspective only: four lines from the camera origin to the
   *   near corners. Ignored for orthographic projections.
   *
   * `viewer` is a callback invoked AFTER the view/eye matrices have been
   * installed — use it to draw anything that belongs in the secondary
   * camera's space (triad, HUD, grid, etc). Default: a three-axis triad
   * `X | Y | _Z` (right, up, forward) at the apex.
   *
   * `nearTexture` / `farTexture` map a texture onto the corresponding plane
   * via the `pane()` helper. Typical use: the scene as rendered from the
   * secondary camera, mapped onto its own near plane to show "what the
   * camera sees" as a projection ONTO the projection surface. Supply
   * `myFbo.color` for a framebuffer's rendered contents.
   * The image reads upright whichever camera rendered the framebuffer: a
   * canvas camera made active inside it (`setCamera(cam)` and `resetMatrix()`
   * after `fbo.begin()`), or one of the framebuffer's own
   * (`fbo.createCamera()`), which p5 renders with y inverted — `viewFrustum`
   * tells them apart when `camera` is that `p5.Camera`. With a `CameraTrack`
   * or a pose spec it assumes the first.
   *
   * Draw order: `viewer` → untextured FAR outline → BODY → untextured NEAR
   * outline → textured FAR → textured NEAR. Textured planes are drawn last
   * so alpha can reveal the frustum interior through them; NEAR after FAR
   * because NEAR sits in front of the external viewer in the typical
   * "look at the camera from outside" configuration.
   *
   * @function viewFrustum
   * @memberof p5
   * @param {{
   *   camera?:      p5.Camera | CameraTrack | { eye:number[], center?:number[], up?:number[], fov?:number, halfHeight?:number, near?:number, far?:number },
   *   mat4Eye?:     Float32Array | ArrayLike | p5.Matrix,
   *   mat4Proj?:    Float32Array | ArrayLike | p5.Matrix,
   *   mat4View?:    Float32Array | ArrayLike | p5.Matrix,
   *   bits?:        number,
   *   viewer?:      Function,
   *   nearTexture?: p5.Image | p5.Graphics | p5.Texture,
   *   farTexture?:  p5.Image | p5.Graphics | p5.Texture,
   * }} [opts]
   * @param {number} [opts.bits=NEAR | FAR | BODY]
   * @returns {p5} this
   * @example
   * <caption>A second camera's frustum</caption>
   * let cam
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   camera(300, -200, 500, 0, 0, 0, 0, 1, 0)
   *   cam = createCamera()
   *   cam.perspective(PI / 4, width / height, 50, 350)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   const t = frameCount * 0.01
   *   cam.camera(250 * sin(t), -80, 250 * cos(t), 0, 0, 0, 0, 1, 0)
   *   axes()
   *   stroke('white')
   *   noFill()
   *   box(60)
   *   stroke('#ffd166')
   *   viewFrustum({ camera: cam })
   * }
   * @example
   * <caption>Pose specs: a perspective (fov) and an orthographic (halfHeight) one-off</caption>
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   camera(300, -200, 500, 0, 0, 0, 0, 1, 0)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   stroke('white')
   *   noFill()
   *   box(60)
   *   stroke('#ffd166')
   *   viewFrustum({ camera: { eye: [200, -100, 200], fov: PI / 5, near: 60, far: 320 } })
   *   stroke('#ff4fd8')
   *   viewFrustum({ camera: { eye: [-200, -100, 200], halfHeight: 50, near: 60, far: 320 } })
   * }
   * @example
   * <caption>bits: the cone without its near outline; viewer: your own marker at the eye</caption>
   * let cam
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   camera(300, -200, 500, 0, 0, 0, 0, 1, 0)
   *   cam = createCamera()
   *   cam.perspective(PI / 4, width / height, 50, 350)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   const t = frameCount * 0.01
   *   cam.camera(250 * sin(t), -80, 250 * cos(t), 0, 0, 0, 0, 1, 0)
   *   axes()
   *   stroke('white')
   *   noFill()
   *   box(60)
   *   stroke('#ffd166')
   *   viewFrustum({
   *     camera: cam,
   *     bits: p5.Tree.FAR | p5.Tree.BODY | p5.Tree.APEX,
   *     viewer: () => {
   *       noStroke()
   *       fill('#ff4fd8')
   *       sphere(8)
   *     }
   *   })
   * }
   * @example
   * <caption>The near plane textured with what the camera sees</caption>
   * let cam, fbo
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   camera(300, -200, 500, 0, 0, 0, 0, 1, 0)
   *   cam = createCamera()
   *   cam.perspective(PI / 4, width / height, 60, 350)
   *   fbo = createFramebuffer({ width: 200, height: 150 })
   * }
   *
   * function draw() {
   *   const t = frameCount * 0.01
   *   cam.camera(250 * sin(t), -80, 250 * cos(t), 0, 0, 0, 0, 1, 0)
   *   // what cam sees: setCamera and resetMatrix are both needed inside the scope
   *   fbo.begin()
   *   setCamera(cam)
   *   resetMatrix()
   *   background('#138D75')
   *   scene()
   *   fbo.end()
   *   background('#138D75')
   *   orbitControl()
   *   scene()
   *   stroke('#ffd166')
   *   tint(255, 200)
   *   viewFrustum({ camera: cam, nearTexture: fbo.color })
   *   noTint()
   * }
   *
   * function scene() {
   *   axes()
   *   stroke('white')
   *   fill('#ff4fd8')
   *   box(60)
   * }
   * @example
   * <caption>A CameraTrack: the frustum follows playback</caption>
   * let cam, track
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   camera(300, -200, 500, 0, 0, 0, 0, 1, 0)
   *   cam = createCamera()
   *   track = createCameraTrack(cam)
   *   track.add({ eye: [250, -80, 0], center: [0, 0, 0], fov: PI / 4, near: 40, far: 300 })
   *   track.add({ eye: [0, -150, 250], center: [0, 0, 0], fov: PI / 4, near: 40, far: 300 })
   *   track.add({ eye: [-250, -80, 0], center: [0, 0, 0], fov: PI / 4, near: 40, far: 300 })
   *   track.play({ loop: true, bounce: true, duration: 90 })
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   stroke('white')
   *   noFill()
   *   box(60)
   *   trackPath(track, { marker: null })
   *   stroke('#ffd166')
   *   viewFrustum({ camera: track })
   * }
   */
  p5.Renderer3D.prototype.viewFrustum = function ({
    camera, mat4Eye, mat4Proj, mat4View,
    bits   = p5.Tree.NEAR | p5.Tree.FAR | p5.Tree.BODY,
    viewer = () => this.axes({
      size: 50,
      bits: p5.Tree.X | p5.Tree.Y | p5.Tree._Z
    }),
    nearTexture = null,
    farTexture  = null,
  } = {}) {
    const p = this._pInst;
    if (!p) return;

    // ── Camera dispatch ───────────────────────────────────────────────
    // Three forms: p5.Camera, CameraTrack, or plain pose spec.
    // For tracks and pose specs we need to BUILD eye + proj matrices
    // because the renderer-bound camera methods aren't available.
    let eRaw = _rawMat4(mat4Eye);
    let pRaw = _rawMat4(mat4Proj);
    if (camera) {
      if (_isCameraTrack(camera)) {
        camera.eval(_vfPose);                 // fill _vfPose at cursor
        camera.mat4Eye(_eye);                 // cursor-form eye matrix
        eRaw = eRaw ?? _eye;
        if (!pRaw) {
          const aspect = (this.width && this.height) ? (this.width / this.height) : 1;
          _buildProjFromPose(_vfPose, aspect, getNdcZ(), _proj);
          pRaw = _proj;
        }
      } else if (_isP5Camera(camera)) {
        if (!eRaw) { camera.mat4Eye(_eye);   eRaw = _eye; }
        if (!pRaw) { camera.mat4Proj(_proj); pRaw = _proj; }
      } else if (_isPoseSpec(camera)) {
        if (!eRaw) { _buildEyeFromPose(camera, _eye); eRaw = _eye; }
        if (!pRaw) {
          const aspect = (this.width && this.height) ? (this.width / this.height) : 1;
          _buildProjFromPose(camera, aspect, getNdcZ(), _proj);
          pRaw = _proj;
        }
      }
    }

    if (!pRaw || !eRaw) {
      console.error('viewFrustum requires either a camera (p5.Camera, CameraTrack, or pose spec) or both mat4Eye and mat4Proj'); return;
    }

    const states = this.states, uView = states?.uViewMatrix;
    if (!uView) return;

    const vRaw    = _rawMat4(mat4View) ?? _viewMat4(this);
    const isOrtho = projIsOrtho(pRaw);
    const ndcZ    = getNdcZ();
    const apex    = !isOrtho && ((bits & p5.Tree.APEX) !== 0);
    const n = -projNear(pRaw, ndcZ), f = -projFar(pRaw);
    const l =  projLeft(pRaw, ndcZ),  r = projRight(pRaw, ndcZ);
    const t =  projTop(pRaw, ndcZ),   b = projBottom(pRaw, ndcZ);
    const ratio = isOrtho ? 1 : f/n;
    const _l=ratio*l, _r=ratio*r, _b=ratio*b, _t=ratio*t;

    // Corners by where they sit on screen. The projection reads answer t > 0 > b in eye
    // space whatever the projection's y sign, and p5's eye space has y running down the
    // screen, so the visually top edge is y = b. Lines do not care; a textured pane does.
    // Far-plane corners (at z = f, negative)
    const fTL = [_l, _b, f], fTR = [_r, _b, f], fBR = [_r, _t, f], fBL = [_l, _t, f];
    // Near-plane corners (at z = n, negative)
    const nTL = [ l,  b, n], nTR = [ r,  b, n], nBR = [ r,  t, n], nBL = [ l,  t, n];

    p.push(); p.resetMatrix();
    const prevView = uView.copy();
    uView.set(vRaw);
    this.applyMatrix(
      eRaw[0],  eRaw[1],  eRaw[2],  eRaw[3],
      eRaw[4],  eRaw[5],  eRaw[6],  eRaw[7],
      eRaw[8],  eRaw[9],  eRaw[10], eRaw[11],
      eRaw[12], eRaw[13], eRaw[14], eRaw[15]
    );

    // ── Viewer — opaque scene-in-eye-space callback ──────────────────────
    typeof viewer === 'function' && viewer();

    // Bit handling is orthogonal: each bit owns exactly its own edges.
    // The 12 edges of a frustum partition cleanly across the bits:
    //   NEAR  — 4 edges of the near rectangle (or filled/textured face)
    //   FAR   — 4 edges of the far rectangle  (or filled/textured face)
    //   BODY  — 4 connecting edges (near corner → far corner)
    //   APEX  — 4 lines (origin → near corner) — perspective only
    // Disabled bits draw nothing. Closure is the user's responsibility:
    // `bits: NEAR | FAR | BODY` produces a full closed wireframe.

    // ── FAR — outlined here if untextured; textured pass at the end ──────
    if ((bits & p5.Tree.FAR) !== 0 && !farTexture) {
      this.pane(fTL, fTR, fBR, fBL);
    }

    // ── BODY — four connecting edges (near corners → far corners) ────────
    // Outline only; never fills the side walls. Users wanting filled walls
    // (e.g. for a translucent slab effect) can call pane() in user space.
    if ((bits & p5.Tree.BODY) !== 0) {
      p.line(nTL[0],nTL[1],nTL[2], fTL[0],fTL[1],fTL[2]);
      p.line(nTR[0],nTR[1],nTR[2], fTR[0],fTR[1],fTR[2]);
      p.line(nBR[0],nBR[1],nBR[2], fBR[0],fBR[1],fBR[2]);
      p.line(nBL[0],nBL[1],nBL[2], fBL[0],fBL[1],fBL[2]);
    }

    // ── APEX — converging lines from origin to near corners ──────────────
    // Drawn regardless of BODY: APEX is a stand-alone visual cue for the
    // "perspective cone" interpretation of the frustum.
    if (apex) {
      p.line(0,0,0, nTR[0], nTR[1], nTR[2]);
      p.line(0,0,0, nTL[0], nTL[1], nTL[2]);
      p.line(0,0,0, nBL[0], nBL[1], nBL[2]);
      p.line(0,0,0, nBR[0], nBR[1], nBR[2]);
    }

    // ── NEAR — outlined here if untextured; textured pass at the end ─────
    if ((bits & p5.Tree.NEAR) !== 0 && !nearTexture) {
      this.pane(nTL, nTR, nBR, nBL);
    }

    // ── Textured planes — drawn LAST for correct alpha compositing ───────
    // Far before near: in the typical "external viewer in front of camera"
    // configuration, far sits behind near.
    // A framebuffer holds its image one way up when a canvas camera rendered it (setCamera
    // inside fbo.begin(), what pane's framebuffer uvs assume) and the other way up when one of
    // its own cameras did (fbo.createCamera(), whose projection p5 inverts in y): then the
    // plain uvs are the upright ones.
    const fboCamUvs = (_isP5Camera(camera) && camera.yScale < 0) ? _DEFAULT_UVS : null;
    if ((bits & p5.Tree.FAR) !== 0 && farTexture) {
      this.pane(fTL, fTR, fBR, fBL, { texture: farTexture, uvs: fboCamUvs });
    }
    if ((bits & p5.Tree.NEAR) !== 0 && nearTexture) {
      this.pane(nTL, nTR, nBR, nBL, { texture: nearTexture, uvs: fboCamUvs });
    }

    uView.set(prevView);
    p.pop();
  };

  // ── Hermite — atomic spline primitive ─────────────────────────────────────

  fn.hermite = function (p0, m0, p1, m1, opts) {
    this._renderer.hermite(p0, m0, p1, m1, opts);
    return this;
  };

  /**
   * Draw one cubic Hermite curve segment between two endpoints with explicit
   * tangents, as a polyline of `samples` segments at the ambient stroke. Needs a
   * `p5.WEBGL` canvas.
   *
   * @details
   * Draw one cubic Hermite segment between two endpoints with explicit tangents.
   *
   * ```js
   * hermite([0,0,0], [100,0,0], [200,0,0], [0,100,0])
   * hermite(p0, m0, p1, m1, { samples: 64 })
   * ```
   *
   * @function hermite
   * @memberof p5
   * @param {number[]} p0  Segment start — [x,y,z].
   * @param {number[]} m0  Outgoing tangent at p0.
   * @param {number[]} p1  Segment end — [x,y,z].
   * @param {number[]} m1  Incoming tangent at p1.
   * @param {{ samples?: number }} [opts]
   * @param {number} [opts.samples=32]  Line segments along the curve.
   * @returns {p5} this
   * @example
   * <caption>One segment; the outgoing and incoming tangents drawn as spokes</caption>
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   const p0 = [-120, 0, 0], p1 = [120, 0, 0]
   *   const m0 = [0, -200 * sin(frameCount * 0.02), 200 * cos(frameCount * 0.02)]
   *   const m1 = [0, -200, 0]
   *   stroke('white')
   *   hermite(p0, m0, p1, m1)
   *   stroke('#ff4fd8')
   *   line(p0[0], p0[1], p0[2], p0[0] + m0[0], p0[1] + m0[1], p0[2] + m0[2])
   *   stroke('#ffd166')
   *   line(p1[0] - m1[0], p1[1] - m1[1], p1[2] - m1[2], p1[0], p1[1], p1[2])
   * }
   */
  p5.Renderer3D.prototype.hermite = function (p0, m0, p1, m1, { samples = 32 } = {}) {
    const p = this._pInst;
    if (!p) return;
    const N = Math.max(2, samples | 0);
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      hermiteVec3(_sp, p0, m0, p1, m1, t);
      if (i > 0) p.line(_prev[0], _prev[1], _prev[2], _sp[0], _sp[1], _sp[2]);
      _prev[0] = _sp[0]; _prev[1] = _sp[1]; _prev[2] = _sp[2];
    }
  };

  // ── trackPath ─────────────────────────────────────────────────────────────

  fn.trackPath = function (track, opts) {
    this._renderer.trackPath(track, opts);
    return this;
  };

  /**
   * Visualise a `PoseTrack` or `CameraTrack` in the scene: the sampled path, its
   * control polygon, tangent arrows, a marker at each keyframe, and for camera
   * tracks the gaze rays from eye to center. Select the layers with `bits`, the
   * eye or center path with `target`, and the per-keyframe drawing with `marker` or
   * your own callback (see the custom-marker and `HANDLES` examples). Needs a `p5.WEBGL`
   * canvas and a track.
   *
   * @details
   * Visualise a PoseTrack or CameraTrack: sampled path polyline, control
   * polygon, tangent arrows, per-keyframe marker, and (CameraTrack only)
   * gaze rays from each eye keyframe to its center.
   *
   * Bits:
   *
   * - {@link PATH} — sampled polyline along the target path.
   * - {@link CONTROLS} — straight control polygon along the target path.
   * - {@link TANGENTS_IN} / {@link TANGENTS_OUT} — incoming / outgoing tangent
   *   arrow at each keyframe; {@link TANGENTS} is both.
   * - {@link CENTER} — CameraTrack only. Gaze line from each `kf.eye` to
   *   `kf.center`, with a `point()` at `kf.center`. Target-independent — always
   *   the eye→center relationship regardless of `target`. The default marker
   *   does not draw this line, so CENTER is the gaze layer, in its own ambient
   *   `stroke()`.
   * - {@link HANDLES} — keyframe manipulator dots when the track was created
   *   with the `handles` factory opt (`track.handles`): a constant-px dot per
   *   draggable field (pos / eye / center), the ring + spoke of a PoseTrack rot
   *   DIAL, hover / grab emphasis by size (×1.4). Ambient `fill()` colours the
   *   dots, ambient `stroke()` the ring / spoke. A no-op when `track.handles`
   *   is absent or disabled. Drawing is the visual half only — picking is
   *   host-driven via `track.handles.update()`; see {@link createPoseTrack} /
   *   {@link createCameraTrack}.
   *
   * `target` — `'eye'` (default) or `'center'`. CameraTrack only: redirects
   * PATH / CONTROLS / TANGENTS_IN / TANGENTS_OUT to the center path instead
   * of the eye path. PoseTrack ignores target (there is only one path).
   * Call trackPath twice (once per target) to decorate both paths with
   * different ambient stroke() colours.
   *
   * The `marker` callback is called once per keyframe as
   * `marker(kf, index, track, ctx)`,
   * where ctx = { near, far, aspect, ndcZMin } is read from the current
   * renderer's projection. The gizmo does NOT pre-translate or rotate
   * before calling marker — markers position themselves using kf.pos/kf.rot
   * (PoseTrack) or kf.eye/kf.center/kf.up (CameraTrack) — or reach into
   * track.mat4Model / track.mat4Eye if they need matrices at arbitrary
   * path coordinates. Projection matrices (e.g. for a custom frustum
   * marker) are built from the keyframe's raw scalars (kf.fov /
   * kf.halfHeight / kf.near / kf.far) via the free mat4Persp / mat4Ortho
   * constructors.
   *
   * Defaults (when `marker` is not supplied):
   *
   * - PoseTrack — six axes (length 30) at the keyframe's pose.
   * - CameraTrack, `target: 'eye'` — a "mini camera" at each keyframe: a triad
   *   (X | Y | _Z, size = `kf.near`), apex lines (perspective only, from the
   *   origin to the near corners), and the near plane outline at the
   *   keyframe's real extents (from `kf.fov` or `kf.halfHeight` at the ambient
   *   aspect). All at the keyframe's real dimensions — the geometry
   *   {@link viewFrustum} draws. Supply a custom marker for markers that stay
   *   legible at any scene scale.
   * - CameraTrack, `target: 'center'` — a `point()` at each keyframe's center.
   *
   * Pass `marker: null` to suppress per-keyframe markers entirely.
   *
   * @function trackPath
   * @memberof p5
   * @param {PoseTrack|CameraTrack} track
   * @param {{
   *   bits?:    number,
   *   samples?: number,
   *   target?:  'eye' | 'center',
   *   marker?:  Function | null,
   * }} [opts]
   * @param {number} [opts.bits=PATH]
   * @param {number} [opts.samples=32]  Line segments per path segment.
   * @param {string} [opts.target='eye']
   * @returns {p5} this
   * @example
   * <caption>A PoseTrack: the sampled path plus the default per-keyframe axes marker</caption>
   * let track
   * const pose = { pos: [0, 0, 0], rot: [0, 0, 0, 1], scl: [1, 1, 1] }
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   track = createPoseTrack()
   *   track.add({ pos: [-120, 60, 0], rot: { axis: [0, 1, 0], angle: 0 } })
   *   track.add({ pos: [0, -60, 80], rot: { axis: [0, 1, 0], angle: PI / 2 } })
   *   track.add({ pos: [120, 60, 0], rot: { axis: [0, 1, 0], angle: PI } })
   *   track.play({ loop: true, bounce: true, duration: 60 })
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   stroke('white')
   *   trackPath(track)
   *   push()
   *   applyPose(track.eval(pose))
   *   stroke('#ff4fd8')
   *   noFill()
   *   box(30)
   *   pop()
   * }
   * @example
   * <caption>Layers by bit, one stroke each: path, control polygon, tangents</caption>
   * let track
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   track = createPoseTrack()
   *   track.add({ pos: [-120, 60, 0] })
   *   track.add({ pos: [0, -60, 80] })
   *   track.add({ pos: [120, 60, 0] })
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   const { PATH, CONTROLS, TANGENTS } = p5.Tree
   *   stroke('white')
   *   trackPath(track, { bits: PATH, marker: null })
   *   stroke('#ffd166')
   *   trackPath(track, { bits: CONTROLS, marker: null })
   *   stroke('#ff4fd8')
   *   trackPath(track, { bits: TANGENTS, marker: null })
   * }
   * @example
   * <caption>A CameraTrack: eye path with mini-camera markers, gaze rays, and the center path</caption>
   * let cam, track
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   camera(300, -200, 500, 0, 0, 0, 0, 1, 0)
   *   cam = createCamera()
   *   track = createCameraTrack(cam)
   *   track.add({ eye: [250, -80, 0], center: [0, 0, -40], fov: PI / 4, near: 40, far: 300 })
   *   track.add({ eye: [0, -150, 250], center: [0, 0, 0], fov: PI / 4, near: 40, far: 300 })
   *   track.add({ eye: [-250, -80, 0], center: [0, 0, 40], fov: PI / 4, near: 40, far: 300 })
   *   track.play({ loop: true, bounce: true, duration: 90 })
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   const { PATH, CENTER } = p5.Tree
   *   noFill()
   *   stroke('white')
   *   trackPath(track)
   *   stroke('#ffd166')
   *   trackPath(track, { bits: PATH, target: 'center' })
   *   stroke('#ff4fd8')
   *   trackPath(track, { bits: CENTER, marker: null })
   *   viewFrustum({ camera: track })
   * }
   * @example
   * <caption>A custom marker: a box oriented by each keyframe's pose</caption>
   * let track
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   track = createPoseTrack()
   *   track.add({ pos: [-120, 60, 0], rot: { axis: [0, 1, 0], angle: 0 } })
   *   track.add({ pos: [0, -60, 80], rot: { axis: [0, 1, 0], angle: PI / 2 } })
   *   track.add({ pos: [120, 60, 0], rot: { axis: [0, 1, 0], angle: PI } })
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   orbitControl()
   *   axes()
   *   stroke('white')
   *   trackPath(track, { marker: null })
   *   stroke('#ffd166')
   *   trackPath(track, {
   *     bits: p5.Tree.NONE,
   *     marker: (kf) => {
   *       push()
   *       translate(kf.pos[0], kf.pos[1], kf.pos[2])
   *       rotateQuat(kf.rot)
   *       noFill()
   *       box(25)
   *       pop()
   *     }
   *   })
   * }
   * @example
   * <caption>HANDLES: drag the keyframes of a track created with the handles opt</caption>
   * let track
   * const pose = { pos: [0, 0, 0], rot: [0, 0, 0, 1], scl: [1, 1, 1] }
   *
   * function setup() {
   *   createCanvas(400, 300, WEBGL)
   *   track = createPoseTrack({ handles: true })
   *   track.add({ pos: [-120, 60, 0] })
   *   track.add({ pos: [0, -60, 80] })
   *   track.add({ pos: [120, 60, 0] })
   *   track.play({ loop: true, bounce: true, duration: 60 })
   * }
   *
   * function draw() {
   *   background('#138D75')
   *   if (!track.handles.update()) orbitControl()   // a grab wins over orbit
   *   axes()
   *   stroke('white')
   *   trackPath(track, { marker: null })
   *   fill('#ff4fd8')
   *   trackPath(track, { bits: p5.Tree.HANDLES })
   *   push()
   *   applyPose(track.eval(pose))
   *   stroke('#ffd166')
   *   noFill()
   *   box(30)
   *   pop()
   * }
   */
  p5.Renderer3D.prototype.trackPath = function (track, opts = {}) {
    const p = this._pInst;
    if (!p) return;
    if (!track || !Array.isArray(track.keyframes)) return;
    const kfs = track.keyframes;
    const n   = kfs.length;
    if (n === 0) return;

    const isCameraTrack = (typeof track.sampleEye === 'function')
                       || (n > 0 && kfs[0].eye !== undefined);

    const {
      bits    = p5.Tree.PATH,
      samples = 32,
      target  = 'eye',
    } = opts;
    const N = Math.max(2, samples | 0);

    // Target resolves field + samplers for PATH / CONTROLS / TANGENTS.
    // PoseTrack ignores target; CameraTrack redirects to the center path
    // when target === 'center'.
    const useCenter   = isCameraTrack && target === 'center';
    const pathField   = isCameraTrack ? (useCenter ? 'center'         : 'eye')        : 'pos';
    const pathSampler = isCameraTrack ? (useCenter ? 'sampleCenter'   : 'sampleEye')  : 'samplePos';
    const tangentsFn  = isCameraTrack ? (useCenter ? 'centerTangents' : 'eyeTangents'): 'tangents';

    let marker;
    if ('marker' in opts) {
      marker = opts.marker;
    } else {
      marker = isCameraTrack
        ? _defaultCameraMarker(this, p5, useCenter)
        : _defaultPoseMarker(this, p5);
    }

    let ctx = null;
    if (marker) {
      const curProj = _projMat4(this);
      const ndcZMin = getNdcZ();
      ctx = {
        near:    projNear(curProj, ndcZMin),
        far:     projFar(curProj),
        aspect:  (this.width && this.height) ? (this.width / this.height) : 1,
        ndcZMin: ndcZMin,
      };
    }

    const hasPath        = (bits & p5.Tree.PATH)         !== 0;
    const hasControls    = (bits & p5.Tree.CONTROLS)     !== 0;
    const hasTangentsIn  = (bits & p5.Tree.TANGENTS_IN)  !== 0;
    const hasTangentsOut = (bits & p5.Tree.TANGENTS_OUT) !== 0;
    const hasCenter      = isCameraTrack && (bits & p5.Tree.CENTER) !== 0;

    // ── PATH: sampled polyline along the target path ─────────────────────
    if (hasPath) {
      if (n === 1) {
        const pt = kfs[0][pathField];
        p.point(pt[0], pt[1], pt[2]);
      } else {
        let first = true;
        for (let seg = 0; seg < n - 1; seg++) {
          const end = (seg === n - 2) ? N : N - 1;
          for (let i = 0; i <= end; i++) {
            const t = i / N;
            track[pathSampler](_sp, seg, t);
            if (!first) p.line(_prev[0], _prev[1], _prev[2], _sp[0], _sp[1], _sp[2]);
            _prev[0] = _sp[0]; _prev[1] = _sp[1]; _prev[2] = _sp[2];
            first = false;
          }
        }
      }
    }

    // ── CONTROLS: straight control polygon along the target path ─────────
    if (hasControls && n >= 2) {
      for (let i = 0; i < n - 1; i++) {
        const a = kfs[i][pathField], b = kfs[i + 1][pathField];
        p.line(a[0], a[1], a[2], b[0], b[1], b[2]);
      }
    }

    // ── TANGENTS_IN / TANGENTS_OUT: arrows at each keyframe ──────────────
    if (hasTangentsIn || hasTangentsOut) {
      for (let i = 0; i < n; i++) {
        track[tangentsFn](_tIn, _tOut, i);
        const kp = kfs[i][pathField];
        if (hasTangentsIn) {
          p.line(kp[0] - _tIn[0], kp[1] - _tIn[1], kp[2] - _tIn[2],
                 kp[0], kp[1], kp[2]);
        }
        if (hasTangentsOut) {
          p.line(kp[0], kp[1], kp[2],
                 kp[0] + _tOut[0], kp[1] + _tOut[1], kp[2] + _tOut[2]);
        }
      }
    }

    // ── CENTER: gaze line eye→center + endpoint dot (CameraTrack only) ───
    // Target-independent: always expresses the eye→center relationship.
    if (hasCenter) {
      for (let i = 0; i < n; i++) {
        const e = kfs[i].eye, c = kfs[i].center;
        p.line(e[0], e[1], e[2], c[0], c[1], c[2]);
        p.point(c[0], c[1], c[2]);
      }
    }

    // ── Per-keyframe marker ──────────────────────────────────────────────
    if (marker) {
      for (let i = 0; i < n; i++) {
        marker(kfs[i], i, track, ctx);
      }
    }

    // HANDLES: keyframe manipulator dots (track.handles). Delegates to the
    // TrackHandles controller created by the track factory's { handles }
    // opt. Duck-typed so trackPath needs no import; a track without handles
    // renders nothing for this bit. Drawn last so the dots sit on top of
    // markers and overlays.
    if ((bits & p5.Tree.HANDLES) !== 0 && track.handles &&
        typeof track.handles.draw === 'function') {
      track.handles.draw();
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Default markers
// ═══════════════════════════════════════════════════════════════════════════

function _defaultPoseMarker(renderer, p5) {
  const p = renderer._pInst;
  const bits = p5.Tree.X | p5.Tree._X | p5.Tree.Y | p5.Tree._Y | p5.Tree.Z | p5.Tree._Z;
  return (kf, _i, _track, _ctx) => {
    p.push();
    p.translate(kf.pos[0], kf.pos[1], kf.pos[2]);
    renderer.rotateQuat(kf.rot);
    renderer.axes({ size: 30, bits });
    p.pop();
  };
}

// Default CameraTrack marker — "mini camera" at each keyframe.
//
// Shares structure with viewFrustum: triad + apex lines + near plane drawn
// in eye-local space at the keyframe's real dimensions. The marker is
// scoped to camera-local geometry — the eye→center gaze line is NOT part
// of it. Enable the CENTER bit in trackPath to draw per-keyframe gaze
// lines alongside.
//
// Real dims throughout:
//   triad size      = kf.near        (the _Z axis tip lands at the near plane centre)
//   near plane z    = -kf.near
//   near extents    = kf.fov or kf.halfHeight + ambient aspect
//
// For tracks with typical small near values (e.g. 0.1) this produces
// visually tiny markers. Supply a custom marker to scale for legibility
// at distance.
function _defaultCameraMarker(renderer, p5, useCenter) {
  const p = renderer._pInst;

  // target=center: no orientation to convey — just a dot at center.
  if (useCenter) {
    return (kf) => {
      p.point(kf.center[0], kf.center[1], kf.center[2]);
    };
  }

  const axesBits = p5.Tree.X | p5.Tree.Y | p5.Tree._Z;

  return (kf, i, trk, ctx) => {
    const near   = (typeof kf.near === 'number') ? kf.near : 0.1;
    const aspect = ctx.aspect;

    // Plane extents at z = -near. Fallback fov only if keyframe carries
    // neither fov nor halfHeight — rare, since capturePose populates one
    // of them for any real camera and _parseCameraSpec does not zero them.
    let hh, hw, isOrtho = false;
    if (typeof kf.halfHeight === 'number') {
      isOrtho = true;
      hh = kf.halfHeight;
      hw = hh * aspect;
    } else {
      const fov = (typeof kf.fov === 'number') ? kf.fov : Math.PI / 3;
      hh = near * Math.tan(fov * 0.5);
      hw = hh * aspect;
    }

    // Eye-local near-plane corners (z = -near, forward direction).
    const nTL = [-hw,  hh, -near];
    const nTR = [ hw,  hh, -near];
    const nBR = [ hw, -hh, -near];
    const nBL = [-hw, -hh, -near];

    trk.mat4Eye(_kfEye, i, 0);
    p.push();
    p.applyMatrix(
      _kfEye[0],  _kfEye[1],  _kfEye[2],  _kfEye[3],
      _kfEye[4],  _kfEye[5],  _kfEye[6],  _kfEye[7],
      _kfEye[8],  _kfEye[9],  _kfEye[10], _kfEye[11],
      _kfEye[12], _kfEye[13], _kfEye[14], _kfEye[15]
    );

    // Triad at the camera origin, oriented by lookat. Size = near so the
    // _Z tip coincides with the near plane centre. Nested push/pop so the
    // semantic axis colours don't leak into the apex / plane draws.
    p.push();
    renderer.axes({ size: near, bits: axesBits });
    p.pop();

    // Apex lines — perspective only (ortho has no apex).
    if (!isOrtho) {
      p.line(0, 0, 0, nTL[0], nTL[1], nTL[2]);
      p.line(0, 0, 0, nTR[0], nTR[1], nTR[2]);
      p.line(0, 0, 0, nBR[0], nBR[1], nBR[2]);
      p.line(0, 0, 0, nBL[0], nBL[1], nBL[2]);
    }

    // Near plane (outline, or filled if user has fill() enabled).
    renderer.pane(nTL, nTR, nBR, nBL);

    p.pop();

    // Note — the marker deliberately does NOT draw an eye→center gaze
    // line. That's the CENTER bit's job (see trackPath). Keeping the
    // responsibilities separate means CENTER is a meaningful toggle,
    // and the marker stays scoped to camera-local geometry.
  };
}
