/**
 * @file Pure quaternion/spline math + PoseTrack state machine.
 * @module tree/track
 * @license GPL-3.0-only
 *
 * Zero dependencies. All quaternion operations use flat [x,y,z,w] arrays
 * (w-last = glTF layout). PoseTrack is a pure state machine that stores
 * {pos, rot, scl} keyframes and advances a cursor via tick().
 *
 * Hook architecture:
 *   _onActivate / _onDeactivate   — lib-space (underscore, set by host layer)
 *     Fire exactly on playing transitions: false->true / true->false.
 *     Used by the addon to register/unregister from the draw-loop tick set.
 *
 *   onPlay / onEnd                — user-space (public, set by user)
 *     onPlay:  fires in play()   when playback actually starts (transition).
 *     onEnd:   fires in tick()   when cursor reaches boundary (natural end).
 *     onEnd does NOT fire on explicit stop()/reset().
 *
 *   Firing order:
 *     play()  -> user onPlay -> lib _onActivate
 *     tick()  -> user onEnd  -> lib _onDeactivate
 *     stop()  ->               lib _onDeactivate  (no user hook)
 *     reset() ->               lib _onDeactivate  (no user hook)
 */

'use strict';

// =========================================================================
// S1  Minimal quaternion helpers  (flat [x, y, z, w])
// =========================================================================

const QUAT_IDENTITY = [0, 0, 0, 1];

export const qSet = (out, x, y, z, w) => { out[0]=x;out[1]=y;out[2]=z;out[3]=w; return out; };
export const qCopy = (out, a) => { out[0]=a[0];out[1]=a[1];out[2]=a[2];out[3]=a[3]; return out; };
export const qDot = (a, b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2]+a[3]*b[3];

export const qNormalize = (out) => {
  const len = Math.sqrt(qDot(out, out)) || 1;
  out[0]/=len;out[1]/=len;out[2]/=len;out[3]/=len;
  return out;
};

export const qNegate = (out) => { out[0]=-out[0];out[1]=-out[1];out[2]=-out[2];out[3]=-out[3]; return out; };

/** out = a * b */
export const qMul = (out, a, b) => {
  const ax=a[0],ay=a[1],az=a[2],aw=a[3];
  const bx=b[0],by=b[1],bz=b[2],bw=b[3];
  out[0]=aw*bx+ax*bw+ay*bz-az*by;
  out[1]=aw*by-ax*bz+ay*bw+az*bx;
  out[2]=aw*bz+ax*by-ay*bx+az*bw;
  out[3]=aw*bw-ax*bx-ay*by-az*bz;
  return out;
};

/**
 * SLERP between quaternions a and b at parameter t.
 * Shortest-arc: negates b if dot < 0.
 * Near-equal fallback: nlerp when dot ~ 1.
 */
export const qSlerp = (out, a, b, t) => {
  let d = qDot(a, b);
  let bx=b[0],by=b[1],bz=b[2],bw=b[3];
  if (d < 0) { d=-d; bx=-bx; by=-by; bz=-bz; bw=-bw; }
  if (d > 0.9995) {
    out[0]=a[0]+t*(bx-a[0]);out[1]=a[1]+t*(by-a[1]);
    out[2]=a[2]+t*(bz-a[2]);out[3]=a[3]+t*(bw-a[3]);
    return qNormalize(out);
  }
  const theta=Math.acos(d), sinT=Math.sin(theta);
  const s0=Math.sin((1-t)*theta)/sinT, s1=Math.sin(t*theta)/sinT;
  out[0]=s0*a[0]+s1*bx;out[1]=s0*a[1]+s1*by;
  out[2]=s0*a[2]+s1*bz;out[3]=s0*a[3]+s1*bw;
  return out;
};

/** Quaternion from axis-angle. */
export const qFromAxisAngle = (out, ax, ay, az, angle) => {
  const half=angle*0.5, s=Math.sin(half);
  const len=Math.sqrt(ax*ax+ay*ay+az*az)||1;
  out[0]=s*ax/len;out[1]=s*ay/len;out[2]=s*az/len;out[3]=Math.cos(half);
  return out;
};

