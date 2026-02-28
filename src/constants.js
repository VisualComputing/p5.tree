/**
 * @file p5.Tree constants and namespace.
 * @module constants
 * @license GPL-3.0-only
 *
 * Defines the `p5.Tree` namespace and all library-wide constants.
 * Zero dependencies — every other module may import this freely.
 */

'use strict';

/**
 * Install constants onto `p5.Tree`.
 * Called by the entry-point addon registration.
 *
 * @param {p5} p5  The p5 constructor.
 */
export function installConstants(p5) {
  p5.Tree ||= {};

  const CONST = value => ({ value, writable: false, enumerable: true, configurable: false });

  Object.defineProperties(p5.Tree, {
    VERSION: CONST('0.0.15'),

    NONE: CONST(0),

    // Spaces
    WORLD:  CONST('WORLD'),
    EYE:    CONST('EYE'),
    NDC:    CONST('NDC'),
    SCREEN: CONST('SCREEN'),
    MODEL:  CONST('MODEL'),
    OBJECT: CONST('MODEL'), // alias of MODEL (shader terminology)

    // Points and vectors
    ORIGIN: CONST(Object.freeze([0, 0, 0])),

    i:  CONST(Object.freeze([1, 0, 0])),
    j:  CONST(Object.freeze([0, 1, 0])),
    k:  CONST(Object.freeze([0, 0, 1])),

    _i: CONST(Object.freeze([-1, 0, 0])),
    _j: CONST(Object.freeze([0, -1, 0])),
    _k: CONST(Object.freeze([0, 0, -1])),

    // Axes / grid bits & styles
    X:      CONST(1 << 0),
    _X:     CONST(1 << 1),
    Y:      CONST(1 << 2),
    _Y:     CONST(1 << 3),
    Z:      CONST(1 << 4),
    _Z:     CONST(1 << 5),
    LABELS: CONST(1 << 6),

    // bullsEye
    CIRCLE: CONST(0),
    SQUARE: CONST(1),

    // View frustum bits
    NEAR:   CONST(1 << 0),
    FAR:    CONST(1 << 1),
    LEFT:   CONST(1 << 2),
    RIGHT:  CONST(1 << 3),
    BOTTOM: CONST(1 << 4),
    TOP:    CONST(1 << 5),
    BODY:   CONST(1 << 6),
    APEX:   CONST(1 << 7),

    // Visibility
    INVISIBLE:   CONST(0),
    VISIBLE:     CONST(1),
    SEMIVISIBLE: CONST(2),
  });
}
