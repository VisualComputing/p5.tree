/**
 * @file Gizmos — scene-space diagnostic helpers.
 * @module p5.tree/gizmos
 * @license AGPL-3.0-only
 *
 * axes      — coordinate frame (X/Y/Z, optional labels), semantic colouring
 * grid      — ground plane
 * cross     — screen-space crosshair centred on current model origin
 * bullsEye  — screen-space bulls-eye centred on current model origin
 * viewFrustum — another renderer's view frustum drawn in this renderer
 * hermite   — a single Hermite segment given endpoints and tangents
 * trackPath — PoseTrack / CameraTrack path + control polygon + tangents +
 *             per-keyframe marker (pluggable via opts.marker)
 *
 * Depends on p5.tree/hud (beginHUD / endHUD), p5.tree/matrix (mapLocation,
 * pixelRatio, p5.Tree constants), and p5.tree/visibility (computePlanes).
 */

'use strict';

import {
  projIsOrtho, projNear, projFar,
  projLeft, projRight, projTop, projBottom,
  hermiteVec3,
} from '@nakednous/tree';

import { getNdcZ } from './matrix.js';

// ═══════════════════════════════════════════════════════════════════════════
// Module-level working buffers — never returned to caller
// ═══════════════════════════════════════════════════════════════════════════

const _sl    = new Float32Array(3);
const _wl    = new Float32Array(3);
const _eye   = new Float32Array(16);

// trackPath sample buffers
const _sp    = new Float32Array(3);
const _prev  = new Float32Array(3);
const _tIn   = new Float32Array(3);
const _tOut  = new Float32Array(3);
const _kfEye = new Float32Array(16);

// ═══════════════════════════════════════════════════════════════════════════
// Local p5 state accessors
// ═══════════════════════════════════════════════════════════════════════════

const _rawMat4   = (m) => (m != null && m.mat4 != null) ? m.mat4 : m;
const _projMat4  = (r) => r.states.uPMatrix.mat4;
const _viewMat4  = (r) => r.states.curCamera.cameraMatrix.mat4;
const _modelMat4 = (r) => r.states.uModelMatrix.mat4;

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
   *   semantic: true  (default) — X red, Y lime, Z blue; labels inherit axis colour.
   *   semantic: false          — every axis and label uses ambient stroke.
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
   *   hermite([0,0,0], [100,0,0], [200,0,0], [0,100,0])
   *   hermite(p0, m0, p1, m1, { samples: 64 })
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
   * Visualise a PoseTrack or CameraTrack: sampled path polyline, control
   * polygon, tangent arrows, per-keyframe marker, and (CameraTrack only)
   * gaze rays from each eye keyframe to its center.
   *
   * Bits:
   *   PATH          — sampled polyline along the target path.
   *   CONTROLS      — straight control polygon along the target path.
   *   TANGENTS_IN   — incoming tangent arrow at each keyframe.
   *   TANGENTS_OUT  — outgoing tangent arrow at each keyframe.
   *   TANGENTS      — convenience alias (IN | OUT).
   *   CENTER        — CameraTrack only. Gaze line from each kf.eye to
   *                   kf.center, with a point() at kf.center. Target-
   *                   independent — always expresses the eye→center
   *                   relationship regardless of opts.target.
   *
   * opts.target — 'eye' (default) or 'center'. CameraTrack only: redirects
   * PATH / CONTROLS / TANGENTS_IN / TANGENTS_OUT to the center path instead
   * of the eye path. PoseTrack ignores target (there is only one path).
   * Call trackPath twice (once per target) to decorate both paths with
   * different ambient stroke() colours.
   *
   * The `marker` callback is called once per keyframe with
   *   marker(kf, index, track, ctx)
   * where ctx = { near, far, aspect, ndcZMin } is read from the current
   * renderer's projection. The gizmo does NOT pre-translate or rotate
   * before calling marker — markers position themselves using kf.pos/kf.rot
   * (PoseTrack) or kf.eye/kf.center/kf.up (CameraTrack) — or reach into
   * track.mat4Model / track.mat4Eye if they need matrices at arbitrary
   * path coordinates. Projection matrices (e.g. for a frustum marker) are
   * built from the keyframe's raw scalars (kf.fov or kf.halfHeight) via
   * the free mat4Persp / mat4Ortho constructors.
   *
   * Defaults (when `marker` is not supplied):
   *   PoseTrack                    — six axes (length 30) at the keyframe's pose.
   *   CameraTrack, target='eye'    — pose triad at each keyframe's eye,
   *                                  oriented by the lookat basis via
   *                                  track.mat4Eye(_, i, 0). Size auto-
   *                                  scales with the mean inter-keyframe
   *                                  eye distance — independent of the
   *                                  main camera's projection.
   *   CameraTrack, target='center' — point() at each keyframe's center.
   *
   * Pass `marker: null` to suppress per-keyframe markers entirely. Frustum-
   * style markers are not a default (they coupled to the main camera's
   * projection and scaled poorly); pass a custom marker that calls
   * viewFrustum({...}) when frustum visualisation is wanted.
   *
   * @param {PoseTrack|CameraTrack} track
   * @param {{
   *   bits?:    number,
   *   samples?: number,
   *   target?:  'eye' | 'center',
   *   marker?:  Function | null,
   * }} [opts]
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
        ? _defaultCameraMarker(this, p5, track, useCenter)
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

function _defaultCameraMarker(renderer, p5, track, useCenter) {
  const p = renderer._pInst;

  // target=center: center is a lookat point — no orientation to convey.
  if (useCenter) {
    return (kf) => {
      p.point(kf.center[0], kf.center[1], kf.center[2]);
    };
  }

  // target=eye (default): pose triad at each keyframe, oriented by the
  // lookat basis. Size is track-intrinsic — scales with the track, not
  // with the main camera's projection, so markers stay sane at any scene
  // scale (including p5 v2's large default near/far).
  const size = _intrinsicMarkerSize(track, 'eye');
  const bits = p5.Tree.X | p5.Tree._X | p5.Tree.Y | p5.Tree._Y | p5.Tree.Z | p5.Tree._Z;
  return (kf, i, trk, _ctx) => {
    trk.mat4Eye(_kfEye, i, 0);
    p.push();
    p.applyMatrix(
      _kfEye[0],  _kfEye[1],  _kfEye[2],  _kfEye[3],
      _kfEye[4],  _kfEye[5],  _kfEye[6],  _kfEye[7],
      _kfEye[8],  _kfEye[9],  _kfEye[10], _kfEye[11],
      _kfEye[12], _kfEye[13], _kfEye[14], _kfEye[15]
    );
    renderer.axes({ size, bits });
    p.pop();
  };
}

// Mean inter-keyframe distance × 0.2, floored at 5. Falls back to 30 on
// single-keyframe tracks so the marker is visible at default scene scales.
function _intrinsicMarkerSize(track, field) {
  const kfs = track.keyframes;
  const n   = kfs.length;
  if (n < 2) return 30;
  let sum = 0;
  for (let i = 0; i < n - 1; i++) {
    const a = kfs[i][field], b = kfs[i + 1][field];
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    sum += Math.sqrt(dx*dx + dy*dy + dz*dz);
  }
  return Math.max((sum / (n - 1)) * 0.2, 5);
}
