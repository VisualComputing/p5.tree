/**
 * @file Install constants onto p5.Tree.
 * @module p5.tree/constants
 * @license AGPL-3.0-only
 */

import * as C from '@nakednous/tree';

export function installConstants(p5) {
  p5.Tree ||= {};

  const CONST = value => ({ value, writable: false, enumerable: true, configurable: false });

  Object.defineProperties(p5.Tree, {
    VERSION: CONST('0.0.42'),
    NONE: CONST(0),

    // Core constants (spaces, visibility, NDC, basis vectors)
    WORLD:  CONST(C.WORLD),
    EYE:    CONST(C.EYE),
    NDC:    CONST(C.NDC),
    SCREEN: CONST(C.SCREEN),
    MODEL:  CONST(C.MODEL),
    OBJECT: CONST(C.MODEL),

    WEBGL:  CONST(C.WEBGL),
    WEBGPU: CONST(C.WEBGPU),

    INVISIBLE:   CONST(C.INVISIBLE),
    VISIBLE:     CONST(C.VISIBLE),
    SEMIVISIBLE: CONST(C.SEMIVISIBLE),

    ORIGIN: CONST(C.ORIGIN),
    i:  CONST(C.i),
    j:  CONST(C.j),
    k:  CONST(C.k),
    _i: CONST(C._i),
    _j: CONST(C._j),
    _k: CONST(C._k),

    // ── Addon-only constants (drawing / frustum / trackPath bits) ─────────
    //
    // Bit namespaces are gizmo-local: the same numeric value carries different
    // meanings to different gizmos.  Users pass each gizmo its own bit set and
    // never mix them across gizmos.

    // axes bits
    X:      CONST(1 << 0),
    _X:     CONST(1 << 1),
    Y:      CONST(1 << 2),
    _Y:     CONST(1 << 3),
    Z:      CONST(1 << 4),
    _Z:     CONST(1 << 5),
    LABELS: CONST(1 << 6),

    // bullsEye shape
    CIRCLE: CONST(0),
    SQUARE: CONST(1),

    // viewFrustum bits
    NEAR:   CONST(1 << 0),
    FAR:    CONST(1 << 1),
    LEFT:   CONST(1 << 2),
    RIGHT:  CONST(1 << 3),
    BOTTOM: CONST(1 << 4),
    TOP:    CONST(1 << 5),
    BODY:   CONST(1 << 6),
    APEX:   CONST(1 << 7),

    // trackPath bits — CameraTrack-aware: PATH/CONTROLS/TANGENTS_* respect
    // the `target: 'eye' | 'center'` opt; CENTER is camera-only and always
    // draws the gaze relationship (not a polyline).
    PATH:         CONST(1 << 0),   // sampled polyline along the target path
    CENTER:       CONST(1 << 1),   // camera — gaze line eye→center + endpoint dot at kf.center
    CONTROLS:     CONST(1 << 2),   // straight control polygon along the target path
    TANGENTS_IN:  CONST(1 << 3),   // incoming tangent arrows at keyframes of the target path
    TANGENTS_OUT: CONST(1 << 4),   // outgoing tangent arrows at keyframes of the target path
    TANGENTS:     CONST((1 << 3) | (1 << 4)),  // convenience — IN | OUT
  });
}
