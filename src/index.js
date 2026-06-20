/**
 * @file p5.tree addon entry point — registers onto p5, delegates to sub-modules.
 * @module p5.tree
 * @license AGPL-3.0-only
 */

'use strict';

import p5 from 'p5';

import { installConstants } from './constants.js';
import { installMatrix, detectNDC } from './matrix.js';
import { installHud } from './hud.js';
import { installVisibility } from './visibility.js';
import { installGizmos } from './gizmos.js';
import { installPicking, releasePickFbo } from './picking.js';
import { installTrack, tickPlayers, clearPlayers } from './track.js';
import { installPipe } from './pipe.js';
import { installPanel } from './panel.js';
import { installHandle, disposeHandles } from './handle.js';
import { installHelm } from './helm.js';

p5.registerAddon((p5, fn, lifecycles) => {

  // §1 — Constants & namespace (includes WEBGL / WEBGPU)
  installConstants(p5);

  // §2 — Matrix queries, space transforms
  installMatrix(p5, fn);

  // §3 — HUD (beginHUD / endHUD)
  installHud(p5, fn);

  // §4 — Visibility (frustum culling bridge)
  installVisibility(p5, fn);

  // §5 — Gizmos (axes, grid, cross, bullsEye, viewFrustum)
  installGizmos(p5, fn);

  // §6 — Picking (colorPick, mousePick, mouseHit, pointerHit, tag)
  installPicking(p5, fn);

  // §7 — PoseTrack, adapters, camera path API + global forwarders
  installTrack(p5, fn);

  // §8 — Pipe (post-processing chain)
  installPipe(p5, fn);

  // §9 — Panel (parameter panels + track transport controls)
  installPanel(p5, fn);

  // §10 — Handle (interactive manipulators: createHandle)
  installHandle(p5, fn);

  // §11 — Helm (live 6-DOF rate stream: createCameraHelm / createPoseHelm)
  installHelm(p5, fn);

  // ── Lifecycle hooks ────────────────────────────────────────────────

  lifecycles.postsetup = function () {
    if (!(this._renderer instanceof p5.Renderer3D)) {
      throw new Error('p5.tree requires WEBGL or WEBGPU. Use createCanvas(w, h, WEBGL) or WEBGPU.');
    }
    // Detect NDC convention from the renderer context (3rd param to createCanvas)
    detectNDC(this._renderer);
  };

  lifecycles.predraw = function () {
    tickPlayers(this);
  };

  lifecycles.remove = function () {
    clearPlayers(this);
    this.releasePipe(true);
    releasePickFbo(this);
    disposeHandles(this);
  };
});
