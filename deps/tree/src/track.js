/**
 * @file Spline math and keyframe animation state machines.
 * @module tree/track
 * @license AGPL-3.0-only
 *
 * Quaternion algebra is provided by quat.js — this module imports and uses
 * it but does not define it. Spline helpers (hermiteVec3, lerpVec3) and
 * TRS↔mat4 conversions (transformToMat4, mat4ToTransform) remain here
 * because they are tightly coupled to the PoseTrack keyframe shape.
 *
 * Zero dependencies on p5, DOM, WebGL, or WebGPU.
 *
 * ── Exports ──────────────────────────────────────────────────────────────────
 *  Quaternion helpers  (re-exported from quat.js)
 *    qSet qCopy qDot qNormalize qNegate qMul qSlerp qNlerp
 *    qFromAxisAngle qFromLookDir qFromRotMat3x3 qFromMat4 qToMat4
 *    qToAxisAngle
 *  Spline / vector helpers
 *    hermiteVec3  lerpVec3
 *  Transform / mat4 helpers
 *    transformToMat4  mat4ToTransform
 *  Tracks
 *    PoseTrack    — { pos, rot, scl } TRS keyframes
 *    CameraTrack  — { eye, center, up } lookat keyframes
 *
 * ── Class hierarchy ───────────────────────────────────────────────────────────
 *  Track (unexported, never instantiated directly)
 *    └── PoseTrack   (exported)
 *    └── CameraTrack (exported)
 *
 *  Track holds all transport machinery: cursor, play/stop/seek/tick,
 *  hooks, rate semantics.  Subclasses add only keyframe storage and
 *  add() / eval() for their respective data shape.
 *
 * ── Path samplers (public, zero-alloc, no cursor side effects) ──────────────
 *  PoseTrack
 *    samplePos(out, seg, t)            writes interpolated pos at (seg, t∈[0,1])
 *    sampleTangents(outIn, outOut, i)  effective in/out tangents at keyframe i
 *  CameraTrack
 *    sampleEye(out, seg, t)
 *    sampleCenter(out, seg, t)
 *    sampleEyeTangents(outIn, outOut, i)
 *    sampleCenterTangents(outIn, outOut, i)
 *
 *  Samplers honour the corresponding interpolation mode (hermite/linear/step)
 *  and the stored-tangent / auto-CR fallback chain used by eval().
 *
 * ── Hook architecture ─────────────────────────────────────────────────────────
 *  Lib-space hooks (underscore prefix — reserved for host layer / UI layer):
 *    _onActivate / _onDeactivate  — fire on playing transitions false→true / true→false.
 *    _onPlay / _onEnd / _onStop   — mirror the user-space hooks; used by the UI layer
 *                                   so it can sync without chaining the public slots.
 *
 *  User-space hooks (public):
 *    onPlay : fires in play()  on false→true transition.
 *    onEnd  : fires in tick()  at natural boundary (once mode only).
 *    onStop : fires in stop() / reset() — explicit deactivation.
 *    onEnd and onStop are mutually exclusive per event.
 *
 *  Firing order:
 *    play()  → onPlay → _onPlay → _onActivate
 *    tick()  → onEnd  → _onEnd  → _onDeactivate
 *    stop()  → onStop → _onStop → _onDeactivate
 *    reset() → onStop → _onStop → _onDeactivate
 *
 * ── Loop modes ────────────────────────────────────────────────────────────────
 *  loop:false, bounce:false  — play once, stop at end (fires onEnd)
 *  loop:true,  bounce:false  — repeat, wrap back to start
 *  loop:true,  bounce:true   — bounce forever at boundaries
 *  loop:false, bounce:true   — bounce once: flip at far boundary, stop at origin
 *
 *  bounce and loop are fully independent flags — no exclusivity enforced.
 *
 * ── Playback semantics (rate + _dir) ─────────────────────────────────────────
 *  rate > 0   forward
 *  rate < 0   backward
 *  rate === 0 frozen: tick() no-op; playing unchanged
 *
 *  play() is the sole setter of playing = true.
 *  stop() is the sole setter of playing = false.
 *  Assigning rate never starts or stops playback.
 *
 *  _dir (internal, ±1) tracks the current bounce travel direction.
 *  tick() advances by rate * _dir and flips _dir at boundaries.
 *  rate always holds the user-set value — it is never mutated by bounce.
 *  _dir is reset to 1 only in reset() (keyframes cleared) — stop/replay
 *  preserves the current travel direction.
 *
 * ── One-keyframe behaviour ────────────────────────────────────────────────────
 *  play() with exactly one keyframe snaps eval() to that keyframe without
 *  setting playing = true and without firing hooks.
 */

'use strict';

export {
  qSet, qCopy, qDot, qNormalize, qNegate, qMul,
  qSlerp, qNlerp,
  qFromAxisAngle, qFromLookDir, qFromRotMat3x3, qFromMat4,
  qToAxisAngle,
} from './quat.js';

import {
  qSlerp, qNlerp, qMul, qFromAxisAngle, qFromLookDir, qFromRotMat3x3, qToMat4,
} from './quat.js';

// =========================================================================
// S2  Spline / vector helpers
// =========================================================================

function _dist3(a, b) {
  const dx=a[0]-b[0], dy=a[1]-b[1], dz=a[2]-b[2];
  return Math.sqrt(dx*dx+dy*dy+dz*dz);
}

/**
 * Cubic Hermite interpolation between p0 and p1 with explicit tangents.
 * Catmull-Rom is a special case where m0/m1 are auto-computed from neighbors.
 * @param {number[]} out  3-element result.
 * @param {number[]} p0   Segment start.
 * @param {number[]} m0   Outgoing tangent at p0 (world-space, dp/dt scaled to segment).
 * @param {number[]} p1   Segment end.
 * @param {number[]} m1   Incoming tangent at p1 (world-space, dp/dt scaled to segment).
 * @param {number}   t    Blend [0, 1].
 * @returns {number[]} out
 */
