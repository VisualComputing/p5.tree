/**
 * @file p5.tree.js — Entry point.
 * @version 0.0.15
 * @author JP Charalambos
 * @license GPL-3.0-only
 *
 * @description
 * A p5.js 3D addon for matrix queries, shader workflows, space transformations,
 * and camera-path keyframe animation.
 *
 * This entry point registers the addon and delegates to sub-modules:
 *   - constants.js  — p5.Tree namespace + constants
 *   - matrix.js     — matrix queries, space transforms, HUD
 *   - drawing.js    — axes, grid, cross, bullsEye, viewFrustum, picking, visibility
 *   - track.js      — TransformTrack, adapters, camera path API
 *   - pipe.js       — pipe() + releasePipe()
 *   - uniformUI.js  — createUniformUI()
 */

/*
 TODO's
 i.   beginHUD / endHUD text() issue (seems like an upstream matter)
 ii.  mapLocation & mapDirection stress test
 iii. Port p5.treegl parseGeometry?
 iii. Shader & effects handling
 iv.  p5.strands interface
 */

'use strict';

import p5 from 'p5';
import { installConstants } from './constants.js';
import { installMatrix } from './matrix.js';
import { installDrawing } from './drawing.js';
import { installTrack, tickPlayers, clearPlayers } from './track.js';
import { installPipe, releaseAllPipes } from './pipe.js';
import { installUniformUI } from './uniformUI.js';

p5.registerAddon((p5, fn, lifecycles) => {

  // §1 — Constants & namespace
  installConstants(p5);

  // §2 — Matrix queries, space transforms, HUD
  installMatrix(p5, fn);

  // §3 — Drawing helpers, picking, viewFrustum, visibility
  installDrawing(p5, fn);

  // §4 — TransformTrack, adapters, camera path API + global forwarders
  installTrack(p5, fn);

  // §5 — Pipe (post-processing chain)
  installPipe(p5, fn);

  // §6 — UniformUI (DOM-based shader parameter controls)
  installUniformUI(p5, fn);

  // ── Lifecycle hooks ──────────────────────────────────────────────────────

  lifecycles.postsetup = function () {
    if (!(this._renderer instanceof p5.Renderer3D)) {
      throw new Error('p5.tree requires WEBGL or WEBGPU. Use createCanvas(w, h, WEBGL) or WEBGPU.');
    }
  };

  lifecycles.predraw = function () {
    tickPlayers(this);
  };

  lifecycles.remove = function () {
    clearPlayers(this);
    this.releasePipe(true);
  };
});
