/**
 * @file UI package entry point — parameter panels and transport controls.
 * @module ui
 * @license AGPL-3.0-only
 *
 * Pure vanilla DOM.  Zero p5 dependencies.
 * Mount into any container (canvas parent, Vue, React, plain HTML).
 *
 * Duck-type contract for track detection:
 *   typeof first?.play === 'function'  →  track panel  (_createTrackUI)
 *   otherwise                          →  param panel  (_createUI)
 */

'use strict';

import { createUI      as _createUI      } from './bindUI.js';
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
 * @param {Object} [opt]
 * @returns {Object} UI handle with .el, .tick(), .dispose().
 */
export function createPanel(trackOrSchema, opt) {
  if (typeof trackOrSchema?.play === 'function') {
    return _createTrackUI(trackOrSchema, opt);
  }
  return _createUI(trackOrSchema, opt);
}