export const hermiteVec3 = (out, p0, m0, p1, m1, t) => {
  const t2=t*t, t3=t2*t;
  const h00=2*t3-3*t2+1, h10=t3-2*t2+t, h01=-2*t3+3*t2, h11=t3-t2;
  out[0]=h00*p0[0]+h10*m0[0]+h01*p1[0]+h11*m1[0];
  out[1]=h00*p0[1]+h10*m0[1]+h01*p1[1]+h11*m1[1];
  out[2]=h00*p0[2]+h10*m0[2]+h01*p1[2]+h11*m1[2];
  return out;
};

// Centripetal CR outgoing tangent at p1 for segment p1→p2, scaled by dt1.
// Signature: (out, p0, p1, p2). Returns tangent AT p1 (the middle point).
const _crTanOut = (out, p0, p1, p2) => {
  const dt0=Math.pow(_dist3(p0,p1),0.5)||1, dt1=Math.pow(_dist3(p1,p2),0.5)||1;
  for (let i=0;i<3;i++) out[i]=((p1[i]-p0[i])/dt0-(p2[i]-p0[i])/(dt0+dt1)+(p2[i]-p1[i])/dt1)*dt1;
  return out;
};

// Centripetal CR incoming tangent at p2 for segment p1→p2, scaled by dt1.
// Signature: (out, p1, p2, p3). Returns tangent AT p2 (the middle point).
const _crTanIn = (out, p1, p2, p3) => {
  const dt1=Math.pow(_dist3(p1,p2),0.5)||1, dt2=Math.pow(_dist3(p2,p3),0.5)||1;
  for (let i=0;i<3;i++) out[i]=((p2[i]-p1[i])/dt1-(p3[i]-p1[i])/(dt1+dt2)+(p3[i]-p2[i])/dt2)*dt1;
  return out;
};

// Module-level scratch — shared across all track instances (non-reentrant hot path).
const _m0=[0,0,0], _m1=[0,0,0];

/**
 * Linear interpolation between two vec3s.
 * @param {number[]} out
 * @param {number[]} a
 * @param {number[]} b
 * @param {number}   t  Blend [0, 1].
 * @returns {number[]} out
 */
export const lerpVec3 = (out, a, b, t) => {
  out[0]=a[0]+t*(b[0]-a[0]);
  out[1]=a[1]+t*(b[1]-a[1]);
  out[2]=a[2]+t*(b[2]-a[2]);
  return out;
};

// =========================================================================
// S2b  Path samplers — shared core
// =========================================================================
//
// These helpers factor out the per-field interpolation from eval(), so that
// the samplers (samplePos / sampleEye / sampleCenter / sampleTangents / ...)
// can write into caller buffers without touching the cursor state.
//
// The field name and its associated tangent field names are passed as keys
// so the same core serves 'pos'/'tanIn'/'tanOut' for PoseTrack and
// 'eye'|'center' + matching tangent keys for CameraTrack.

/**
 * Sample interpolated vec3 path at (seg, t) into out.
 * @private
 * @param {number[]} out
 * @param {Array} kfs         keyframe array
 * @param {string} interp     'hermite' | 'linear' | 'step'
 * @param {string} field      keyframe property holding the vec3 path point
 * @param {string} tanInName  keyframe property for incoming tangent
 * @param {string} tanOutName keyframe property for outgoing tangent
 * @param {number} seg        segment index
 * @param {number} t          local parameter in [0,1]
 */
function _samplePathCore(out, kfs, interp, field, tanInName, tanOutName, seg, t) {
  const n = kfs.length;
  if (n === 0) { out[0]=0; out[1]=0; out[2]=0; return out; }
  if (n === 1) {
    const p = kfs[0][field];
    out[0]=p[0]; out[1]=p[1]; out[2]=p[2];
    return out;
  }
  const nSeg = n - 1;
  seg = _clampS(seg | 0, 0, nSeg - 1);
  t   = _clamp01(t);
  const k0 = kfs[seg];
  const k1 = kfs[seg + 1];

  if (interp === 'step') {
    const p = k0[field];
    out[0]=p[0]; out[1]=p[1]; out[2]=p[2];
    return out;
  }
  if (interp === 'linear') {
    return lerpVec3(out, k0[field], k1[field], t);
  }

  // hermite (default)
  const p0 = seg > 0      ? kfs[seg - 1][field] : k0[field];
  const p3 = seg + 2 < n  ? kfs[seg + 2][field] : k1[field];
  const m0 = k0[tanOutName] != null ? k0[tanOutName]
           : k0[tanInName]  != null ? k0[tanInName]
           : _crTanOut(_m0, p0, k0[field], k1[field]);
  const m1 = k1[tanInName]  != null ? k1[tanInName]
           : k1[tanOutName] != null ? k1[tanOutName]
           : _crTanIn(_m1, k0[field], k1[field], p3);
  return hermiteVec3(out, k0[field], m0, k1[field], m1, t);
}

/**
 * Write the effective in/out tangents at keyframe i.
 *
 * Stored tanIn/tanOut take precedence, then each mirrors the other when only
 * one is stored, else centripetal Catmull-Rom tangents are auto-computed from
 * neighbours.
 *
 * At endpoints one side has no adjacent segment; that side mirrors the other
 * side's tangent. Callers drawing arrows at endpoints therefore see a vector
 * that matches the curve's derivative into / out of the curve's boundary.
 *
 * @private
 */
