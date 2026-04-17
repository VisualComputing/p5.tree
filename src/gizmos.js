/**
 * @file Gizmos — scene-space diagnostic helpers.
 * @module p5.tree/gizmos
 * @license AGPL-3.0-only
 *
 * axes      — coordinate frame (X/Y/Z, optional labels)
 * grid      — ground plane
 * cross     — screen-space crosshair centred on current model origin
 * bullsEye  — screen-space bulls-eye centred on current model origin
 * viewFrustum — another renderer's view frustum drawn in this renderer
 * hermite   — a single Hermite segment given endpoints and tangents
 * trackPath — PoseTrack / CameraTrack path + keyframe markers + tangents + frustums
 *
 * Depends on p5.tree/hud (beginHUD / endHUD), p5.tree/matrix (mapLocation,
 * pixelRatio, p5.Tree constants), and p5.tree/visibility (computePlanes).
 *
 * All internal calls to mapLocation pass opts.out = _sl / _wl so they are
 * zero-allocation and write directly into the module-level scratch buffers.
 */

'use strict';

import {
  projIsOrtho, projNear, projFar,
  projLeft, projRight, projTop, projBottom,
  mat4Persp, mat4Ortho,
  qFromLookDir, qToMat4,
  hermiteVec3,
} from '@nakednous/tree';

import { getNdcZ } from './matrix.js';

// ═══════════════════════════════════════════════════════════════════════════
// Module-level working buffers — never returned to caller
// ═══════════════════════════════════════════════════════════════════════════

const _sl  = new Float32Array(3);   // screen location (cross, bullsEye)
const _wl  = new Float32Array(3);   // world location  (pixelRatio input)
const _eye = new Float32Array(16);  // eye matrix scratch for viewFrustum

// trackPath sample buffers (reused across segments / keyframes in one call)
const _sp    = new Float32Array(3);   // sampled point (primary path)
const _sp2   = new Float32Array(3);   // sampled point (center path)
const _prev  = new Float32Array(3);   // previous sample (for line() polylines)
const _tIn   = new Float32Array(3);   // tangent in
const _tOut  = new Float32Array(3);   // tangent out
const _kfEye = new Float32Array(16);  // per-keyframe eye matrix (FRUSTUMS)
const _kfPrj = new Float32Array(16);  // per-keyframe proj matrix (FRUSTUMS)
const _kfRot = [0,0,0,1];             // scratch quaternion

// ═══════════════════════════════════════════════════════════════════════════
// Local p5 state accessors
// ═══════════════════════════════════════════════════════════════════════════

const _rawMat4   = (m) => (m != null && m.mat4 != null) ? m.mat4 : m;
const _projMat4  = (r) => r.states.uPMatrix.mat4;
const _viewMat4  = (r) => r.states.curCamera.cameraMatrix.mat4;
const _modelMat4 = (r) => r.states.uModelMatrix.mat4;

// Semantic axis colours — used when axes({ semantic: true }) is active.
const _AXIS_COLORS = ['Red', 'Lime', 'DodgerBlue'];

// ═══════════════════════════════════════════════════════════════════════════
// Install
// ═══════════════════════════════════════════════════════════════════════════

