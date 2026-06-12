/**
 * @file Install constants and core math re-exports onto p5.Tree.
 * @module p5.tree/constants
 * @license AGPL-3.0-only
 */

import * as C from '@nakednous/tree';

export function installConstants(p5) {
  p5.Tree ||= {};

  const CONST = value => ({ value, writable: false, enumerable: true, configurable: false });

  Object.defineProperties(p5.Tree, {
    VERSION: CONST('0.0.47'),
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

    // handle — constraint kinds (core SPHERE/PLANE/AXIS/DIAL + bridge VIEW)
    // and report modes. VIEW is a camera-facing PLANE, reported as a world
    // position. DIAL is a 1-DOF angle on a circle (rotation handle).
    SPHERE:    CONST(C.SPHERE),
    PLANE:     CONST(C.PLANE),
    AXIS:      CONST(C.AXIS),
    DIAL:      CONST(C.DIAL),
    VIEW:      CONST(4),
    POINT:     CONST(C.POINT),
    DIRECTION: CONST(C.DIRECTION),

    // handle draw bits (gizmo-local; orthogonal, mirrors trackPath bits)
    HANDLE: CONST(1 << 0),   // the draggable dot
    AIM:    CONST(1 << 1),   // anchor→handle line / gaze / dial spoke
    LOCUS:  CONST(1 << 2),   // constraint surface: sphere wire | plane quad | axis | dial ring
    RING:   CONST(1 << 3),   // sphere limb / plane border highlight

    // ── Core math re-exports ───────────────────────────────────────────
    //
    // Criterion: a core symbol is surfaced here when (a) p5 has no adequate
    // native equivalent AND (b) a sketch-level consumer exists (an example,
    // experiment, or notebook chapter). Where p5 HAS an adequate native type,
    // the bridge maps at seams instead (vec3 → p5.Vector via value()/
    // mapLocation; matrices → the matrix.js seams). Flat, out-first core
    // functions — never wrapper classes: the explicit form IS the pseudocode
    // tier the notebook teaches against.
    //
    // Quaternions — flat [x, y, z, w] (w-LAST, glTF layout), out-first.
    // p5.Quat is @private upstream, lacks slerp/normalize/mat conversions,
    // and (as of p5 2.x) ships a typo'd Hamilton product — no adequate native.
    qSet:             CONST(C.qSet),
    qCopy:            CONST(C.qCopy),
    qDot:             CONST(C.qDot),
    qNormalize:       CONST(C.qNormalize),
    qNegate:          CONST(C.qNegate),
    qConjugate:       CONST(C.qConjugate),
    qMul:             CONST(C.qMul),
    qRotateVec3:      CONST(C.qRotateVec3),
    qSlerp:           CONST(C.qSlerp),
    qNlerp:           CONST(C.qNlerp),
    qFromUnitVectors: CONST(C.qFromUnitVectors),
    qFromAxisAngle:   CONST(C.qFromAxisAngle),
    qFromLookDir:     CONST(C.qFromLookDir),
    qFromRotMat3x3:   CONST(C.qFromRotMat3x3),
    qFromMat4:        CONST(C.qFromMat4),
    qToMat4:          CONST(C.qToMat4),
    qToAxisAngle:     CONST(C.qToAxisAngle),

    // Ray primitives + angular utilities — what a §9 custom constraint's
    // solve() is made of (p5 has no ray primitives at all). See
    // handle-examples/10-custom-helix.
    raySphere:              CONST(C.raySphere),
    rayPlane:               CONST(C.rayPlane),
    rayClosestPointOnAxis:  CONST(C.rayClosestPointOnAxis),
    dirFromAzEl:            CONST(C.dirFromAzEl),
    azElFromDir:            CONST(C.azElFromDir),
  });
}
