/**
 * @file Pure quaternion/spline math + PoseTrack state machine.
 * @module tree/track
 * @license GPL-3.0-only
 *
 * Zero dependencies.  No p5, DOM, WebGL, or WebGPU usage.
 * All quaternion operations use flat [x,y,z,w] arrays (w-last = glTF layout).
 * PoseTrack is a pure state machine that stores {pos,rot,scl} keyframes
 * and advances a cursor via tick().
 *
 * ── Exports ──────────────────────────────────────────────────────────────────
 *  Quaternion helpers
 *    qSet qCopy qDot qNormalize qNegate qMul qSlerp
 *    qFromAxisAngle qFromLookDir qFromRotMat3x3 qFromMat4 qToMat4
 *    quatToAxisAngle
 *  Spline / vector helpers
 *    catmullRomVec3  lerpVec3
 *  Transform / mat4 helpers
 *    transformToMat4  mat4ToTransform
 *  Track
 *    PoseTrack
 *
 * ── Hook architecture ─────────────────────────────────────────────────────────
 *  _onActivate / _onDeactivate  — lib-space (underscore, set by host layer)
 *    Fire exactly on playing transitions: false→true / true→false.
 *    Used by the addon to register/unregister from the draw-loop tick set.
 *
 *  onPlay / onEnd / onStop      — user-space (public, set by user)
 *    onPlay : fires in play()  when playback starts   (false→true transition).
 *    onEnd  : fires in tick()  when cursor reaches a natural boundary (once mode).
 *    onStop : fires in stop()  and reset() — explicit, user-initiated deactivation.
 *
 *    onEnd and onStop are mutually exclusive per deactivation event.
 *    To react to any deactivation, chain both.
 *
 *  Firing order:
 *    play()  → onPlay → _onActivate
 *    tick()  → onEnd  → _onDeactivate   (natural boundary, once mode)
 *    stop()  → onStop → _onDeactivate
 *    reset() → onStop → _onDeactivate
 *
 * ── Playback semantics (rate) ─────────────────────────────────────────────────
 *  rate > 0   forward playback
 *  rate < 0   backward playback
 *  rate === 0 frozen: tick() is a no-op; the playing flag is NOT changed.
 *
 *  play()  is the sole method that sets playing = true.
 *  stop()  is the sole method that sets playing = false.
 *  Assigning rate never implicitly starts or stops playback.
 *
 * ── One-keyframe behaviour ────────────────────────────────────────────────────
 *  play() with exactly one keyframe snaps eval() to that keyframe without
 *  setting playing = true and without animating.
 */

'use strict';

// =========================================================================
// S1  Quaternion helpers  (flat [x, y, z, w], w-last)
// =========================================================================

/** Set all four components. @returns {number[]} out */
export const qSet = (out, x, y, z, w) => {
  out[0] = x; out[1] = y; out[2] = z; out[3] = w; return out;
};

/** Copy quaternion a into out. @returns {number[]} out */
export const qCopy = (out, a) => {
  out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3]; return out;
};

/** Dot product of two quaternions. */
export const qDot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2] + a[3]*b[3];

/** Normalise in-place. @returns {number[]} out */
export const qNormalize = (out) => {
  const len = Math.sqrt(qDot(out, out)) || 1;
  out[0] /= len; out[1] /= len; out[2] /= len; out[3] /= len;
  return out;
};

/** Negate all components in-place. @returns {number[]} out */
export const qNegate = (out) => {
  out[0] = -out[0]; out[1] = -out[1]; out[2] = -out[2]; out[3] = -out[3];
  return out;
};

/** out = a * b (Hamilton product). @returns {number[]} out */
export const qMul = (out, a, b) => {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3];
  const bx = b[0], by = b[1], bz = b[2], bw = b[3];
  out[0] = aw*bx + ax*bw + ay*bz - az*by;
  out[1] = aw*by - ax*bz + ay*bw + az*bx;
  out[2] = aw*bz + ax*by - ay*bx + az*bw;
  out[3] = aw*bw - ax*bx - ay*by - az*bz;
  return out;
};