function _sampleTangentsCore(outIn, outOut, kfs, field, tanInName, tanOutName, i) {
  const n = kfs.length;
  if (n === 0) {
    outIn[0]=outIn[1]=outIn[2]=0; outOut[0]=outOut[1]=outOut[2]=0;
    return;
  }
  i = _clampS(i | 0, 0, n - 1);
  const ki = kfs[i];
  const hasTI = ki[tanInName]  != null;
  const hasTO = ki[tanOutName] != null;

  // ── outgoing tangent at keyframe i (for segment i → i+1) ──────────────
  if (hasTO) {
    outOut[0]=ki[tanOutName][0]; outOut[1]=ki[tanOutName][1]; outOut[2]=ki[tanOutName][2];
  } else if (hasTI) {
    outOut[0]=ki[tanInName][0];  outOut[1]=ki[tanInName][1];  outOut[2]=ki[tanInName][2];
  } else if (i < n - 1) {
    const k1 = kfs[i + 1];
    const p0 = i > 0 ? kfs[i - 1][field] : ki[field];
    _crTanOut(outOut, p0, ki[field], k1[field]);
  } else {
    outOut[0]=0; outOut[1]=0; outOut[2]=0;  // filled below by mirror
  }

  // ── incoming tangent at keyframe i (for segment i-1 → i) ──────────────
  if (hasTI) {
    outIn[0]=ki[tanInName][0];  outIn[1]=ki[tanInName][1];  outIn[2]=ki[tanInName][2];
  } else if (hasTO) {
    outIn[0]=ki[tanOutName][0]; outIn[1]=ki[tanOutName][1]; outIn[2]=ki[tanOutName][2];
  } else if (i > 0) {
    const k0 = kfs[i - 1];
    const p3 = i + 1 < n ? kfs[i + 1][field] : ki[field];
    _crTanIn(outIn, k0[field], ki[field], p3);
  } else {
    outIn[0]=outOut[0]; outIn[1]=outOut[1]; outIn[2]=outOut[2];
  }

  // Boundary mirror the other way: last keyframe with no stored tangents.
  if (i === n - 1 && !hasTO && !hasTI) {
    outOut[0]=outIn[0]; outOut[1]=outIn[1]; outOut[2]=outIn[2];
  }
}

// =========================================================================
// S3  Transform <-> Mat4
// =========================================================================

/**
 * Write a TRS transform into a column-major mat4.
 * @param {Float32Array|number[]} out  16-element column-major mat4.
 * @param {{ pos:number[], rot:number[], scl:number[] }} xform
 * @returns {Float32Array|number[]} out
 */
export const transformToMat4 = (out, xform) => {
  qToMat4(out, xform.rot);
  const sx=xform.scl[0], sy=xform.scl[1], sz=xform.scl[2];
  out[0]*=sx; out[1]*=sx; out[2]*=sx;
  out[4]*=sy; out[5]*=sy; out[6]*=sy;
  out[8]*=sz; out[9]*=sz; out[10]*=sz;
  out[12]=xform.pos[0]; out[13]=xform.pos[1]; out[14]=xform.pos[2];
  return out;
};

/**
 * Decompose a column-major mat4 into a TRS transform.
 * Assumes no shear. Scale extracted from column lengths.
 * @param {{ pos:number[], rot:number[], scl:number[] }} out
 * @param {Float32Array|number[]} m  Column-major mat4.
 * @returns {{ pos:number[], rot:number[], scl:number[] }} out
 */
export const mat4ToTransform = (out, m) => {
  out.pos[0]=m[12]; out.pos[1]=m[13]; out.pos[2]=m[14];
  const sx=Math.sqrt(m[0]*m[0]+m[1]*m[1]+m[2]*m[2]);
  const sy=Math.sqrt(m[4]*m[4]+m[5]*m[5]+m[6]*m[6]);
  const sz=Math.sqrt(m[8]*m[8]+m[9]*m[9]+m[10]*m[10]);
  out.scl[0]=sx; out.scl[1]=sy; out.scl[2]=sz;
  qFromRotMat3x3(out.rot,
    m[0]/sx,m[4]/sy,m[8]/sz,
    m[1]/sx,m[5]/sy,m[9]/sz,
    m[2]/sx,m[6]/sy,m[10]/sz);
  return out;
};

// =========================================================================
// S4a  Spec parser — PoseTrack
// =========================================================================

const _isNum   = (x) => typeof x === 'number' && Number.isFinite(x);
const _clamp01 = (x) => x < 0 ? 0 : (x > 1 ? 1 : x);
const _clampS  = (x, lo, hi) => x < lo ? lo : (x > hi ? hi : x);

function _parseVec3(v) {
  if (!v) return null;
  if (ArrayBuffer.isView(v) && v.length >= 3) return [v[0], v[1], v[2]];
  if (Array.isArray(v) && v.length >= 3 && v.every(n => typeof n === 'number')) return [v[0], v[1], v[2]];
  if (typeof v === 'object' && 'x' in v) return [v.x || 0, v.y || 0, v.z || 0];
  return null;
}

// Euler: unit axis vectors and the six valid intrinsic orderings.
const _EULER_AXES   = { X:[1,0,0], Y:[0,1,0], Z:[0,0,1] };
const _EULER_ORDERS = new Set(['XYZ','XZY','YXZ','YZX','ZXY','ZYX']);

/**
 * Parse any rotation representation into a unit quaternion [x,y,z,w].
 *
 * Accepted forms:
 *
 *   [x,y,z,w]                        — raw quaternion array
 *   { axis:[x,y,z], angle }          — axis-angle
 *   { dir:[x,y,z], up?:[x,y,z] }     — forward direction (−Z) with optional up
 *   { mat4Eye: mat4 }                — rotation block of an eye matrix
 *   { mat3: mat3 }                   — column-major 3×3 rotation matrix
 *   { euler:[rx,ry,rz], order? }     — intrinsic Euler (default order: YXZ)
 *   { from:[x,y,z], to:[x,y,z] }     — shortest-arc rotation
 *
 * @param {*} v
 * @returns {number[]|null}  [x,y,z,w] or null if unparseable.
 */