export function installGizmos(p5, fn) {

  // ── Axes ──────────────────────────────────────────────────────────────────

  fn.axes = function (opts) { this._renderer.axes(opts); return this; };

  /**
   * Draw a 3D coordinate frame at the current model origin.
   *
   * Colouring:
   *   semantic: true  (default) — X red, Y lime, Z blue (matches universal
   *                               3D convention; labels inherit axis colour).
   *   semantic: false          — every axis and label uses ambient stroke
   *                              (consistent with grid / cross / viewFrustum).
   *
   * Per-axis coloured variants are obtained by calling axes({ bits: ... })
   * with a single bit and semantic: false, one stroke per call:
   *
   *   stroke('red');   axes({ bits: p5.Tree.X, semantic: false })
   *   stroke('lime');  axes({ bits: p5.Tree.Y, semantic: false })
   *   stroke('blue');  axes({ bits: p5.Tree.Z, semantic: false })
   *
   * @param {{ size?: number, semantic?: boolean, bits?: number }} [opts]
   */
  p5.Renderer3D.prototype.axes = function ({
    size     = 100,
    semantic = true,
    bits     = p5.Tree.LABELS | p5.Tree.X | p5.Tree.Y | p5.Tree.Z
  } = {}) {
    const p = this._pInst;
    if (!p) return;

    // When semantic, pick axis colour; otherwise no-op (ambient stroke drives).
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
   * Draw a screen-space crosshair centred on the current model's origin.
   * @param {{
   *   mat4Model?:  Float32Array | ArrayLike | p5.Matrix,
   *   x?, y?,
   *   size?:       number,
   *   mat4Eye?:    Float32Array | ArrayLike | p5.Matrix,
   *   mat4Proj?:   Float32Array | ArrayLike | p5.Matrix,
   *   mat4View?:   Float32Array | ArrayLike | p5.Matrix,
   *   mat4PV?:     Float32Array | ArrayLike | p5.Matrix,
   * }} [opts]
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
   * Draw a screen-space bulls-eye overlay centred on the current model's origin.
   * @param {{
   *   mat4Model?:  Float32Array | ArrayLike | p5.Matrix,
   *   x?, y?,
   *   size?:       number,
   *   shape?:      number,
   *   mat4Eye?:    Float32Array | ArrayLike | p5.Matrix,
   *   mat4Proj?:   Float32Array | ArrayLike | p5.Matrix,
   *   mat4View?:   Float32Array | ArrayLike | p5.Matrix,
   *   mat4PV?:     Float32Array | ArrayLike | p5.Matrix,
   * }} [opts]
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

  // ── View frustum ──────────────────────────────────────────────────────────

  fn.viewFrustum = function (opts) { this._renderer.viewFrustum(opts); return this; };

  /**
   * Draw the view frustum of a secondary renderer / camera into this renderer.
   * @param {{
   *   pg?,
   *   mat4Eye?:   Float32Array | ArrayLike | p5.Matrix,
   *   mat4Proj?:  Float32Array | ArrayLike | p5.Matrix,
   *   mat4View?:  Float32Array | ArrayLike | p5.Matrix,
   *   bits?:      number,
   *   viewer?:    function,
   * }} [opts]
   */
  p5.Renderer3D.prototype.viewFrustum = function ({
    pg, mat4Eye, mat4Proj, mat4View,
    bits   = p5.Tree.NEAR | p5.Tree.FAR,
    viewer = () => this.axes({
      size: 50,
      bits: p5.Tree.X | p5.Tree._X | p5.Tree.Y | p5.Tree._Y | p5.Tree.Z | p5.Tree._Z
    })
  } = {}) {
    const p = this._pInst;
    if (!p) return;
    if (this === pg) { console.error('displaying viewFrustum requires a pg different than this'); return; }

    const eRaw = _rawMat4(mat4Eye)  ?? (pg ? (pg._renderer.mat4Eye(_eye), _eye) : null);
    const pRaw = _rawMat4(mat4Proj) ?? (pg ? _projMat4(pg._renderer) : null);

    if (!pRaw || !eRaw) {
      console.error('displaying viewFrustum requires either a pg or both mat4Eye and mat4Proj'); return;
    }

    const states = this.states, uView = states?.uViewMatrix;
    if (!uView) return;

    const vRaw    = _rawMat4(mat4View) ?? _viewMat4(this);
    const isOrtho = projIsOrtho(pRaw);
    const ndcZ    = getNdcZ();
    const apex    = !isOrtho && ((bits & p5.Tree.APEX) !== 0);
    const n = -projNear(pRaw, ndcZ), f = -projFar(pRaw);
    const l =  projLeft(pRaw, ndcZ),  r = projRight(pRaw, ndcZ);
    const t = projTop(pRaw, ndcZ);
    const b = projBottom(pRaw, ndcZ);
    const ratio = isOrtho ? 1 : f/n;
    const _l=ratio*l, _r=ratio*r, _b=ratio*b, _t=ratio*t;

    p.push(); p.resetMatrix();
    const prevView = uView.copy();
    uView.set(vRaw);
    this.applyMatrix(...eRaw);
    typeof viewer === 'function' && viewer();

    if ((bits & p5.Tree.FAR) !== 0) {
      this.beginShape(); this.vertex(_l,_t,f); this.vertex(_r,_t,f);
      this.vertex(_r,_b,f); this.vertex(_l,_b,f); this.endShape(p.CLOSE);
    } else {
      this.line(_l,_t,f,_r,_t,f); this.line(_r,_t,f,_r,_b,f);
      this.line(_r,_b,f,_l,_b,f); this.line(_l,_b,f,_l,_t,f);
    }
    if ((bits & p5.Tree.BODY) !== 0) {
      this.beginShape(); this.vertex(_l,_t,f); this.vertex(l,t,n); this.vertex(r,t,n); this.vertex(_r,_t,f); this.endShape();
      this.beginShape(); this.vertex(_r,_t,f); this.vertex(r,t,n); this.vertex(r,b,n); this.vertex(_r,_b,f); this.endShape();
      this.beginShape(); this.vertex(_r,_b,f); this.vertex(r,b,n); this.vertex(l,b,n); this.vertex(_l,_b,f); this.endShape();
      this.beginShape(); this.vertex(l,t,n); this.vertex(_l,_t,f); this.vertex(_l,_b,f); this.vertex(l,b,n); this.endShape();
      if (apex) {
        this.line(0,0,0,r,t,n); this.line(0,0,0,l,t,n);
        this.line(0,0,0,l,b,n); this.line(0,0,0,r,b,n);
      }
    } else {
      this.line(apex?0:r, apex?0:t, apex?0:n, _r,_t,f);
      this.line(apex?0:l, apex?0:t, apex?0:n, _l,_t,f);
      this.line(apex?0:l, apex?0:b, apex?0:n, _l,_b,f);
      this.line(apex?0:r, apex?0:b, apex?0:n, _r,_b,f);
    }
    if ((bits & p5.Tree.NEAR) !== 0) {
      this.beginShape(); this.vertex(l,t,n); this.vertex(r,t,n);
      this.vertex(r,b,n); this.vertex(l,b,n); this.endShape(p.CLOSE);
    } else {
      this.line(l,t,n,r,t,n); this.line(r,t,n,r,b,n);
      this.line(r,b,n,l,b,n); this.line(l,b,n,l,t,n);
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
   * Draw one cubic Hermite segment between two endpoints with explicit tangents.
   *
   * Pedagogical primitive for the splines chapter: pass p0, p1, and their
   * in/out tangent vectors m0 (outgoing at p0) and m1 (incoming at p1); the
   * curve is sampled at `samples` points and drawn as a polyline using the
   * ambient stroke state.
   *
   *   hermite([0,0,0], [100,0,0], [200,0,0], [0,100,0])
   *   hermite(p0, m0, p1, m1, { samples: 64 })
   *
   * trackPath uses hermite internally for each segment in Hermite mode.
   *
   * @param {number[]} p0  Segment start — [x,y,z].
   * @param {number[]} m0  Outgoing tangent at p0.
   * @param {number[]} p1  Segment end — [x,y,z].
   * @param {number[]} m1  Incoming tangent at p1.
   * @param {{ samples?: number }} [opts]
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
   * Draw a PoseTrack or CameraTrack's path, keyframe markers, tangents,
   * control polygon, lookat lines, and/or per-keyframe view frustums.
   *
   * Dispatches on track type (duck-checks keyframes[0].eye).  Bits that do not
   * apply to a given track type are silently ignored (FRUSTUMS / LOOKAT /
   * CENTER on PoseTrack; none extra on CameraTrack).
   *
   * All strokes come from the ambient `stroke(...)` state.  Multi-colour
   * effects are achieved by splitting into multiple calls with different
   * strokes per bit — exactly the same pattern as axes / viewFrustum:
   *
   *   const { PATH, KEYFRAMES, CONTROLS, TANGENTS_IN, TANGENTS_OUT } = p5.Tree
   *
   *   stroke(200);       trackPath(track, { bits: PATH | KEYFRAMES })
   *   stroke(80);        trackPath(track, { bits: CONTROLS })
   *   stroke('cyan');    trackPath(track, { bits: TANGENTS_IN })
   *   stroke('magenta'); trackPath(track, { bits: TANGENTS_OUT })
   *
   * Keyframe markers are small axes gizmos oriented by each keyframe's
   * rotation (PoseTrack) or lookat basis (CameraTrack).  Their colouring
   * follows axes({ semantic }) — pass `semantic: false` to suppress
   * red/lime/blue when mixing the marker with a monochrome scheme.
   *
   * @param {PoseTrack|CameraTrack} track
   * @param {{
   *   bits?:     number,     // default PATH | KEYFRAMES
   *   samples?:  number,     // samples per segment (default 32)
   *   size?:     number,     // axes marker size (default 30)
   *   tanScale?: number,     // tangent arrow scale factor (default 1.0)
   *   semantic?: boolean,    // propagate semantic-colour flag to axes markers
   * }} [opts]
   */
  p5.Renderer3D.prototype.trackPath = function (track, {
    bits     = p5.Tree.PATH | p5.Tree.KEYFRAMES,
    samples  = 32,
    size     = 30,
    tanScale = 1.0,
    semantic = true,
  } = {}) {
    const p = this._pInst;
    if (!p) return;
    if (!track || !Array.isArray(track.keyframes)) return;
    const kfs = track.keyframes;
    const n   = kfs.length;
    if (n === 0) return;

    const isCameraTrack = (typeof track.sampleEye === 'function')
                       || (n > 0 && kfs[0].eye !== undefined);
    const N = Math.max(2, samples | 0);

    // Clamp or soften bits that do not apply.
    const hasPath       = (bits & p5.Tree.PATH)         !== 0;
    const hasCenter     = isCameraTrack && (bits & p5.Tree.CENTER)     !== 0;
    const hasKeyframes  = (bits & p5.Tree.KEYFRAMES)    !== 0;
    const hasControls   = (bits & p5.Tree.CONTROLS)     !== 0;
    const hasTangentsIn = (bits & p5.Tree.TANGENTS_IN)  !== 0;
    const hasTangentsOut= (bits & p5.Tree.TANGENTS_OUT) !== 0;
    const hasLookat     = isCameraTrack && (bits & p5.Tree.LOOKAT)   !== 0;
    const hasFrustums   = isCameraTrack && (bits & p5.Tree.FRUSTUMS) !== 0;

    // ── PATH: primary sampled polyline (pos or eye) ──────────────────────
    if (hasPath && n >= 1) {
      if (n === 1) {
        const pt = isCameraTrack ? kfs[0].eye : kfs[0].pos;
        p.point(pt[0], pt[1], pt[2]);
      } else {
        let first = true;
        for (let seg = 0; seg < n - 1; seg++) {
          // include segment endpoint only on last segment to avoid duplication
          const end = (seg === n - 2) ? N : N - 1;
          for (let i = 0; i <= end; i++) {
            const t = i / N;
            if (isCameraTrack) track.sampleEye(_sp, seg, t);
            else               track.samplePos(_sp, seg, t);
            if (!first) p.line(_prev[0], _prev[1], _prev[2], _sp[0], _sp[1], _sp[2]);
            _prev[0] = _sp[0]; _prev[1] = _sp[1]; _prev[2] = _sp[2];
            first = false;
          }
        }
      }
    }

    // ── CENTER: secondary sampled polyline (CameraTrack only) ────────────
    if (hasCenter && n >= 1) {
      if (n === 1) {
        const pt = kfs[0].center;
        p.point(pt[0], pt[1], pt[2]);
      } else {
        let first = true;
        for (let seg = 0; seg < n - 1; seg++) {
          const end = (seg === n - 2) ? N : N - 1;
          for (let i = 0; i <= end; i++) {
            const t = i / N;
            track.sampleCenter(_sp2, seg, t);
            if (!first) p.line(_prev[0], _prev[1], _prev[2], _sp2[0], _sp2[1], _sp2[2]);
            _prev[0] = _sp2[0]; _prev[1] = _sp2[1]; _prev[2] = _sp2[2];
            first = false;
          }
        }
      }
    }

    // ── CONTROLS: straight control polygon between adjacent keyframes ────
    if (hasControls && n >= 2) {
      const field = isCameraTrack ? 'eye' : 'pos';
      for (let i = 0; i < n - 1; i++) {
        const a = kfs[i][field], b = kfs[i + 1][field];
        p.line(a[0], a[1], a[2], b[0], b[1], b[2]);
      }
      if (isCameraTrack && hasCenter) {
        // matching center control polygon when CENTER is on
        for (let i = 0; i < n - 1; i++) {
          const a = kfs[i].center, b = kfs[i + 1].center;
          p.line(a[0], a[1], a[2], b[0], b[1], b[2]);
        }
      }
    }

    // ── TANGENTS_IN / TANGENTS_OUT: arrows at each keyframe ──────────────
    if ((hasTangentsIn || hasTangentsOut) && n >= 1) {
      const sampleTangents = isCameraTrack
        ? (i) => track.sampleEyeTangents(_tIn, _tOut, i)
        : (i) => track.sampleTangents(_tIn, _tOut, i);
      const field = isCameraTrack ? 'eye' : 'pos';
      for (let i = 0; i < n; i++) {
        sampleTangents(i);
        const kp = kfs[i][field];
        if (hasTangentsIn) {
          p.line(kp[0] - _tIn[0] * tanScale,
                 kp[1] - _tIn[1] * tanScale,
                 kp[2] - _tIn[2] * tanScale,
                 kp[0], kp[1], kp[2]);
        }
        if (hasTangentsOut) {
          p.line(kp[0], kp[1], kp[2],
                 kp[0] + _tOut[0] * tanScale,
                 kp[1] + _tOut[1] * tanScale,
                 kp[2] + _tOut[2] * tanScale);
        }
      }

      if (isCameraTrack && hasCenter) {
        // matching center tangents when CENTER is on
        for (let i = 0; i < n; i++) {
          track.sampleCenterTangents(_tIn, _tOut, i);
          const kp = kfs[i].center;
          if (hasTangentsIn) {
            p.line(kp[0] - _tIn[0] * tanScale,
                   kp[1] - _tIn[1] * tanScale,
                   kp[2] - _tIn[2] * tanScale,
                   kp[0], kp[1], kp[2]);
          }
          if (hasTangentsOut) {
            p.line(kp[0], kp[1], kp[2],
                   kp[0] + _tOut[0] * tanScale,
                   kp[1] + _tOut[1] * tanScale,
                   kp[2] + _tOut[2] * tanScale);
          }
        }
      }
    }

    // ── LOOKAT (camera only): eye→center line per keyframe ───────────────
    if (hasLookat) {
      for (let i = 0; i < n; i++) {
        const e = kfs[i].eye, c = kfs[i].center;
        p.line(e[0], e[1], e[2], c[0], c[1], c[2]);
      }
    }

    // ── KEYFRAMES: axes marker oriented by keyframe pose ─────────────────
    if (hasKeyframes) {
      const markerBits = p5.Tree.X | p5.Tree.Y | p5.Tree.Z;  // no negatives, no labels
      if (isCameraTrack) {
        for (let i = 0; i < n; i++) {
          const e = kfs[i].eye, c = kfs[i].center, u = kfs[i].up;
          // Forward = (center - eye); qFromLookDir sends -Z to `dir`, so after
          // rotation -Z points from eye to center — matches OpenGL camera
          // convention where the camera looks down -Z in its own frame.
          const dx = c[0]-e[0], dy = c[1]-e[1], dz = c[2]-e[2];
          qFromLookDir(_kfRot, [dx, dy, dz], u);
          p.push();
          p.translate(e[0], e[1], e[2]);
          this.rotateQuat(_kfRot);
          this.axes({ size, semantic, bits: markerBits });
          p.pop();
        }
      } else {
        for (let i = 0; i < n; i++) {
          const po = kfs[i].pos, r = kfs[i].rot;
          p.push();
          p.translate(po[0], po[1], po[2]);
          this.rotateQuat(r);
          this.axes({ size, semantic, bits: markerBits });
          p.pop();
        }
      }
    }

    // ── FRUSTUMS (camera only): tiny viewFrustum at each keyframe ────────
    if (hasFrustums) {
      // Aspect from current canvas; near/far from current camera's projection.
      const curProj = _projMat4(this);
      const ndcZ    = getNdcZ();
      const near    = projNear(curProj, ndcZ);
      const far     = projFar(curProj);
      const aspect  = (this.width && this.height) ? (this.width / this.height) : 1;

      for (let i = 0; i < n; i++) {
        const k = kfs[i];
        // Build eye matrix from (eye, center, up).
        const dx = k.center[0]-k.eye[0], dy = k.center[1]-k.eye[1], dz = k.center[2]-k.eye[2];
        qFromLookDir(_kfRot, [dx, dy, dz], k.up);
        qToMat4(_kfEye, _kfRot);
        _kfEye[12] = k.eye[0]; _kfEye[13] = k.eye[1]; _kfEye[14] = k.eye[2];

        // Build per-keyframe projection from fov or halfHeight + current near/far.
        let hasProj = false;
        if (k.fov != null) {
          const hh = near * Math.tan(k.fov * 0.5);
          const hw = hh * aspect;
          mat4Persp(_kfPrj, -hw, hw, -hh, hh, near, far);
          hasProj = true;
        } else if (k.halfHeight != null) {
          const hh = k.halfHeight;
          const hw = hh * aspect;
          mat4Ortho(_kfPrj, -hw, hw, -hh, hh, near, far);
          hasProj = true;
        }

        if (hasProj) {
          this.viewFrustum({
            mat4Eye:  _kfEye,
            mat4Proj: _kfPrj,
            bits:     p5.Tree.NEAR | p5.Tree.FAR,
            viewer:   () => {}   // keyframe axes already drawn by KEYFRAMES
          });
        }
      }
    }
  };
}