/**
 * SLERP between quaternions a and b at parameter t.
 * Shortest-arc: negates b when dot < 0.
 * Near-equal fallback: nlerp when dot ~= 1.
 * @param {number[]} out  4-element result array.
 * @param {number[]} a    Start quaternion [x,y,z,w].
 * @param {number[]} b    End quaternion [x,y,z,w].
 * @param {number}   t    Blend [0, 1].
 * @returns {number[]} out
 */
export const qSlerp = (out, a, b, t) => {
  let d = qDot(a, b);
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];
  if (d < 0) { d = -d; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  if (d > 0.9995) {
    out[0] = a[0] + t*(bx - a[0]);
    out[1] = a[1] + t*(by - a[1]);
    out[2] = a[2] + t*(bz - a[2]);
    out[3] = a[3] + t*(bw - a[3]);
    return qNormalize(out);
  }
  const theta = Math.acos(d), sinT = Math.sin(theta);
  const s0 = Math.sin((1 - t) * theta) / sinT;
  const s1 = Math.sin(t * theta) / sinT;
  out[0] = s0*a[0] + s1*bx;
  out[1] = s0*a[1] + s1*by;
  out[2] = s0*a[2] + s1*bz;
  out[3] = s0*a[3] + s1*bw;
  return out;
};

/**
 * Build a quaternion from an axis-angle rotation.
 * The axis need not be normalised.
 * @param {number[]} out
 * @param {number} ax  Axis x.
 * @param {number} ay  Axis y.
 * @param {number} az  Axis z.
 * @param {number} angle  Radians.
 * @returns {number[]} out
 */
export const qFromAxisAngle = (out, ax, ay, az, angle) => {
  const half = angle * 0.5;
  const s    = Math.sin(half);
  const len  = Math.sqrt(ax*ax + ay*ay + az*az) || 1;
  out[0] = s * ax / len;
  out[1] = s * ay / len;
  out[2] = s * az / len;
  out[3] = Math.cos(half);
  return out;
};

/**
 * Build a quaternion from a look direction (negative-Z forward convention)
 * and an optional up vector (defaults to +Y).
 * @param {number[]} out
 * @param {number[]} dir  Forward direction [x,y,z].
 * @param {number[]} [up] Up vector [x,y,z].
 * @returns {number[]} out
 */
export const qFromLookDir = (out, dir, up) => {
  let fx = dir[0], fy = dir[1], fz = dir[2];
  const fLen = Math.sqrt(fx*fx + fy*fy + fz*fz) || 1;
  fx /= fLen; fy /= fLen; fz /= fLen;
  let ux = up ? up[0] : 0, uy = up ? up[1] : 1, uz = up ? up[2] : 0;
  let rx = uy*fz - uz*fy, ry = uz*fx - ux*fz, rz = ux*fy - uy*fx;
  const rLen = Math.sqrt(rx*rx + ry*ry + rz*rz) || 1;
  rx /= rLen; ry /= rLen; rz /= rLen;
  ux = fy*rz - fz*ry; uy = fz*rx - fx*rz; uz = fx*ry - fy*rx;
  return qFromRotMat3x3(out, rx, ry, rz, ux, uy, uz, -fx, -fy, -fz);
};

/**
 * Build a quaternion from a 3x3 rotation matrix supplied as 9 row-major scalars.
 * @returns {number[]} out (normalised)
 */
export const qFromRotMat3x3 = (out, m00, m01, m02, m10, m11, m12, m20, m21, m22) => {
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    out[3] = 0.25 / s;
    out[0] = (m21 - m12) * s;
    out[1] = (m02 - m20) * s;
    out[2] = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    out[3] = (m21 - m12) / s;
    out[0] = 0.25 * s;
    out[1] = (m01 + m10) / s;
    out[2] = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    out[3] = (m02 - m20) / s;
    out[0] = (m01 + m10) / s;
    out[1] = 0.25 * s;
    out[2] = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    out[3] = (m10 - m01) / s;
    out[0] = (m02 + m20) / s;
    out[1] = (m12 + m21) / s;
    out[2] = 0.25 * s;
  }
  return qNormalize(out);
};

/**
 * Extract a unit quaternion from the upper-left 3x3 of a column-major mat4.
 * @param {number[]} out
 * @param {Float32Array|number[]} m  Column-major mat4.
 * @returns {number[]} out
 */
export const qFromMat4 = (out, m) =>
  qFromRotMat3x3(out, m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]);