function _parseQuat(v) {
  if (!v) return null;

  // Raw array [x,y,z,w]
  if (Array.isArray(v) && v.length === 4) return [v[0],v[1],v[2],v[3]];
  if (ArrayBuffer.isView(v) && v.length >= 4) return [v[0],v[1],v[2],v[3]];

  if (typeof v !== 'object') return null;

  // { axis, angle }
  if (v.axis != null && v.angle != null) {
    const ax = Array.isArray(v.axis) ? v.axis : [v.axis.x||0, v.axis.y||0, v.axis.z||0];
    return qFromAxisAngle([0,0,0,1], ax[0],ax[1],ax[2], v.angle);
  }

  // { dir, up? }
  if (v.dir != null) {
    const d = Array.isArray(v.dir) ? v.dir : [v.dir.x||0, v.dir.y||0, v.dir.z||0];
    const u = v.up ? (Array.isArray(v.up) ? v.up : [v.up.x||0, v.up.y||0, v.up.z||0]) : null;
    return qFromLookDir([0,0,0,1], d, u);
  }

  // { mat4Eye }
  if (v.mat4Eye != null) {
    const m = (ArrayBuffer.isView(v.mat4Eye) || Array.isArray(v.mat4Eye))
      ? v.mat4Eye : (v.mat4Eye.mat4 ?? null);
    if (!m || m.length < 16) return null;
    return qFromRotMat3x3([0,0,0,1], m[0],m[4],m[8], m[1],m[5],m[9], m[2],m[6],m[10]);
  }

  // { mat3 }
  if (v.mat3 != null) {
    const m = (ArrayBuffer.isView(v.mat3) || Array.isArray(v.mat3))
      ? v.mat3 : null;
    if (!m || m.length < 9) return null;
    return qFromRotMat3x3([0,0,0,1], m[0],m[3],m[6], m[1],m[4],m[7], m[2],m[5],m[8]);
  }

  // { euler, order? }
  if (v.euler != null) {
    const e = v.euler;
    if (!Array.isArray(e) || e.length < 3) return null;
    const order = (v.order && _EULER_ORDERS.has(v.order)) ? v.order : 'YXZ';
    const q = [0,0,0,1];
    const s = [0,0,0,1];
    for (let i = 0; i < 3; i++) {
      const ax = _EULER_AXES[order[i]];
      qMul(q, q, qFromAxisAngle(s, ax[0],ax[1],ax[2], e[i]));
    }
    return q;
  }

  // { from, to }
  if (v.from != null && v.to != null) {
    const f = Array.isArray(v.from) ? v.from : [v.from.x||0, v.from.y||0, v.from.z||0];
    const t = Array.isArray(v.to)   ? v.to   : [v.to.x||0,   v.to.y||0,   v.to.z||0];
    const fl = Math.sqrt(f[0]*f[0]+f[1]*f[1]+f[2]*f[2]) || 1;
    const tl = Math.sqrt(t[0]*t[0]+t[1]*t[1]+t[2]*t[2]) || 1;
    const fx=f[0]/fl, fy=f[1]/fl, fz=f[2]/fl;
    const tx=t[0]/tl, ty=t[1]/tl, tz=t[2]/tl;
    const dot = fx*tx + fy*ty + fz*tz;
    if (dot >= 1 - 1e-8) return [0,0,0,1];
    if (dot <= -1 + 1e-8) {
      let px=0, py=fz, pz=-fy;
      let pl = Math.sqrt(px*px+py*py+pz*pz);
      if (pl < 1e-8) { px=fy; py=-fx; pz=0; pl = Math.sqrt(px*px+py*py+pz*pz); }
      if (pl < 1e-8) return [0,0,0,1];
      return qFromAxisAngle([0,0,0,1], px/pl,py/pl,pz/pl, Math.PI);
    }
    let ax=fy*tz-fz*ty, ay=fz*tx-fx*tz, az=fx*ty-fy*tx;
    const al = Math.sqrt(ax*ax+ay*ay+az*az) || 1;
    return qFromAxisAngle([0,0,0,1], ax/al,ay/al,az/al,
      Math.acos(Math.max(-1, Math.min(1, dot))));
  }

  return null;
}

/**
 * Parse a PoseTrack keyframe spec.
 *
 * Accepted forms:
 *
 *   { mat4Model }
 *     Decompose a column-major mat4 into TRS via mat4ToTransform.
 *     Float32Array(16), plain Array, or { mat4 } wrapper.
 *
 *   { pos?, rot?, scl?, tanIn?, tanOut? }
 *     Explicit TRS.  pos and scl are vec3, rot accepts any form from _parseQuat.
 *     All fields are optional — missing pos/scl default to [0,0,0] / [1,1,1],
 *     missing rot defaults to identity.
 *     tanIn/tanOut are optional vec3 tangents for Hermite interpolation.
 *
 * @param {Object} spec
 * @returns {{ pos:number[], rot:number[], scl:number[], tanIn:number[]|null, tanOut:number[]|null }|null}
 */
function _parseSpec(spec) {
  if (!spec || typeof spec !== 'object') return null;

  // { mat4Model } — full TRS decomposition from model matrix
  if (spec.mat4Model != null) {
    const m = (ArrayBuffer.isView(spec.mat4Model) || Array.isArray(spec.mat4Model))
      ? spec.mat4Model : (spec.mat4Model.mat4 ?? null);
    if (!m || m.length < 16) return null;
    const kf = mat4ToTransform({ pos:[0,0,0], rot:[0,0,0,1], scl:[1,1,1] }, m);
    kf.tanIn = null; kf.tanOut = null;
    return kf;
  }

  const pos    = _parseVec3(spec.pos)    || [0,0,0];
  const rot    = _parseQuat(spec.rot)    || [0,0,0,1];
  const scl    = _parseVec3(spec.scl)    || [1,1,1];
  const tanIn  = _parseVec3(spec.tanIn)  || null;
  const tanOut = _parseVec3(spec.tanOut) || null;
  return { pos, rot, scl, tanIn, tanOut };
}

function _sameTransform(a, b) {
  for (let i=0;i<3;i++) if (a.pos[i]!==b.pos[i]||a.scl[i]!==b.scl[i]) return false;
  for (let i=0;i<4;i++) if (a.rot[i]!==b.rot[i]) return false;
  return true;
}

// =========================================================================
// S4b  Spec parser — CameraTrack
// =========================================================================

/**
 * Parse a camera keyframe spec into internal { eye, center, up } form.
 *
 * Accepted forms:
 *
 *   { eye, center?, up?, fov?, halfHeight?,
 *     eyeTanIn?, eyeTanOut?, centerTanIn?, centerTanOut? }
 *     Explicit lookat.  center defaults to [0,0,0], up defaults to [0,1,0].
 *     eyeTanIn/Out and centerTanIn/Out are optional vec3 tangents for Hermite.
 *     When absent, centripetal Catmull-Rom tangents are auto-computed at eval time.
 *
 * @param {Object} spec
 * @returns {{ eye:number[], center:number[], up:number[],
 *             fov:number|null, halfHeight:number|null,
 *             eyeTanIn:number[]|null, eyeTanOut:number[]|null,
 *             centerTanIn:number[]|null, centerTanOut:number[]|null }|null}
 */
