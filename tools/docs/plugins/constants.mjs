/**
 * @file The `@constant` ↔ `CONST(...)` correspondence: a doc block for every
 * constant the namespace defines, and a definition for every block.
 * @module tools/docs/plugins/constants
 * @license AGPL-3.0-only
 *
 * `src/constants.js` declares the `p5.Tree` namespace's constants as
 * `NAME: CONST(value)` entries, and the site documents each one with a
 * `@constant` block. The two lists are the same list, so the site fails the
 * build when they disagree in either direction: a constant a reader can use and
 * cannot read about, or a page that documents a name the library no longer
 * defines. This is p5.tree's own convention and lives here, not in the package.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CONST_RE = /^\s*([A-Za-z_$][\w$]*)\s*:\s*CONST\(/gm;

/** The constants file, from this plugin's own place in the repository. */
const FILE = fileURLToPath(new URL('../../../src/constants.js', import.meta.url));
const RELATIVE = 'src/constants.js';

export default {
  name: 'constants',

  /**
   * @param {{ doclets: Object[] }} parsed
   * @returns {{ errors: string[] }}
   */
  validate(parsed) {
    const errors = [];
    const source = readFileSync(FILE, 'utf8');

    // `NAME: CONST(…)` entries, each with the line it sits on.
    const defined = new Map();
    for (const match of source.matchAll(CONST_RE)) {
      const line = source.slice(0, match.index).split('\n').length;
      defined.set(match[1], line);
    }

    const tagged = new Map(parsed.doclets.filter((d) => d.via === 'constant').map((d) => [d.name, d]));
    for (const [name, line] of defined) {
      if (!tagged.has(name)) errors.push(`${RELATIVE}:${line}  CONST entry ${name} has no @constant block`);
    }
    for (const [name, doclet] of tagged) {
      if (!defined.has(name)) errors.push(`${doclet.file}:${doclet.line}  @constant ${name} has no CONST entry in ${RELATIVE}`);
    }
    return { errors };
  },
};