/**
 * Write a quaternion into a column-major mat4 (rotation block only;
 * translation and perspective rows/cols are set to identity values).
 * @param {Float32Array|number[]} out  16-element array.
 * @param {number[]} q  [x,y,z,w].
 * @returns {Float32Array|number[]} out
 */
export const qToMat4 = (out, q) => {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const x2 = x+x, y2 = y+y, z2 = z+z;
  const xx = x*x2, xy = x*y2, xz = x*z2;
  const yy = y*y2, yz = y*z2, zz = z*z2;
  const wx = w*x2, wy = w*y2, wz = w*z2;
  out[0]  = 1-(yy+zz); out[1]  = xy+wz;     out[2]  = xz-wy;     out[3]  = 0;
  out[4]  = xy-wz;     out[5]  = 1-(xx+zz); out[6]  = yz+wx;     out[7]  = 0;
  out[8]  = xz+wy;     out[9]  = yz-wx;     out[10] = 1-(xx+yy); out[11] = 0;
  out[12] = 0;         out[13] = 0;         out[14] = 0;          out[15] = 1;
  return out;
};

/**
 * Decompose a unit quaternion into { axis:[x,y,z], angle } (radians).
 * @param {number[]} q  [x,y,z,w].
 * @param {Object}  [out]
 * @returns {{ axis: number[], angle: number }}
 */
export const quatToAxisAngle = (q, out) => {
  out = out || {};
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const sinHalf = Math.sqrt(x*x + y*y + z*z);
  if (sinHalf < 1e-8) { out.axis = [0, 1, 0]; out.angle = 0; return out; }
  out.angle = 2 * Math.atan2(sinHalf, w);
  out.axis  = [x / sinHalf, y / sinHalf, z / sinHalf];
  return out;
};

// =========================================================================
// S2  Spline / vector helpers
// =========================================================================

function _dist3(a, b) {
  const dx = a[0]-b[0], dy = a[1]-b[1], dz = a[2]-b[2];
  return Math.sqrt(dx*dx + dy*dy + dz*dz);
}

/**
 * Centripetal Catmull-Rom interpolation (alpha = 0.5, Barry-Goldman).
 * out = interp(p0, p1, p2, p3, t) where t in [0,1] maps p1→p2.
 * Boundary: when p0===p1 or p2===p3 the chord is reused (clamped end tangents).
 * @param {number[]} out  3-element result.
 * @param {number[]} p0   Control point before p1.
 * @param {number[]} p1   Segment start.
 * @param {number[]} p2   Segment end.
 * @param {number[]} p3   Control point after p2.
 * @param {number}   t    Blend [0, 1].
 * @returns {number[]} out
 */
export const catmullRomVec3 = (out, p0, p1, p2, p3, t) => {
  const alpha = 0.5;
  const dt0   = Math.pow(_dist3(p0, p1), alpha) || 1;
  const dt1   = Math.pow(_dist3(p1, p2), alpha) || 1;
  const dt2   = Math.pow(_dist3(p2, p3), alpha) || 1;
  for (let i = 0; i < 3; i++) {
    const t1_0 = (p1[i]-p0[i])/dt0 - (p2[i]-p0[i])/(dt0+dt1) + (p2[i]-p1[i])/dt1;
    const t2_0 = (p2[i]-p1[i])/dt1 - (p3[i]-p1[i])/(dt1+dt2) + (p3[i]-p2[i])/dt2;
    const m1   = t1_0 * dt1;
    const m2   = t2_0 * dt1;
    const a    =  2*p1[i] - 2*p2[i] + m1 + m2;
    const b    = -3*p1[i] + 3*p2[i] - 2*m1 - m2;
    out[i]     = a*t*t*t + b*t*t + m1*t + p1[i];
  }
  return out;
};

/**
 * Linear interpolation between two vec3s.
 * @param {number[]} out
 * @param {number[]} a
 * @param {number[]} b
 * @param {number}   t  Blend [0, 1].
 * @returns {number[]} out
 */
export const lerpVec3 = (out, a, b, t) => {
  out[0] = a[0] + t*(b[0]-a[0]);
  out[1] = a[1] + t*(b[1]-a[1]);
  out[2] = a[2] + t*(b[2]-a[2]);
  return out;
};

// =========================================================================
// S3  Transform <-> Mat4
// =========================================================================