function _parseCameraSpec(spec) {
  if (!spec || typeof spec !== 'object') return null;

  // { eye, center?, up? } — explicit lookat
  const eye = _parseVec3(spec.eye);
  if (!eye) return null;
  const center = _parseVec3(spec.center) || [0,0,0];
  const upRaw  = spec.up ? _parseVec3(spec.up) : null;
  const up     = upRaw || [0,1,0];
  const ul     = Math.sqrt(up[0]*up[0]+up[1]*up[1]+up[2]*up[2]) || 1;
  return {
    eye, center,
    up: [up[0]/ul, up[1]/ul, up[2]/ul],
    fov:          typeof spec.fov        === 'number' ? spec.fov        : null,
    halfHeight:   typeof spec.halfHeight === 'number' ? spec.halfHeight : null,
    eyeTanIn:     _parseVec3(spec.eyeTanIn)    || null,
    eyeTanOut:    _parseVec3(spec.eyeTanOut)   || null,
    centerTanIn:  _parseVec3(spec.centerTanIn) || null,
    centerTanOut: _parseVec3(spec.centerTanOut)|| null,
  };
}

function _sameCameraKeyframe(a, b) {
  for (let i=0;i<3;i++) {
    if (a.eye[i]!==b.eye[i]) return false;
    if (a.center[i]!==b.center[i]) return false;
    if (a.up[i]!==b.up[i]) return false;
  }
  if (a.fov !== b.fov) return false;
  if (a.halfHeight !== b.halfHeight) return false;
  return true;
}

// =========================================================================
// S5  Track — unexported base class (transport machinery only)
// =========================================================================

class Track {
  constructor() {
    /** @type {Array} Keyframe array — shape depends on subclass. */
    this.keyframes = [];
    /** Whether playback is active. @type {boolean} */
    this.playing   = false;
    /** Loop at boundaries. @type {boolean} */
    this.loop      = false;
    /** Ping-pong bounce (independent of loop). @type {boolean} */
    this.bounce    = false;
    /** Frames per segment (≥1). @type {number} */
    this.duration  = 30;
    /** Current segment index. @type {number} */
    this.seg       = 0;
    /** Frame offset within segment (can be fractional). @type {number} */
    this.f         = 0;

    // Internal rate — never directly starts/stops playback
    this._rate = 1;
    // Internal bounce direction: +1 forward, -1 backward.
    this._dir  = 1;
    // Scratch: true once _dir has been flipped in bounce-once mode.
    this._bounced = false;

    // User-space hooks
    /** @type {Function|null} */ this.onPlay = null;
    /** @type {Function|null} */ this.onEnd  = null;
    /** @type {Function|null} */ this.onStop = null;

    // Lib-space hooks (set by host layer, e.g. p5 bridge)
    /** @type {Function|null} */ this._onActivate   = null;
    /** @type {Function|null} */ this._onDeactivate = null;
    // Lib-space event mirrors — set by UI layer (trackUI), never touched by user code
    /** @type {Function|null} */ this._onPlay = null;
    /** @type {Function|null} */ this._onEnd  = null;
    /** @type {Function|null} */ this._onStop = null;
  }

  /** Playback rate. Assigning never starts/stops playback. @type {number} */
  get rate()  { return this._rate; }
  set rate(v) { this._rate = (_isNum(v)) ? v : 1; }

  /** Number of interpolatable segments (keyframes.length − 1, min 0). @type {number} */
  get segments() { return Math.max(0, this.keyframes.length - 1); }

  /**
   * Start or update playback.
   * @param {number|Object} [rateOrOpts]  Numeric rate or options object:
   *   { rate, duration, loop, bounce, onPlay, onEnd, onStop }
   * @returns {Track} this
   */
  play(rateOrOpts) {
    if (this.keyframes.length === 0) return this;

    // One keyframe: snap cursor, no animation
    if (this.keyframes.length === 1) {
      this.seg = 0; this.f = 0;
      return this;
    }

    if (typeof rateOrOpts === 'number' && Number.isFinite(rateOrOpts)) {
      this._rate = rateOrOpts;
    } else if (rateOrOpts && typeof rateOrOpts === 'object') {
      const o = rateOrOpts;
      if (_isNum(o.duration))             this.duration  = Math.max(1, o.duration | 0);
      if ('loop'   in o) this.loop   = !!o.loop;
      if ('bounce' in o) this.bounce = !!o.bounce;
      if (typeof o.onPlay === 'function') this.onPlay   = o.onPlay;
      if (typeof o.onEnd  === 'function') this.onEnd    = o.onEnd;
      if (typeof o.onStop === 'function') this.onStop   = o.onStop;
      if (_isNum(o.rate))                 this._rate    = o.rate;
    }

    const nSeg = this.segments, dur = Math.max(1, this.duration | 0);
    if (this.seg < 0)     this.seg = 0;
    if (this.seg >= nSeg) this.seg = nSeg - 1;
    if (this.f   < 0)     this.f   = 0;
    if (this.f   > dur)   this.f   = dur;

    const wasPlaying = this.playing;
    this.playing = true;
    if (!wasPlaying) {
      this._bounced = false;
      if (typeof this.onPlay === 'function') { try { this.onPlay(this); } catch (_) {} }
      this._onPlay?.();
      this._onActivate?.();
    }
    return this;
  }

  /**
   * Stop playback.
   * @param {boolean} [rewind=false]  Seek to origin after stopping.
   * @returns {Track} this
   */
  stop(rewind) {
    const wasPlaying = this.playing;
    this.playing = false;
    if (wasPlaying) {
      this._bounced = false;
      if (typeof this.onStop === 'function') { try { this.onStop(this); } catch (_) {} }
      this._onStop?.();
      this._onDeactivate?.();
      if (rewind && this.keyframes.length > 1) this.seek(this._rate * this._dir < 0 ? 1 : 0);
    }
    return this;
  }

  /**
   * Clear all keyframes and stop.
   * @returns {Track} this
   */
  reset() {
    const wasPlaying = this.playing;
    this.playing = false;
    if (wasPlaying) {
      if (typeof this.onStop === 'function') { try { this.onStop(this); } catch (_) {} }
      this._onStop?.();
      this._onDeactivate?.();
    }
    this.keyframes.length = 0;
    this.seg = 0; this.f = 0; this._dir = 1; this._bounced = false;
    return this;
  }