/** Quaternion from a look direction (negative-Z convention) + optional up. */
export const qFromLookDir = (out, dir, up) => {
  let fx=dir[0],fy=dir[1],fz=dir[2];
  let fLen=Math.sqrt(fx*fx+fy*fy+fz*fz)||1;
  fx/=fLen;fy/=fLen;fz/=fLen;
  let ux=up?up[0]:0, uy=up?up[1]:1, uz=up?up[2]:0;
  let rx=uy*fz-uz*fy, ry=uz*fx-ux*fz, rz=ux*fy-uy*fx;
  let rLen=Math.sqrt(rx*rx+ry*ry+rz*rz)||1;
  rx/=rLen;ry/=rLen;rz/=rLen;
  ux=fy*rz-fz*ry; uy=fz*rx-fx*rz; uz=fx*ry-fy*rx;
  return qFromRotMat3x3(out, rx,ry,rz, ux,uy,uz, -fx,-fy,-fz);
};

/** Quaternion from a 3x3 rotation matrix (row-major elements). */
export const qFromRotMat3x3 = (out, m00,m01,m02, m10,m11,m12, m20,m21,m22) => {
  const tr=m00+m11+m22;
  if (tr > 0) {
    const s=0.5/Math.sqrt(tr+1);
    out[3]=0.25/s;out[0]=(m21-m12)*s;out[1]=(m02-m20)*s;out[2]=(m10-m01)*s;
  } else if (m00>m11 && m00>m22) {
    const s=2*Math.sqrt(1+m00-m11-m22);
    out[3]=(m21-m12)/s;out[0]=0.25*s;out[1]=(m01+m10)/s;out[2]=(m02+m20)/s;
  } else if (m11>m22) {
    const s=2*Math.sqrt(1+m11-m00-m22);
    out[3]=(m02-m20)/s;out[0]=(m01+m10)/s;out[1]=0.25*s;out[2]=(m12+m21)/s;
  } else {
    const s=2*Math.sqrt(1+m22-m00-m11);
    out[3]=(m10-m01)/s;out[0]=(m02+m20)/s;out[1]=(m12+m21)/s;out[2]=0.25*s;
  }
  return qNormalize(out);
};

/** Extract quaternion from a column-major mat4 (upper-left 3x3). */
export const qFromMat4 = (out, m) =>
  qFromRotMat3x3(out, m[0],m[4],m[8], m[1],m[5],m[9], m[2],m[6],m[10]);

/** Write a quaternion into a column-major mat4 (rotation only, no scale/translate). */
export const qToMat4 = (out, q) => {
  const x=q[0],y=q[1],z=q[2],w=q[3];
  const x2=x+x,y2=y+y,z2=z+z;
  const xx=x*x2,xy=x*y2,xz=x*z2;
  const yy=y*y2,yz=y*z2,zz=z*z2;
  const wx=w*x2,wy=w*y2,wz=w*z2;
  out[0]=1-(yy+zz);out[1]=xy+wz;    out[2]=xz-wy;    out[3]=0;
  out[4]=xy-wz;    out[5]=1-(xx+zz);out[6]=yz+wx;    out[7]=0;
  out[8]=xz+wy;    out[9]=yz-wx;    out[10]=1-(xx+yy);out[11]=0;
  out[12]=0;        out[13]=0;       out[14]=0;        out[15]=1;
  return out;
};

/** Convert quaternion to { axis:[x,y,z], angle } (radians). */
export const quatToAxisAngle = (q, out) => {
  out = out || {};
  const x=q[0],y=q[1],z=q[2],w=q[3];
  const sinHalf=Math.sqrt(x*x+y*y+z*z);
  if (sinHalf < 1e-8) { out.axis=[0,1,0]; out.angle=0; return out; }
  out.angle=2*Math.atan2(sinHalf, w);
  out.axis=[x/sinHalf, y/sinHalf, z/sinHalf];
  return out;
};

// =========================================================================
// S2  Spline helpers
// =========================================================================

function _dist2(a, b) {
  const dx=a[0]-b[0],dy=a[1]-b[1],dz=a[2]-b[2];
  return Math.sqrt(dx*dx+dy*dy+dz*dz);
}

/**
 * Centripetal Catmull-Rom (alpha=0.5, Barry-Goldman).
 * out = interp(p0, p1, p2, p3, t), where t in [0,1] maps p1 -> p2.
 */
export const catmullRomVec3 = (out, p0, p1, p2, p3, t) => {
  const alpha = 0.5;
  const dt0 = Math.pow(_dist2(p0, p1), alpha) || 1;
  const dt1 = Math.pow(_dist2(p1, p2), alpha) || 1;
  const dt2 = Math.pow(_dist2(p2, p3), alpha) || 1;
  for (let i = 0; i < 3; i++) {
    const t1_0 = (p1[i]-p0[i])/dt0 - (p2[i]-p0[i])/(dt0+dt1) + (p2[i]-p1[i])/dt1;
    const t2_0 = (p2[i]-p1[i])/dt1 - (p3[i]-p1[i])/(dt1+dt2) + (p3[i]-p2[i])/dt2;
    const m1 = t1_0 * dt1;
    const m2 = t2_0 * dt1;
    const a = 2*p1[i] - 2*p2[i] + m1 + m2;
    const b = -3*p1[i] + 3*p2[i] - 2*m1 - m2;
    out[i] = a*t*t*t + b*t*t + m1*t + p1[i];
  }
  return out;
};

