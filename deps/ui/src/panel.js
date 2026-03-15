/**
 * @file Single unified panel factory — dispatches to param or track UI.
 * @module ui/panel
 * @license GPL-3.0-only
 *
 * Duck-type contract for track detection:
 *   typeof first?.play === 'function'  →  track panel  (_createTrackUI)
 *   otherwise                          →  param panel  (_createUI)
 *
 * This check is robust because schema objects are plain config bags — no schema
 * will ever have a .play method.  Track wrapper objects (built by the p5 bridge)
 * always expose .play by delegation from the underlying Track instance.
 *
 * Neither _createUI nor _createTrackUI is exported — createPanel is the sole
 * public entry point for this package.
 */

'use strict';

import { createUI      as _createUI      } from './ui.js';
import { createTrackUI as _createTrackUI } from './trackUI.js';

/**
 * Unified panel factory.
 *
 * First argument determines the panel type:
 *
 *   createPanel(track, opt)   — transport controls
 *     track must expose: play, stop, seek, time, playing
 *     opt.add present        → + button enabled
 *     opt.reset present      → ↺ button enabled
 *
 *   createPanel(schema, opt)  — parameter controls
 *     schema is a plain object of control definitions (no .play method)
 *     opt.target (function|{set}) → values pushed each tick
 *
 * Both paths share the same layout options: x, y, width, color, hidden, parent.
 *
 * @param {Object} trackOrSchema
 *   A track-compatible object (has .play) or a schema definition object.
 * @param {Object} [opt]
 *   Layout and behaviour options — see createTrackUI / createUI for full lists.
 * @returns {Object} UI handle with .el, .tick(), .dispose().
 */
export function createPanel(trackOrSchema, opt) {
  if (typeof trackOrSchema?.play === 'function') {
    return _createTrackUI(trackOrSchema, opt);
  }
  return _createUI(trackOrSchema, opt);
}