  /**
   * Remove the keyframe at index. Adjusts cursor if needed.
   * @param {number} index
   * @returns {boolean}
   */
  remove(index) {
    if (!_isNum(index)) return false;
    const i = index | 0;
    if (i < 0 || i >= this.keyframes.length) return false;
    this.keyframes.splice(i, 1);
    const nSeg = this.segments;
    if (nSeg === 0) { this.seg = 0; this.f = 0; }
    else if (this.seg >= nSeg) { this.seg = nSeg - 1; }
    return true;
  }

  /**
   * Seek to a normalised position [0,1] across the full path.
   * @param {number} t           Normalised time [0, 1].
   * @param {number} [segIndex]  Optional segment override.
   * @returns {Track} this
   */
  seek(t, segIndex) {
    const nSeg = this.segments;
    if (nSeg === 0) { this.seg = 0; this.f = 0; return this; }
    const dur = Math.max(1, this.duration | 0);
    if (_isNum(segIndex)) {
      this.seg = _clampS(segIndex | 0, 0, nSeg - 1);
      this.f   = _clamp01(t) * dur;
    } else {
      this._setCursorFromScalar(_clamp01(t) * nSeg * dur);
    }
    return this;
  }

  /**
   * Normalised playback position [0,1].
   * @returns {number}
   */
  time() {
    const nSeg = this.segments;
    if (nSeg === 0) return 0;
    const dur = Math.max(1, this.duration | 0);
    return _clamp01((this.seg * dur + this.f) / (nSeg * dur));
  }

  /**
   * Snapshot of transport state.
   * @returns {Object}
   */
  info() {
    return {
      keyframes: this.keyframes.length,
      segments:  this.segments,
      seg:       this.seg,
      f:         this.f,
      playing:   this.playing,
      loop:      this.loop,
      bounce:    this.bounce,
      rate:      this._rate,
      duration:  this.duration,
      time:      this.segments > 0 ? this.time() : 0
    };
  }

  /**
   * Advance cursor by rate frames.
   * Returns true while playing, false when stopping.
   * @returns {boolean}
   */
  tick() {
    if (!this.playing) return false;
    const nSeg = this.segments;
    if (nSeg === 0) {
      this.playing = false; this._onDeactivate?.(); return false;
    }
    if (this._rate === 0) return true;

    const dur   = Math.max(1, this.duration | 0);
    const total = nSeg * dur;
    const s     = _clampS(this.seg * dur + this.f, 0, total);
    const next  = s + this._rate * this._dir;

    // ── loop:true, bounce:true — bounce forever ───────────────────────────
    if (this.loop && this.bounce) {
      let pos = next, flips = 0;
      while (pos < 0 || pos > total) {
        if (pos < 0) { pos = -pos; flips++; }
        else         { pos = 2 * total - pos; flips++; }
      }
      if (flips & 1) this._dir = -this._dir;
      this._setCursorFromScalar(pos);
      return true;
    }

    // ── loop:false, bounce:true — bounce once, stop at origin ────────────
    if (!this.loop && this.bounce) {
      if (next >= total) {
        this._setCursorFromScalar(Math.min(total, 2 * total - next));
        this._dir = -this._dir;
        this._bounced = true;
        return true;
      }
      if (next <= 0) {
        this._setCursorFromScalar(0);
        this.playing = false;
        this._dir = 1; this._bounced = false;
        if (typeof this.onEnd === 'function') { try { this.onEnd(this); } catch (_) {} }
        this._onEnd?.();
        this._onDeactivate?.();
        return false;
      }
      this._setCursorFromScalar(next);
      return true;
    }

    // ── loop:true, bounce:false — repeat forever ──────────────────────────
    if (this.loop) {
      this._setCursorFromScalar(((next % total) + total) % total);
      return true;
    }

    // ── loop:false, bounce:false — play once, stop at boundary ───────────
    if (next <= 0) {
      this._setCursorFromScalar(0);
      this.playing = false;
      if (typeof this.onEnd === 'function') { try { this.onEnd(this); } catch (_) {} }
      this._onEnd?.();
      this._onDeactivate?.();
      return false;
    }
    if (next >= total) {
      this._setCursorFromScalar(total);
      this.playing = false;
      if (typeof this.onEnd === 'function') { try { this.onEnd(this); } catch (_) {} }
      this._onEnd?.();
      this._onDeactivate?.();
      return false;
    }

    this._setCursorFromScalar(next);
    return true;
  }

  /** @private */
  _setCursorFromScalar(s) {
    const dur  = Math.max(1, this.duration | 0);
    const nSeg = this.segments;
    this.seg = Math.floor(s / dur);
    this.f   = s - this.seg * dur;
    if (this.seg >= nSeg) { this.seg = nSeg - 1; this.f = dur; }
    if (this.seg < 0)     { this.seg = 0;         this.f = 0;   }
  }
}

// =========================================================================
// S6  PoseTrack
// =========================================================================

/**
 * Renderer-agnostic TRS keyframe track.
 *
 * Keyframe shape: { pos:[x,y,z], rot:[x,y,z,w], scl:[x,y,z],
 *                   tanIn?:[x,y,z], tanOut?:[x,y,z] }
 *
 * tanIn  — incoming position tangent at this keyframe (Hermite mode).
 * tanOut — outgoing position tangent at this keyframe (Hermite mode).
 * When only one is supplied, the other mirrors it.
 * When neither is supplied, centripetal Catmull-Rom tangents are auto-computed.
 */
export class PoseTrack extends Track {
  constructor() {
    super();
    /**
     * Position interpolation mode.
     * - 'hermite' — cubic Hermite; auto-computes centripetal Catmull-Rom tangents
     *               when none are stored (default)
     * - 'linear'  — lerp
     * - 'step'    — snap to k0; useful for discrete state changes
     * @type {'hermite'|'linear'|'step'}
     */
    this.posInterp = 'hermite';
    /**
     * Rotation interpolation mode.
     * - 'slerp'  — constant angular velocity (default)
     * - 'nlerp'  — normalised lerp; cheaper, slightly non-constant speed
     * - 'step'   — snap to k0 quaternion; useful for discrete state changes
     * @type {'slerp'|'nlerp'|'step'}
     */
    this.rotInterp = 'slerp';
    // Scratch for toMatrix() — avoids hot-path allocations
    this._pos = [0,0,0];
    this._rot = [0,0,0,1];
    this._scl = [1,1,1];
  }