export const lerpVec3 = (out, a, b, t) => {
  out[0]=a[0]+t*(b[0]-a[0]);
  out[1]=a[1]+t*(b[1]-a[1]);
  out[2]=a[2]+t*(b[2]-a[2]);
  return out;
};

// =========================================================================
// S3  Transform <-> Mat4
// =========================================================================

export const transformToMat4 = (out, xform) => {
  qToMat4(out, xform.rot);
  const sx=xform.scl[0],sy=xform.scl[1],sz=xform.scl[2];
  out[0]*=sx;out[1]*=sx;out[2]*=sx;
  out[4]*=sy;out[5]*=sy;out[6]*=sy;
  out[8]*=sz;out[9]*=sz;out[10]*=sz;
  out[12]=xform.pos[0];out[13]=xform.pos[1];out[14]=xform.pos[2];
  return out;
};

export const mat4ToTransform = (out, m) => {
  out.pos[0]=m[12];out.pos[1]=m[13];out.pos[2]=m[14];
  const sx=Math.sqrt(m[0]*m[0]+m[1]*m[1]+m[2]*m[2]);
  const sy=Math.sqrt(m[4]*m[4]+m[5]*m[5]+m[6]*m[6]);
  const sz=Math.sqrt(m[8]*m[8]+m[9]*m[9]+m[10]*m[10]);
  out.scl[0]=sx;out.scl[1]=sy;out.scl[2]=sz;
  qFromRotMat3x3(out.rot,
    m[0]/sx,m[4]/sy,m[8]/sz,
    m[1]/sx,m[5]/sy,m[9]/sz,
    m[2]/sx,m[6]/sy,m[10]/sz);
  return out;
};

// =========================================================================
// S4  Spec parser (keyframe input normalization)
// =========================================================================

const _isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const _clamp01 = (x) => x < 0 ? 0 : (x > 1 ? 1 : x);
const _clampScalar = (x, lo, hi) => x < lo ? lo : (x > hi ? hi : x);

function _parseVec3(v) {
  if (!v) return null;
  if (Array.isArray(v) && v.length >= 3 && v.every(n => typeof n === 'number')) return [v[0],v[1],v[2]];
  if (typeof v === 'object' && 'x' in v) return [v.x||0, v.y||0, v.z||0];
  return null;
}

function _parseQuat(v) {
  if (!v) return null;
  if (Array.isArray(v) && v.length === 4 && v.every(n => typeof n === 'number')) return [v[0],v[1],v[2],v[3]];
  if (v.axis && typeof v.angle === 'number') {
    const a = Array.isArray(v.axis) ? v.axis : [v.axis.x||0,v.axis.y||0,v.axis.z||0];
    return qFromAxisAngle([0,0,0,1], a[0],a[1],a[2], v.angle);
  }
  if (v.dir) {
    const d = Array.isArray(v.dir) ? v.dir : [v.dir.x||0,v.dir.y||0,v.dir.z||0];
    const u = v.up ? (Array.isArray(v.up) ? v.up : [v.up.x||0,v.up.y||0,v.up.z||0]) : null;
    return qFromLookDir([0,0,0,1], d, u);
  }
  return null;
}

function _parseSpec(spec) {
  if (!spec || typeof spec !== 'object') return null;
  const pos = _parseVec3(spec.pos) || [0,0,0];
  const rot = _parseQuat(spec.rot) || [0,0,0,1];
  const scl = _parseVec3(spec.scl) || [1,1,1];
  return { pos, rot, scl };
}

function _sameTransform(a, b) {
  for (let i = 0; i < 3; i++) if (a.pos[i] !== b.pos[i] || a.scl[i] !== b.scl[i]) return false;
  for (let i = 0; i < 4; i++) if (a.rot[i] !== b.rot[i]) return false;
  return true;
}

// =========================================================================
// S5  PoseTrack (pure state machine -- no p5 dependency)
// =========================================================================