/**
 * Write a TRS transform into a column-major mat4.
 * Rotation is encoded as a quaternion; scale is baked into rotation columns.
 * @param {Float32Array|number[]} out  16-element column-major mat4.
 * @param {{ pos:number[], rot:number[], scl:number[] }} xform
 * @returns {Float32Array|number[]} out
 */
export const transformToMat4 = (out, xform) => {
  qToMat4(out, xform.rot);
  const sx = xform.scl[0], sy = xform.scl[1], sz = xform.scl[2];
  out[0]  *= sx; out[1]  *= sx; out[2]  *= sx;
  out[4]  *= sy; out[5]  *= sy; out[6]  *= sy;
  out[8]  *= sz; out[9]  *= sz; out[10] *= sz;
  out[12] = xform.pos[0];
  out[13] = xform.pos[1];
  out[14] = xform.pos[2];
  return out;
};

/**
 * Decompose a column-major mat4 into a TRS transform.
 * Assumes no shear. Scale is extracted from column lengths.
 * @param {{ pos:number[], rot:number[], scl:number[] }} out
 * @param {Float32Array|number[]} m  Column-major mat4.
 * @returns {{ pos:number[], rot:number[], scl:number[] }} out
 */
export const mat4ToTransform = (out, m) => {
  out.pos[0] = m[12]; out.pos[1] = m[13]; out.pos[2] = m[14];
  const sx = Math.sqrt(m[0]*m[0] + m[1]*m[1] + m[2]*m[2]);
  const sy = Math.sqrt(m[4]*m[4] + m[5]*m[5] + m[6]*m[6]);
  const sz = Math.sqrt(m[8]*m[8] + m[9]*m[9] + m[10]*m[10]);
  out.scl[0] = sx; out.scl[1] = sy; out.scl[2] = sz;
  qFromRotMat3x3(out.rot,
    m[0]/sx, m[4]/sy, m[8]/sz,
    m[1]/sx, m[5]/sy, m[9]/sz,
    m[2]/sx, m[6]/sy, m[10]/sz);
  return out;
};

// =========================================================================
// S4  Spec parser (keyframe input normalisation)
// =========================================================================

const _isNum   = (x) => typeof x === 'number' && Number.isFinite(x);
const _clamp01 = (x) => x < 0 ? 0 : (x > 1 ? 1 : x);
const _clampS  = (x, lo, hi) => x < lo ? lo : (x > hi ? hi : x);

function _parseVec3(v) {
  if (!v) return null;
  if (Array.isArray(v) && v.length >= 3 && v.every(n => typeof n === 'number')) return [v[0], v[1], v[2]];
  if (typeof v === 'object' && 'x' in v) return [v.x || 0, v.y || 0, v.z || 0];
  return null;
}

function _parseQuat(v) {
  if (!v) return null;
  if (Array.isArray(v) && v.length === 4 && v.every(n => typeof n === 'number')) return [v[0], v[1], v[2], v[3]];
  if (v.axis && typeof v.angle === 'number') {
    const a = Array.isArray(v.axis) ? v.axis : [v.axis.x || 0, v.axis.y || 0, v.axis.z || 0];
    return qFromAxisAngle([0, 0, 0, 1], a[0], a[1], a[2], v.angle);
  }
  if (v.dir) {
    const d = Array.isArray(v.dir) ? v.dir : [v.dir.x || 0, v.dir.y || 0, v.dir.z || 0];
    const u = v.up ? (Array.isArray(v.up) ? v.up : [v.up.x || 0, v.up.y || 0, v.up.z || 0]) : null;
    return qFromLookDir([0, 0, 0, 1], d, u);
  }
  return null;
}

function _parseSpec(spec) {
  if (!spec || typeof spec !== 'object') return null;
  const pos = _parseVec3(spec.pos) || [0, 0, 0];
  const rot = _parseQuat(spec.rot) || [0, 0, 0, 1];
  const scl = _parseVec3(spec.scl) || [1, 1, 1];
  return { pos, rot, scl };
}

function _sameTransform(a, b) {
  for (let i = 0; i < 3; i++) if (a.pos[i] !== b.pos[i] || a.scl[i] !== b.scl[i]) return false;
  for (let i = 0; i < 4; i++) if (a.rot[i] !== b.rot[i]) return false;
  return true;
}