  /**
   * Append one or more keyframes. Adjacent duplicates are skipped by default.
   * @param {Object|Object[]} spec
   * @param {{ deduplicate?: boolean }} [opts]
   */
  add(spec, opts) {
    if (Array.isArray(spec)) {
      for (const s of spec) this.add(s, opts);
      return;
    }
    const kf = _parseSpec(spec);
    if (!kf) return;
    const dedup = !opts || opts.deduplicate !== false;
    if (dedup && this.keyframes.length > 0) {
      if (_sameTransform(this.keyframes[this.keyframes.length - 1], kf)) return;
    }
    this.keyframes.push(kf);
  }

  /**
   * Replace (or append at end) the keyframe at index.
   * @param {number} index
   * @param {Object} spec
   * @returns {boolean}
   */
  set(index, spec) {
    if (!_isNum(index)) return false;
    const i = index | 0, kf = _parseSpec(spec);
    if (!kf || i < 0 || i > this.keyframes.length) return false;
    if (i === this.keyframes.length) this.keyframes.push(kf);
    else this.keyframes[i] = kf;
    return true;
  }

  /**
   * Sample the position path at (seg, t).
   *
   * Pure function of the keyframes — does not read or modify the transport
   * cursor, fires no hooks, allocates nothing.  seg is clamped to
   * [0, segments-1] and t to [0, 1].
   *
   * @param {number[]} out  3-element result buffer.
   * @param {number} seg    Segment index.
   * @param {number} t      Local parameter in [0, 1].
   * @returns {number[]} out
   */
  samplePos(out, seg, t) {
    return _samplePathCore(out, this.keyframes, this.posInterp, 'pos', 'tanIn', 'tanOut', seg, t);
  }

  /**
   * Write the effective incoming / outgoing tangents at keyframe i.
   * Stored tanIn/tanOut take precedence, then each mirrors the other when
   * only one is stored, else centripetal Catmull-Rom tangents are auto-
   * computed from neighbours.  Endpoint tangents mirror across the missing
   * side so drawing arrows at boundary keyframes produces a visible vector.
   *
   * @param {number[]} outIn   3-element result — incoming tangent at kf i.
   * @param {number[]} outOut  3-element result — outgoing tangent at kf i.
   * @param {number} i         Keyframe index.
   * @returns {PoseTrack} this
   */
  sampleTangents(outIn, outOut, i) {
    _sampleTangentsCore(outIn, outOut, this.keyframes, 'pos', 'tanIn', 'tanOut', i);
    return this;
  }

  /**
   * Evaluate interpolated TRS pose at current cursor.
   * @param {{ pos:number[], rot:number[], scl:number[] }} [out]
   * @returns {{ pos:number[], rot:number[], scl:number[] }} out
   */
  eval(out) {
    out = out || { pos:[0,0,0], rot:[0,0,0,1], scl:[1,1,1] };
    const n = this.keyframes.length;
    if (n === 0) return out;

    if (n === 1) {
      const k = this.keyframes[0];
      out.pos[0]=k.pos[0]; out.pos[1]=k.pos[1]; out.pos[2]=k.pos[2];
      out.rot[0]=k.rot[0]; out.rot[1]=k.rot[1]; out.rot[2]=k.rot[2]; out.rot[3]=k.rot[3];
      out.scl[0]=k.scl[0]; out.scl[1]=k.scl[1]; out.scl[2]=k.scl[2];
      return out;
    }

    const nSeg = n - 1;
    const dur  = Math.max(1, this.duration | 0);
    const seg  = _clampS(this.seg, 0, nSeg - 1);
    const t    = _clamp01(this.f / dur);
    const k0   = this.keyframes[seg];
    const k1   = this.keyframes[seg + 1];

    // pos — shared sampler (respects posInterp + tangent fallback chain)
    _samplePathCore(out.pos, this.keyframes, this.posInterp, 'pos', 'tanIn', 'tanOut', seg, t);

    // rot — step, slerp, or nlerp
    if (this.rotInterp === 'step') {
      out.rot[0]=k0.rot[0]; out.rot[1]=k0.rot[1]; out.rot[2]=k0.rot[2]; out.rot[3]=k0.rot[3];
    } else if (this.rotInterp === 'nlerp') {
      qNlerp(out.rot, k0.rot, k1.rot, t);
    } else {
      qSlerp(out.rot, k0.rot, k1.rot, t);
    }

    // scl — lerp
    lerpVec3(out.scl, k0.scl, k1.scl, t);

    return out;
  }

  /**
   * Evaluate into an existing column-major mat4.
   * @param {Float32Array|number[]} outMat4  16-element array.
   * @returns {Float32Array|number[]} outMat4
   */
  toMatrix(outMat4) {
    const xf = this.eval({ pos: this._pos, rot: this._rot, scl: this._scl });
    return transformToMat4(outMat4, xf);
  }
}

// =========================================================================
// S7  CameraTrack
// =========================================================================

/**
 * Lookat camera keyframe track.
 *
 * Keyframe shape: { eye:[x,y,z], center:[x,y,z], up:[x,y,z],
 *                   fov?:number, halfHeight?:number,
 *                   eyeTanIn?:[x,y,z], eyeTanOut?:[x,y,z],
 *                   centerTanIn?:[x,y,z], centerTanOut?:[x,y,z] }
 *
 * fov        — vertical fov (radians) for perspective cameras; null for ortho.
 * halfHeight — world-unit half-height of ortho frustum; null for perspective.
 * Both are optional and nullable. eval() lerps each only when both adjacent
 * keyframes carry a non-null value for that field.
 *
 * eyeTanIn/Out and centerTanIn/Out are optional vec3 tangents for Hermite
 * interpolation of the eye and center paths respectively.
 * When absent, centripetal Catmull-Rom tangents are auto-computed at eval time.
 *
 * Missing fields default to: center → [0,0,0], up → [0,1,0].
 *
 * add() accepts individual specs or a bulk array of specs:
 *
 *   { eye, center?, up?, fov?, halfHeight?,
 *     eyeTanIn?, eyeTanOut?, centerTanIn?, centerTanOut? }
 *
 * To capture a matrix-based pose, use PoseTrack.add({ mat4Model: mat4Eye })
 * for full-fidelity including roll, or cam.capturePose() for lookat-style.
 */