export class PoseTrack {
  constructor() {
    this.keyframes = [];
    this.playing = false;
    this.loop = false;
    this.pingPong = false;
    this._rate = 1;
    this.duration = 30;
    this.seg = 0;
    this.f = 0;
    this.posInterp = 'catmullrom';
    this._pos = [0,0,0];
    this._rot = [0,0,0,1];
    this._scl = [1,1,1];

    // -- User-space hooks (set by user) --
    // onPlay(track)  -- fires once per false->true transition in play()
    // onEnd(track)   -- fires in tick() when cursor reaches natural boundary
    this.onPlay = null;
    this.onEnd = null;

    // -- Lib-space hooks (set by host layer, e.g. p5 addon) --
    // Fire on playing transitions only. Used for tick-loop registration.
    // _onActivate()   -- playing went false -> true
    // _onDeactivate() -- playing went true -> false (any cause)
    this._onActivate = null;
    this._onDeactivate = null;
  }

  get rate() { return this._rate; }
  set rate(v) {
    v = (typeof v === 'number' && isFinite(v)) ? v : 1;
    this._rate = v;
    if (v === 0 && this.playing) {
      this.playing = false;
      this._onDeactivate?.();
    }
  }

  get segments() { return Math.max(0, this.keyframes.length - 1); }

  add(spec, opts) {
    const kf = _parseSpec(spec);
    if (!kf) return;
    const dedup = !opts || opts.deduplicate !== false;
    if (dedup && this.keyframes.length > 0) {
      if (_sameTransform(this.keyframes[this.keyframes.length - 1], kf)) return;
    }
    this.keyframes.push(kf);
  }

  set(index, spec) {
    if (typeof index !== 'number' || !Number.isFinite(index)) return false;
    const i = index | 0;
    if (i < 0 || i > this.keyframes.length) return false;
    const kf = _parseSpec(spec);
    if (!kf) return false;
    if (i === this.keyframes.length) { this.keyframes.push(kf); }
    else { this.keyframes[i] = kf; }
    return true;
  }

  remove(index) {
    if (typeof index !== 'number' || !Number.isFinite(index)) return false;
    const i = index | 0;
    if (i < 0 || i >= this.keyframes.length) return false;
    this.keyframes.splice(i, 1);
    const nSeg = this.segments;
    if (nSeg === 0) { this.seg = 0; this.f = 0; }
    else if (this.seg >= nSeg) { this.seg = nSeg - 1; }
    return true;
  }

  /**
   * Start or update playback.
   * Accepts a numeric rate or an options object:
   *   { rate, duration, loop, pingPong, onPlay, onEnd }
   *
   * If already playing, updates parameters without re-firing onPlay/_onActivate.
   */
  play(rateOrOpts) {
    if (this.keyframes.length <= 1) { this.playing = false; return; }
    const nSeg = this.segments;

    if (typeof rateOrOpts === 'number' && isFinite(rateOrOpts)) {
      this.rate = rateOrOpts;
    } else if (rateOrOpts && typeof rateOrOpts === 'object') {
      const o = rateOrOpts;
      if (_isNum(o.duration)) this.duration = o.duration;
      if ('loop' in o) this.loop = !!o.loop;
      if ('pingPong' in o) this.pingPong = !!o.pingPong;
      if (typeof o.onPlay === 'function') this.onPlay = o.onPlay;
      if (typeof o.onEnd === 'function') this.onEnd = o.onEnd;
      if (_isNum(o.rate)) this.rate = o.rate;
    }
    if (this.rate === 0) { this.playing = false; return; }

    const dur = Math.max(1, this.duration | 0);
    if (this.seg < 0) this.seg = 0; else if (this.seg >= nSeg) this.seg = nSeg - 1;
    if (this.f < 0) this.f = 0; else if (this.f > dur) this.f = dur;

    const wasPlaying = this.playing;
    this.playing = true;

    if (!wasPlaying) {
      // Transition: false -> true
      if (typeof this.onPlay === 'function') { try { this.onPlay(this); } catch(_) {} }
      this._onActivate?.();
    }
  }

  /** Stop playback. Does NOT reset time unless reset is true. */
  stop(reset) {
    const wasPlaying = this.playing;
    this.playing = false;
    if (wasPlaying) this._onDeactivate?.();
    if (!reset) return;
    if (this.keyframes.length <= 1) return;
    this.seek(this.rate < 0 ? 1 : 0);
  }

  /** Clear all keyframes and reset cursor. */
  reset() {
    const wasPlaying = this.playing;
    this.playing = false;
    if (wasPlaying) this._onDeactivate?.();
    this.keyframes.length = 0;
    this.seg = 0;
    this.f = 0;
  }

