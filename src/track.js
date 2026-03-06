/**
 * @file Camera path API + PoseTrack bridge.
 * @module p5.tree/track
 * @license GPL-3.0-only
 *
 * Imports PoseTrack from core (tree/track). All p5.Camera-specific code,
 * adapter, player registry, and lifecycle helpers live here.
 */

'use strict';

import {
  PoseTrack, qFromMat4, qToMat4, qSlerp, quatToAxisAngle
} from '@nakednous/tree';

// ═══════════════════════════════════════════════════════════════════════════
// Private helpers
// ═══════════════════════════════════════════════════════════════════════════

const _SCRATCH_MAT4 = new Float32Array(16);
const _clamp01 = (x) => x < 0 ? 0 : (x > 1 ? 1 : x);
const _isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const _warn = (msg) => console.warn('[tree.camera.path] ' + msg);

const _isPlainObject = (v) => {
  if (!v || typeof v !== 'object') return false;
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return false;
  return Object.getPrototypeOf(v) === Object.prototype;
};

// ═══════════════════════════════════════════════════════════════════════════
// CameraAdapter (p5-specific)
// ═══════════════════════════════════════════════════════════════════════════

class CameraAdapter {
  constructor(cam) { this.cam = cam; }
  capture(out) {
    const cam = this.cam;
    out.pos[0] = cam.eyeX; out.pos[1] = cam.eyeY; out.pos[2] = cam.eyeZ;
    out.scl[0] = 1; out.scl[1] = 1; out.scl[2] = 1;
    if (cam.cameraMatrix && cam.cameraMatrix.mat4) qFromMat4(out.rot, cam.cameraMatrix.mat4);
    return out;
  }
  apply(xform) {
    const cam = this.cam, pos = xform.pos, rot = xform.rot;
    const rm = _SCRATCH_MAT4; qToMat4(rm, rot);
    const fwdX = -rm[8], fwdY = -rm[9], fwdZ = -rm[10];
    const upX = rm[4], upY = rm[5], upZ = rm[6];
    const dx = cam.centerX - cam.eyeX, dy = cam.centerY - cam.eyeY, dz = cam.centerZ - cam.eyeZ;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    cam.camera(pos[0], pos[1], pos[2],
      pos[0] + fwdX * dist, pos[1] + fwdY * dist, pos[2] + fwdZ * dist, upX, upY, upZ);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Per-camera storage + player registry
// ═══════════════════════════════════════════════════════════════════════════

const CAM_TRACK = new WeakMap();
const PATH_PLAYERS = new WeakMap();

export function getCamTrack(cam) {
  let b = CAM_TRACK.get(cam);
  if (!b) {
    b = { track: new PoseTrack(), adapter: new CameraAdapter(cam),
          pathIsOrtho: undefined, camSnaps: [], player: null };
    CAM_TRACK.set(cam, b);
  }
  return b;
}

function getPlayers(pInst) {
  let players = PATH_PLAYERS.get(pInst);
  if (!players) { players = new Set(); PATH_PLAYERS.set(pInst, players); }
  return players;
}

export function registerPlayer(pInst, player) {
  if (!pInst || !player) return;
  getPlayers(pInst).add(player);
}

function unregisterPlayer(pInst, player) {
  if (!pInst || !player) return;
  getPlayers(pInst).delete(player);
}

// ═══════════════════════════════════════════════════════════════════════════
// Camera path helpers
// ═══════════════════════════════════════════════════════════════════════════

const isOrthoCam = (c) => c?.projMatrix?.isOrtho?.();

function initProjBaseline(cam) {
  const b = getCamTrack(cam);
  if (b.pathIsOrtho !== undefined) return;
  b.pathIsOrtho = isOrthoCam(cam);
  if (b.pathIsOrtho === undefined) _warn('addPath: unable to verify projection type.');
}

function checkProjCompat(cam, snapCam) {
  const b = getCamTrack(cam);
  initProjBaseline(cam);
  const v = isOrthoCam(snapCam);
  if (b.pathIsOrtho === undefined || v === undefined) return true;
  if (v !== b.pathIsOrtho) { _warn('addPath rejected: mixed projection types.'); return false; }
  return true;
}

function addCamSnapshot(cam, snapCam) {
  const b = getCamTrack(cam);
  const last = b.camSnaps.length ? b.camSnaps[b.camSnaps.length - 1] : null;
  if (last && last.cameraMatrix && snapCam.cameraMatrix) {
    const aM = last.cameraMatrix.mat4, bM = snapCam.cameraMatrix.mat4;
    if (aM && bM) { let same = true; for (let i = 0; i < 16; i++) { if (aM[i] !== bM[i]) { same = false; break; } } if (same) return; }
  }
  const copy = snapCam.copy();
  b.camSnaps.push(copy);
  const kf = { pos: [copy.eyeX, copy.eyeY, copy.eyeZ], rot: [0, 0, 0, 1], scl: [1, 1, 1] };
  if (copy.cameraMatrix && copy.cameraMatrix.mat4) qFromMat4(kf.rot, copy.cameraMatrix.mat4);
  b.track.keyframes.push(kf);
}

function applyCamInterp(cam, seg, t) {
  const snaps = getCamTrack(cam).camSnaps;
  if (seg < 0 || seg >= snaps.length - 1) return;
  cam.slerp(snaps[seg], snaps[seg + 1], t);
}

export function _applyCamAtCursor(cam) {
  const b = getCamTrack(cam);
  const track = b.track;
  const nSeg = track.segments;
  if (nSeg === 0) return;
  const dur = Math.max(1, track.duration | 0);
  const t = _clamp01(track.f / dur);
  applyCamInterp(cam, Math.max(0, Math.min(track.seg, nSeg - 1)), t);
}

export function tickCamera(cam) {
  const track = getCamTrack(cam).track;
  if (!track.playing) return;
  track.tick();
  _applyCamAtCursor(cam);
}

// ═══════════════════════════════════════════════════════════════════════════
// Shared parse helpers (used by addPath)
// ═══════════════════════════════════════════════════════════════════════════

function _addPathHelpers(p5) {
  const isVec3 = (v) => v instanceof p5.Vector ||
    (Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n)));
  const toVec3 = (v) => v instanceof p5.Vector ? [v.x, v.y, v.z] : [v[0], v[1], v[2]];
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len3 = (v) => Math.sqrt(dot3(v, v));
  const norm3 = (v) => { const l = len3(v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const isMat4Array = (v) => (Array.isArray(v) || ArrayBuffer.isView(v)) && v.length === 16 &&
    Array.prototype.every.call(v, n => typeof n === 'number' && Number.isFinite(n));
  const isView = (v) => v instanceof p5.Matrix || isMat4Array(v);
  const toMat4 = (v) => v instanceof p5.Matrix ? v.mat4 : v;

  const importViewToCamera = (cam, view) => {
    const m = toMat4(view);
    const right = norm3([m[0], m[4], m[8]]);
    const up = norm3([m[1], m[5], m[9]]);
    const negFwd = norm3([m[2], m[6], m[10]]);
    const fwd = [-negFwd[0], -negFwd[1], -negFwd[2]];
    const t = [m[12], m[13], m[14]];
    const eye = [-(t[0] * right[0] + t[1] * up[0]) + t[2] * fwd[0],
                 -(t[0] * right[1] + t[1] * up[1]) + t[2] * fwd[1],
                 -(t[0] * right[2] + t[1] * up[2]) + t[2] * fwd[2]];
    const dist = Math.sqrt((cam.centerX - cam.eyeX) ** 2 + (cam.centerY - cam.eyeY) ** 2 + (cam.centerZ - cam.eyeZ) ** 2) || 1;
    const center = [eye[0] + fwd[0] * dist, eye[1] + fwd[1] * dist, eye[2] + fwd[2] * dist];
    const c = cam.copy();
    c.camera(eye[0], eye[1], eye[2], center[0], center[1], center[2], up[0], up[1], up[2]);
    return c;
  };

  return { isVec3, toVec3, norm3, isView, importViewToCamera };
}

// ═══════════════════════════════════════════════════════════════════════════
// Install
// ═══════════════════════════════════════════════════════════════════════════

export function installTrack(p5, fn) {
  // Expose core type on p5.Tree
  p5.Tree.PoseTrack = PoseTrack;

  // Instance-aware factory — wires lib-space hooks so play()/stop()/reset()
  // auto-register/unregister the track into the p5 predraw tick loop.
  // Multiple concurrent PoseTracks are supported: each gets its own player
  // in the shared Set<player> per pInst.
  fn.createPoseTrack = function () {
    const pInst = this;
    const track = new PoseTrack();
    let player = null;

    // Lib hook: playing went false → true
    track._onActivate = () => {
      player = player || {
        tick() { track.tick(); return track.playing; }
      };
      registerPlayer(pInst, player);
    };

    // Lib hook: playing went true → false (any cause)
    track._onDeactivate = () => {
      unregisterPlayer(pInst, player);
    };

    return track;
  };

  const H = _addPathHelpers(p5);

  // ── addPath ───────────────────────────────────────────────────────────

  p5.Camera.prototype.addPath = function (...args) {
    const b = getCamTrack(this);
    const track = b.track;
    const o = args.length && _isPlainObject(args[args.length - 1]) ? args.pop() : {};
    if (o.reset) { track.reset(); b.camSnaps.length = 0; b.pathIsOrtho = undefined; }
    initProjBaseline(this);
    if (args.length === 0) { addCamSnapshot(this, this); return this; }
    if (args.length === 1) {
      const ov = args[0];
      if (H.isView(ov)) { const c = H.importViewToCamera(this, ov); checkProjCompat(this, c) && addCamSnapshot(this, c); return this; }
      if (Array.isArray(ov)) {
        if (ov.length && ov.every(H.isView)) { for (const v of ov) { const c = H.importViewToCamera(this, v); checkProjCompat(this, c) && addCamSnapshot(this, c); } return this; }
        for (const c of ov) { if (!(c instanceof p5.Camera)) { _warn('addPath: ignored non-camera.'); continue; } checkProjCompat(this, c) && addCamSnapshot(this, c); }
        return this;
      }
      if (ov instanceof p5.Camera) { checkProjCompat(this, ov) && addCamSnapshot(this, ov); return this; }
      _warn('addPath: ignored unsupported arguments.'); return this;
    }
    if (args.length === 3 && args.every(H.isVec3)) {
      const eye = H.toVec3(args[0]), center = H.toVec3(args[1]), up = H.norm3(H.toVec3(args[2]));
      const c = this.copy(); c.camera(eye[0], eye[1], eye[2], center[0], center[1], center[2], up[0], up[1], up[2]);
      checkProjCompat(this, c) && addCamSnapshot(this, c); return this;
    }
    _warn('addPath: ignored unsupported arguments.'); return this;
  };

  // ── setPath ───────────────────────────────────────────────────────────

  p5.Camera.prototype.setPath = function (index, ...args) {
    if (typeof index !== 'number' || !Number.isFinite(index)) { _warn('setPath: index must be a finite number.'); return this; }
    const i = index | 0;
    const b = getCamTrack(this);
    if (i < 0 || i >= b.camSnaps.length) { _warn('setPath: index ' + i + ' out of range [0..' + (b.camSnaps.length - 1) + '].'); return this; }

    let snapCam;
    if (args.length === 0) {
      snapCam = this;
    } else if (args.length === 1) {
      const ov = args[0];
      if (ov instanceof p5.Camera) {
        snapCam = ov;
      } else if (H.isView(ov)) {
        snapCam = H.importViewToCamera(this, ov);
      } else {
        _warn('setPath: unsupported argument.'); return this;
      }
    } else if (args.length === 3 && args.every(H.isVec3)) {
      const eye = H.toVec3(args[0]), center = H.toVec3(args[1]), up = H.norm3(H.toVec3(args[2]));
      snapCam = this.copy();
      snapCam.camera(eye[0], eye[1], eye[2], center[0], center[1], center[2], up[0], up[1], up[2]);
    } else {
      _warn('setPath: unsupported arguments.'); return this;
    }

    if (!checkProjCompat(this, snapCam)) return this;

    const copy = snapCam === this ? this.copy() : snapCam.copy();
    b.camSnaps[i] = copy;
    const kf = { pos: [copy.eyeX, copy.eyeY, copy.eyeZ], rot: [0, 0, 0, 1], scl: [1, 1, 1] };
    if (copy.cameraMatrix && copy.cameraMatrix.mat4) qFromMat4(kf.rot, copy.cameraMatrix.mat4);
    b.track.keyframes[i] = kf;
    return this;
  };

  // ── removePath ────────────────────────────────────────────────────────

  p5.Camera.prototype.removePath = function (index) {
    if (typeof index !== 'number' || !Number.isFinite(index)) { _warn('removePath: index must be a finite number.'); return this; }
    const i = index | 0;
    const b = getCamTrack(this);
    if (i < 0 || i >= b.camSnaps.length) { _warn('removePath: index ' + i + ' out of range.'); return this; }
    b.camSnaps.splice(i, 1);
    b.track.remove(i);
    if (b.camSnaps.length === 0) b.pathIsOrtho = undefined;
    return this;
  };

  // ── playPath ──────────────────────────────────────────────────────────

  p5.Camera.prototype.playPath = function (rateOrOpts) {
    const b = getCamTrack(this), track = b.track;
    const pInst = this._renderer && this._renderer._pInst;
    const unreg = () => pInst && unregisterPlayer(pInst, b.player);
    const reg = () => {
      if (!pInst) return;
      b.player = b.player || { tick: () => { tickCamera(this); return getCamTrack(this).track.playing; } };
      registerPlayer(pInst, b.player);
    };
    if (track.keyframes.length === 0) { _warn('playPath ignored: no keyframes.'); track.playing = false; unreg(); return this; }
    if (track.keyframes.length === 1) {
      track.playing = false; unreg();
      const kf = b.camSnaps[0];
      return kf ? this.camera(kf.eyeX, kf.eyeY, kf.eyeZ, kf.centerX, kf.centerY, kf.centerZ, kf.upX, kf.upY, kf.upZ) : this;
    }
    if (track.segments === 0) { _warn('playPath ignored: need ≥2 keyframes.'); track.playing = false; unreg(); return this; }
    const cam = this;
    if (_isNum(rateOrOpts)) { track.play(rateOrOpts); }
    else {
      const o = rateOrOpts || {}, opts = {};
      if (_isNum(o.duration)) opts.duration = o.duration;
      if ('loop' in o) opts.loop = !!o.loop;
      if ('pingPong' in o) opts.pingPong = !!o.pingPong;
      if (typeof o.onPlay === 'function') { const ucb = o.onPlay; opts.onPlay = () => { try { ucb(cam); } catch (_) {} }; }
      if (typeof o.onEnd === 'function') { const ucb = o.onEnd; opts.onEnd = () => { try { ucb(cam); } catch (_) {} }; }
      if (_isNum(o.rate)) opts.rate = o.rate;
      track.play(opts);
    }
    if (track.rate === 0 || !track.playing) { unreg(); return this; }
    reg(); return this;
  };

  // ── stopPath ──────────────────────────────────────────────────────────

  p5.Camera.prototype.stopPath = function (reset = false) {
    const b = getCamTrack(this), track = b.track;
    track.playing = false;
    const pInst = this._renderer && this._renderer._pInst; unregisterPlayer(pInst, b.player);
    if (!reset) return this;
    if (b.camSnaps.length === 1) { const kf = b.camSnaps[0]; return this.camera(kf.eyeX, kf.eyeY, kf.eyeZ, kf.centerX, kf.centerY, kf.centerZ, kf.upX, kf.upY, kf.upZ); }
    track.seek(track.rate < 0 ? 1 : 0); _applyCamAtCursor(this); return this;
  };

  // ── resetPath ─────────────────────────────────────────────────────────

  p5.Camera.prototype.resetPath = function () {
    const b = getCamTrack(this), track = b.track;
    track.playing = false;
    const pInst = this._renderer && this._renderer._pInst; unregisterPlayer(pInst, b.player);
    const kf0 = b.camSnaps.length ? b.camSnaps[0] : null;
    track.reset(); b.camSnaps.length = 0; b.pathIsOrtho = undefined;
    if (!kf0) return this;
    return this.camera(kf0.eyeX, kf0.eyeY, kf0.eyeZ, kf0.centerX, kf0.centerY, kf0.centerZ, kf0.upX, kf0.upY, kf0.upZ);
  };

  // ── seekPath ──────────────────────────────────────────────────────────

  p5.Camera.prototype.seekPath = function (t, segIndex) {
    const b = getCamTrack(this);
    const track = b.track;
    track.playing = false;
    const pInst = this._renderer && this._renderer._pInst; unregisterPlayer(pInst, b.player);
    _isNum(segIndex) ? track.seek(t, segIndex) : track.seek(t);
    _applyCamAtCursor(this); return this;
  };

  // ── pathTime / pathInfo ───────────────────────────────────────────────

  p5.Camera.prototype.pathTime = function () { return getCamTrack(this).track.time(); };
  p5.Camera.prototype.pathInfo = function () { return getCamTrack(this).track.info(); };

  // ── camera.path backward compat ──────────────────────────────────────

  Object.defineProperty(p5.Camera.prototype, 'path', {
    get() { return getCamTrack(this).camSnaps; },
    set(v) { if (Array.isArray(v) && v.length === 0) { const b = getCamTrack(this); b.track.reset(); b.camSnaps.length = 0; b.pathIsOrtho = undefined; } },
    configurable: true
  });

  // ── Global forwarders ────────────────────────────────────────────────

  fn.addPath = function (...a) { const c = this._renderer.states.curCamera; c && c.addPath(...a); return this; };
  fn.setPath = function (...a) { const c = this._renderer.states.curCamera; c && c.setPath(...a); return this; };
  fn.removePath = function (...a) { const c = this._renderer.states.curCamera; c && c.removePath(...a); return this; };
  fn.playPath = function (...a) { const c = this._renderer.states.curCamera; c && c.playPath(...a); return this; };
  fn.seekPath = function (...a) { const c = this._renderer.states.curCamera; c && c.seekPath(...a); return this; };
  fn.resetPath = function (...a) { const c = this._renderer.states.curCamera; c && c.resetPath(...a); return this; };
  fn.stopPath = function (...a) { const c = this._renderer.states.curCamera; c && c.stopPath(...a); return this; };
  fn.pathTime = function () { const c = this._renderer.states.curCamera; return c && c.pathTime(); };
  fn.pathInfo = function () { const c = this._renderer.states.curCamera; return c && c.pathInfo(); };

  // ── rotateQuat / applyPose ────────────────────────────────────────────

  fn.rotateQuat = function (q, opts) {
    const eps = opts && typeof opts.eps === 'number' ? opts.eps : 1e-8;
    const x = q[0], y = q[1], z = q[2], w = q[3];
    const sinHalf = Math.sqrt(x * x + y * y + z * z);
    if (sinHalf < eps) return this;
    const angle = 2 * Math.atan2(sinHalf, w);
    this.rotate(angle, [x / sinHalf, y / sinHalf, z / sinHalf]);
    return this;
  };

  fn.applyPose = function (pose) {
    this.translate(pose.pos[0], pose.pos[1], pose.pos[2]);
    this.rotateQuat(pose.rot);
    this.scale(pose.scl[0], pose.scl[1], pose.scl[2]);
    return this;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Lifecycle helpers (exported for entry point)
// ═══════════════════════════════════════════════════════════════════════════

export function tickPlayers(pInst) {
  const players = getPlayers(pInst);
  players.forEach(player => {
    let alive = false;
    try { alive = player && typeof player.tick === 'function' ? !!player.tick() : false; }
    catch (_) { alive = false; }
    alive || players.delete(player);
  });
}

export function clearPlayers(pInst) {
  const players = PATH_PLAYERS.get(pInst);
  players && players.clear();
}