export class CameraTrack extends Track {
  constructor() {
    super();
    /**
     * Eye-path interpolation mode.
     * @type {'hermite'|'linear'|'step'}
     */
    this.eyeInterp = 'hermite';
    /**
     * Center-path interpolation mode.
     * @type {'hermite'|'linear'|'step'}
     */
    this.centerInterp = 'linear';
  }

  /**
   * Append one or more camera keyframes. Adjacent duplicates are skipped by default.
   * @param {Object|Object[]} spec
   * @param {{ deduplicate?: boolean }} [opts]
   */
  add(spec, opts) {
    if (Array.isArray(spec)) {
      for (const s of spec) this.add(s, opts);
      return;
    }
    const kf = _parseCameraSpec(spec);
    if (!kf) return;
    const dedup = !opts || opts.deduplicate !== false;
    if (dedup && this.keyframes.length > 0) {
      if (_sameCameraKeyframe(this.keyframes[this.keyframes.length - 1], kf)) return;
    }
    this.keyframes.push(kf);
  }

  /**
   * Replace (or append at end) the camera keyframe at index.
   * @param {number} index
   * @param {Object} spec
   * @returns {boolean}
   */
  set(index, spec) {
    if (!_isNum(index)) return false;
    const i = index | 0, kf = _parseCameraSpec(spec);
    if (!kf || i < 0 || i > this.keyframes.length) return false;
    if (i === this.keyframes.length) this.keyframes.push(kf);
    else this.keyframes[i] = kf;
    return true;
  }

  /**
   * Sample the eye path at (seg, t). See PoseTrack.samplePos for semantics.
   * @param {number[]} out
   * @param {number} seg
   * @param {number} t
   * @returns {number[]} out
   */
  sampleEye(out, seg, t) {
    return _samplePathCore(out, this.keyframes, this.eyeInterp, 'eye', 'eyeTanIn', 'eyeTanOut', seg, t);
  }

  /**
   * Sample the center path at (seg, t). See PoseTrack.samplePos for semantics.
   * @param {number[]} out
   * @param {number} seg
   * @param {number} t
   * @returns {number[]} out
   */
  sampleCenter(out, seg, t) {
    return _samplePathCore(out, this.keyframes, this.centerInterp, 'center', 'centerTanIn', 'centerTanOut', seg, t);
  }

  /**
   * Effective in/out eye tangents at keyframe i. See PoseTrack.sampleTangents.
   * @param {number[]} outIn
   * @param {number[]} outOut
   * @param {number} i
   * @returns {CameraTrack} this
   */
  sampleEyeTangents(outIn, outOut, i) {
    _sampleTangentsCore(outIn, outOut, this.keyframes, 'eye', 'eyeTanIn', 'eyeTanOut', i);
    return this;
  }

  /**
   * Effective in/out center tangents at keyframe i. See PoseTrack.sampleTangents.
   * @param {number[]} outIn
   * @param {number[]} outOut
   * @param {number} i
   * @returns {CameraTrack} this
   */
  sampleCenterTangents(outIn, outOut, i) {
    _sampleTangentsCore(outIn, outOut, this.keyframes, 'center', 'centerTanIn', 'centerTanOut', i);
    return this;
  }

  /**
   * Evaluate interpolated camera pose at current cursor.
   *
   * @param {{ eye:number[], center:number[], up:number[] }} [out]
   * @returns {{ eye:number[], center:number[], up:number[] }} out
   */
  eval(out) {
    out = out || { eye:[0,0,0], center:[0,0,0], up:[0,1,0], fov:null, halfHeight:null };
    const n = this.keyframes.length;
    if (n === 0) return out;

    if (n === 1) {
      const k = this.keyframes[0];
      out.eye[0]=k.eye[0];       out.eye[1]=k.eye[1];       out.eye[2]=k.eye[2];
      out.center[0]=k.center[0]; out.center[1]=k.center[1]; out.center[2]=k.center[2];
      out.up[0]=k.up[0];         out.up[1]=k.up[1];         out.up[2]=k.up[2];
      out.fov        = k.fov;
      out.halfHeight = k.halfHeight;
      return out;
    }

    const nSeg = n - 1;
    const dur  = Math.max(1, this.duration | 0);
    const seg  = _clampS(this.seg, 0, nSeg - 1);
    const t    = _clamp01(this.f / dur);
    const k0   = this.keyframes[seg];
    const k1   = this.keyframes[seg + 1];

    // eye — shared sampler
    _samplePathCore(out.eye, this.keyframes, this.eyeInterp, 'eye', 'eyeTanIn', 'eyeTanOut', seg, t);

    // center — shared sampler
    _samplePathCore(out.center, this.keyframes, this.centerInterp, 'center', 'centerTanIn', 'centerTanOut', seg, t);

    // up — nlerp on unit sphere
    lerpVec3(out.up, k0.up, k1.up, t);
    const ul=Math.sqrt(out.up[0]*out.up[0]+out.up[1]*out.up[1]+out.up[2]*out.up[2])||1;
    out.up[0]/=ul; out.up[1]/=ul; out.up[2]/=ul;

    // fov / halfHeight — lerp when both keyframes carry non-null values
    out.fov = (k0.fov != null && k1.fov != null)
      ? k0.fov + t * (k1.fov - k0.fov) : (k0.fov ?? k1.fov ?? null);
    out.halfHeight = (k0.halfHeight != null && k1.halfHeight != null)
      ? k0.halfHeight + t * (k1.halfHeight - k0.halfHeight)
      : (k0.halfHeight ?? k1.halfHeight ?? null);

    return out;
  }
}