  seek(t, segIndex) {
    if (typeof segIndex === 'number' && Number.isFinite(segIndex)) {
      const nSeg = this.segments;
      if (nSeg === 0) return;
      this.seg = Math.max(0, Math.min(segIndex | 0, nSeg - 1));
      this.f = _clamp01(t) * Math.max(1, this.duration | 0);
    } else {
      const nSeg = this.segments;
      if (nSeg === 0) return;
      const tt = _clamp01(t);
      const dur = Math.max(1, this.duration | 0);
      const total = nSeg * dur;
      this._setCursorFromScalar(tt * total);
    }
  }

  time() {
    const nSeg = this.segments;
    if (nSeg === 0) return 0;
    const dur = Math.max(1, this.duration | 0);
    return _clamp01((this.seg * dur + this.f) / (nSeg * dur));
  }

  info() {
    return {
      keyframes: this.keyframes.length, segments: this.segments,
      seg: this.seg, f: this.f,
      playing: this.playing, loop: this.loop, pingPong: this.pingPong,
      rate: this.rate, duration: this.duration,
      time: this.segments > 0 ? this.time() : 0
    };
  }

  tick() {
    if (!this.playing) return false;
    const nSeg = this.segments;
    if (nSeg === 0) { this.playing = false; this._onDeactivate?.(); return false; }
    const dur = Math.max(1, this.duration | 0);
    const step = this.rate;
    if (step === 0) { this.playing = false; this._onDeactivate?.(); return false; }

    const total = nSeg * dur;
    let s = _clampScalar(this.seg * dur + this.f, 0, total);
    let next = s + step;

    if (this.pingPong) {
      let flips = 0;
      while (next < 0 || next > total) {
        if (next < 0) { next = -next; flips++; }
        else { next = 2*total - next; flips++; }
      }
      if (flips & 1) this._rate = -this._rate;
      this._setCursorFromScalar(next);
      return true;
    }

    if (this.loop) {
      next = ((next % total) + total) % total;
      this._setCursorFromScalar(next);
      return true;
    }

    // Non-looping: check boundaries
    if (next <= 0) {
      this._setCursorFromScalar(0);
      this.playing = false;
      if (typeof this.onEnd === 'function') { try { this.onEnd(this); } catch(_) {} }
      this._onDeactivate?.();
      return false;
    }
    if (next >= total) {
      this._setCursorFromScalar(total);
      this.playing = false;
      if (typeof this.onEnd === 'function') { try { this.onEnd(this); } catch(_) {} }
      this._onDeactivate?.();
      return false;
    }
    this._setCursorFromScalar(next);
    return true;
  }

  eval(out) {
    out = out || { pos: [0,0,0], rot: [0,0,0,1], scl: [1,1,1] };
    const n = this.keyframes.length;
    if (n === 0) return out;
    if (n === 1) {
      const k = this.keyframes[0];
      out.pos[0]=k.pos[0];out.pos[1]=k.pos[1];out.pos[2]=k.pos[2];
      out.rot[0]=k.rot[0];out.rot[1]=k.rot[1];out.rot[2]=k.rot[2];out.rot[3]=k.rot[3];
      out.scl[0]=k.scl[0];out.scl[1]=k.scl[1];out.scl[2]=k.scl[2];
      return out;
    }
    const nSeg = n - 1;
    const seg = Math.max(0, Math.min(this.seg, nSeg - 1));
    const dur = Math.max(1, this.duration | 0);
    const t = _clamp01(this.f / dur);
    const k0 = this.keyframes[seg], k1 = this.keyframes[seg + 1];
    // Position
    if (this.posInterp === 'catmullrom' && n >= 2) {
      const p0 = seg > 0 ? this.keyframes[seg-1].pos : k0.pos;
      const p3 = seg+2 < n ? this.keyframes[seg+2].pos : k1.pos;
      catmullRomVec3(out.pos, p0, k0.pos, k1.pos, p3, t);
    } else {
      lerpVec3(out.pos, k0.pos, k1.pos, t);
    }
    // Rotation
    qSlerp(out.rot, k0.rot, k1.rot, t);
    // Scale
    lerpVec3(out.scl, k0.scl, k1.scl, t);
    return out;
  }

  toMatrix(outMat4) {
    const xf = this.eval({ pos: this._pos, rot: this._rot, scl: this._scl });
    return transformToMat4(outMat4, xf);
  }

  // -- Private --

  _setCursorFromScalar(s) {
    const dur = Math.max(1, this.duration | 0);
    this.seg = Math.floor(s / dur);
    this.f = s - this.seg * dur;
    const nSeg = this.segments;
    if (this.seg >= nSeg) { this.seg = nSeg - 1; this.f = dur; }
    if (this.seg < 0) { this.seg = 0; this.f = 0; }
  }
}