// =========================================================================
// S5  PoseTrack
// =========================================================================

/**
 * Renderer-agnostic keyframe animation track.
 *
 * Keyframes are TRS pose objects: { pos:[x,y,z], rot:[x,y,z,w], scl:[x,y,z] }.
 * The track maintains a scalar cursor (seg, f) that advances each tick().
 *
 * Position uses centripetal Catmull-Rom spline by default (posInterp = 'catmullrom');
 * set posInterp = 'linear' to switch to lerp. Rotation uses SLERP. Scale uses LERP.
 *
 * Rate semantics:
 *   rate > 0   forward
 *   rate < 0   backward
 *   rate === 0 frozen: tick() is a no-op; playing is NOT changed
 *
 * Assigning rate never starts or stops playback.
 * Only play() sets playing = true. Only stop() / reset() set it to false.
 *
 * One-keyframe behaviour:
 *   play() with exactly one keyframe snaps eval() to that keyframe
 *   without setting playing = true and without firing hooks.
 *
 * @example
 * const track = new PoseTrack()
 * track.add({ pos:[0,0,0], rot:[0,0,0,1], scl:[1,1,1] })
 * track.add({ pos:[0,100,0], rot:[0,0,0,1], scl:[1,1,1] })
 * track.play({ loop: true, onStop: t => console.log('stopped at', t.time()) })
 */
export class PoseTrack {
  constructor() {
    /** @type {Array<{pos:number[],rot:number[],scl:number[]}>} */
    this.keyframes = [];
    /** Whether playback is active. @type {boolean} */
    this.playing   = false;
    /** Loop flag (overridden by pingPong). @type {boolean} */
    this.loop      = false;
    /** Ping-pong bounce mode (takes precedence over loop). @type {boolean} */
    this.pingPong  = false;
    /** Frames per segment (>=1). @type {number} */
    this.duration  = 30;
    /** Current segment index. @type {number} */
    this.seg       = 0;
    /** Frame offset within current segment (can be fractional). @type {number} */
    this.f         = 0;
    /**
     * Position interpolation mode.
     * @type {'catmullrom'|'linear'}
     */
    this.posInterp = 'catmullrom';

    // Scratch arrays reused by eval() / toMatrix() — avoids hot-path allocations
    this._pos = [0, 0, 0];
    this._rot = [0, 0, 0, 1];
    this._scl = [1, 1, 1];

    // Internal rate — assigning never touches playing
    this._rate = 1;

    // User-space hooks — fired on playback state transitions
    /** Fires when play() starts a false→true transition. @type {Function|null} */
    this.onPlay = null;
    /** Fires in tick() when cursor hits a natural boundary (once mode only). @type {Function|null} */
    this.onEnd  = null;
    /** Fires on explicit stop() or reset(). Mutually exclusive with onEnd per event. @type {Function|null} */
    this.onStop = null;

    // Lib-space hooks (set by host layer — e.g. p5 bridge)
    /** @type {Function|null} */
    this._onActivate   = null;
    /** @type {Function|null} */
    this._onDeactivate = null;
  }

  // ── rate ────────────────────────────────────────────────────────────────
  // Getter/setter so future consumers get the right value from track.rate,
  // while the setter intentionally has NO side effects on playing.

  /** Playback rate. 0 = frozen (playing flag unchanged). @type {number} */
  get rate()  { return this._rate; }
  set rate(v) {
    this._rate = (typeof v === 'number' && Number.isFinite(v)) ? v : 1;
    // Intentionally does NOT start or stop playback.
  }

  /** Number of interpolatable segments (keyframes.length - 1, min 0). @type {number} */
  get segments() { return Math.max(0, this.keyframes.length - 1); }

  // ── Keyframe management ──────────────────────────────────────────────────

