#!/usr/bin/env node
/**
 * @file Docs generator entry — `npm run docs`: src/*.js → site/.
 * @module tools/docs
 * @license AGPL-3.0-only
 *
 * Pipeline: parse doc blocks → validate (errors fail the build) → render →
 * write site/ alongside the IIFE bundle of the same commit and the static
 * chrome (assets/, fonts/). Run `npm run build` first.
 */

import {
  copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { paths, site } from './config.js';
import { parseSources } from './parser.js';
import { validate } from './validator.js';
import { render } from './renderer.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const at   = (p) => join(root, p);

function main() {
  const pkg    = JSON.parse(readFileSync(at(paths.pkg), 'utf8'));
  const readme = readFileSync(at(paths.readme), 'utf8');
  const bundle = at(paths.bundle);
  if (!existsSync(bundle)) {
    console.error(`[docs] ${paths.bundle} not found — run \`npm run build\` first.`);
    process.exit(1);
  }

  // Parse + validate.
  const parsed = parseSources(at(paths.src));
  const { errors, warnings } = validate(parsed);
  for (const w of warnings) console.warn(`[docs] warn  ${w}`);
  for (const e of errors)   console.error(`[docs] error ${e}`);
  if (errors.length) {
    console.error(`[docs] ${errors.length} error(s) — site not written.`);
    process.exit(1);
  }

  // Render.
  const pages = render(parsed, { pkg, readme });

  // Write site/ from scratch.
  const out = at(paths.site);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const [file, html] of pages) writeFileSync(join(out, file), html);

  copyFileSync(bundle, join(out, site.bundle));
  for (const asset of paths.readmeAssets) {
    if (existsSync(at(asset))) copyFileSync(at(asset), join(out, asset));
  }
  if (existsSync(at(paths.static))) cpSync(at(paths.static), out, { recursive: true });

  const examples = parsed.doclets.reduce((n, d) => n + d.examples.length, 0);
  console.log(`[docs] ${pages.size} page(s), ${parsed.doclets.length} doclet(s), ` +
              `${examples} example(s), ${warnings.length} warning(s) → ${paths.site}/`);
}

main();