  /**
   * Append a keyframe. Adjacent duplicates are skipped by default.
   * @param {{ pos?, rot?, scl? }} spec  pos/rot/scl arrays, {x,y,z}, axis-angle, look-dir.
   * @param {{ deduplicate?: boolean }} [opts]
   */
  add(spec, opts) {
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
   * @param {number} index  Existing index or keyframes.length to append.
   * @param {{ pos?, rot?, scl? }} spec
   * @returns {boolean}
   */
  set(index, spec) {
    if (!_isNum(index)) return false;
    const i  = index | 0;
    const kf = _parseSpec(spec);
    if (!kf || i < 0 || i > this.keyframes.length) return false;
    if (i === this.keyframes.length) { this.keyframes.push(kf); }
    else { this.keyframes[i] = kf; }
    return true;
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

  // ── Transport ────────────────────────────────────────────────────────────

  /**
   * Start or update playback.
   * Accepts a numeric rate or an options object:
   * { rate, duration, loop, pingPong, onPlay, onEnd, onStop }.
   *
   * Zero keyframes: no-op.
   * One keyframe: snaps cursor (seg=0, f=0); no playing=true, no hooks.
   * Already playing: updates params in place; hooks are not re-fired.
   * rate=0 is valid: track will be playing but frozen until rate changes.
   *
   * @param {number|Object} [rateOrOpts]
   * @returns {PoseTrack} this
   */
  play(rateOrOpts) {
    if (this.keyframes.length === 0) return this;

    // One keyframe: snap only, no animation, no hooks
    if (this.keyframes.length === 1) {
      this.seg = 0; this.f = 0;
      return this;
    }

    if (typeof rateOrOpts === 'number' && Number.isFinite(rateOrOpts)) {
      this._rate = rateOrOpts;
    } else if (rateOrOpts && typeof rateOrOpts === 'object') {
      const o = rateOrOpts;
      if (_isNum(o.duration))             this.duration = Math.max(1, o.duration | 0);
      if ('loop'     in o)                this.loop     = !!o.loop;
      if ('pingPong' in o)                this.pingPong = !!o.pingPong;
      if (typeof o.onPlay === 'function') this.onPlay   = o.onPlay;
      if (typeof o.onEnd  === 'function') this.onEnd    = o.onEnd;
      if (typeof o.onStop === 'function') this.onStop   = o.onStop;
      if (_isNum(o.rate))                 this._rate    = o.rate;
    }

    // Clamp cursor into valid range
    const nSeg = this.segments;
    const dur  = Math.max(1, this.duration | 0);
    if (this.seg < 0)     this.seg = 0;
    if (this.seg >= nSeg) this.seg = nSeg - 1;
    if (this.f   < 0)     this.f   = 0;
    if (this.f   > dur)   this.f   = dur;

    const wasPlaying = this.playing;
    this.playing = true;

    if (!wasPlaying) {
      if (typeof this.onPlay === 'function') { try { this.onPlay(this); } catch (_) {} }
      this._onActivate?.();
    }
    return this;
  }

  /**
   * Stop playback. No-op if already stopped.
   * Fires `onStop` → `_onDeactivate`, then optionally seeks to the
   * logical start (rate > 0 → t=0, rate < 0 → t=1).
   * @param {boolean} [rewind=false]  Seek to playback origin after stopping.
   * @returns {PoseTrack} this
   */
  stop(rewind) {
    const wasPlaying = this.playing;
    this.playing = false;
    if (wasPlaying) {
      if (typeof this.onStop === 'function') { try { this.onStop(this); } catch (_) {} }
      this._onDeactivate?.();
      if (rewind && this.keyframes.length > 1) this.seek(this._rate < 0 ? 1 : 0);
    }
    return this;
  }

  /**
   * Clear all keyframes and stop.
   * Fires `onStop` then `_onDeactivate` if was playing.
   * @returns {PoseTrack} this
   */
  reset() {
    const wasPlaying = this.playing;
    this.playing = false;
    if (wasPlaying) {
      if (typeof this.onStop === 'function') { try { this.onStop(this); } catch (_) {} }
      this._onDeactivate?.();
    }
    this.keyframes.length = 0;
    this.seg = 0; this.f = 0;
    return this;
  }

  /**
   * Seek to a normalised position [0,1] across the full path.
   * Can optionally target a specific segment (t is then local to that segment).
   * Does not change the playing flag.
   * @param {number} t           Normalised time [0, 1].
   * @param {number} [segIndex]  Optional segment override.
   * @returns {PoseTrack} this
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
   * Normalised playback time across the full path [0, 1].
   * Returns 0 when fewer than 2 keyframes exist.
   * @returns {number}
   */
  time() {
    const nSeg = this.segments;
    if (nSeg === 0) return 0;
    const dur = Math.max(1, this.duration | 0);
    return _clamp01((this.seg * dur + this.f) / (nSeg * dur));
  }

  /**
   * Snapshot of the current transport state.
   * @returns {{ keyframes:number, segments:number, seg:number, f:number,
   *             time:number, playing:boolean, loop:boolean, pingPong:boolean,
   *             rate:number, duration:number }}
   */
  info() {
    return {
      keyframes: this.keyframes.length,
      segments:  this.segments,
      seg:       this.seg,
      f:         this.f,
      playing:   this.playing,
      loop:      this.loop,
      pingPong:  this.pingPong,
      rate:      this._rate,
      duration:  this.duration,
      time:      this.segments > 0 ? this.time() : 0
    };
  }

  /**
   * Advance the cursor by rate frames.
   *
   * rate === 0: frozen — returns this.playing without moving (no-op).
   * Returns false and fires onEnd → _onDeactivate when a once-mode boundary is hit.
   * Returns true while playing and continuing.
   *
   * @returns {boolean}
   */
  tick() {
    if (!this.playing) return false;
    const nSeg = this.segments;
    if (nSeg === 0) {
      this.playing = false; this._onDeactivate?.(); return false;
    }

    // Frozen: position does not advance, playing stays true
    if (this._rate === 0) return true;

    const dur   = Math.max(1, this.duration | 0);
    const total = nSeg * dur;
    const s     = _clampS(this.seg * dur + this.f, 0, total);
    const next  = s + this._rate;

    // ── pingPong ──
    if (this.pingPong) {
      let pos = next, flips = 0;
      while (pos < 0 || pos > total) {
        if (pos < 0)     { pos = -pos;            flips++; }
        else             { pos = 2 * total - pos; flips++; }
      }
      if (flips & 1) this._rate = -this._rate;
      this._setCursorFromScalar(pos);
      return true;
    }

    // ── loop ──
    if (this.loop) {
      this._setCursorFromScalar(((next % total) + total) % total);
      return true;
    }

    // ── once — boundary check ──
    if (next <= 0) {
      this._setCursorFromScalar(0);
      this.playing = false;
      if (typeof this.onEnd === 'function') { try { this.onEnd(this); } catch (_) {} }
      this._onDeactivate?.();
      return false;
    }
    if (next >= total) {
      this._setCursorFromScalar(total);
      this.playing = false;
      if (typeof this.onEnd === 'function') { try { this.onEnd(this); } catch (_) {} }
      this._onDeactivate?.();
      return false;
    }

    this._setCursorFromScalar(next);
    return true;
  }

  /**
   * Evaluate the interpolated pose at the current cursor into out.
   * If out is omitted a new object is allocated (avoid in hot paths).
   * Uses centripetal Catmull-Rom for position (posInterp === 'catmullrom') or lerp.
   * @param {{ pos:number[], rot:number[], scl:number[] }} [out]
   * @returns {{ pos:number[], rot:number[], scl:number[] }} out
   */
  eval(out) {
    out = out || { pos: [0, 0, 0], rot: [0, 0, 0, 1], scl: [1, 1, 1] };
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

    // Position
    if (this.posInterp === 'catmullrom') {
      const p0 = seg > 0     ? this.keyframes[seg - 1].pos : k0.pos;
      const p3 = seg + 2 < n ? this.keyframes[seg + 2].pos : k1.pos;
      catmullRomVec3(out.pos, p0, k0.pos, k1.pos, p3, t);
    } else {
      lerpVec3(out.pos, k0.pos, k1.pos, t);
    }

    // Rotation — SLERP
    qSlerp(out.rot, k0.rot, k1.rot, t);

    // Scale — LERP
    lerpVec3(out.scl, k0.scl, k1.scl, t);

    return out;
  }

  /**
   * Evaluate the current cursor into an existing column-major mat4.
   * Reuses internal scratch arrays — no allocation per call.
   * @param {Float32Array|number[]} outMat4  16-element array.
   * @returns {Float32Array|number[]} outMat4
   */
  toMatrix(outMat4) {
    const xf = this.eval({ pos: this._pos, rot: this._rot, scl: this._scl });
    return transformToMat4(outMat4, xf);
  }

  // ── Private ──────────────────────────────────────────────────────────────

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
