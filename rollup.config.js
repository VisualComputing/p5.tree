import { readFileSync } from 'node:fs';
import resolve from '@rollup/plugin-node-resolve';

/**
 * `p5.Tree.VERSION` is the version being published, and a literal that drifts
 * from package.json is a lie in every consumer's console — it read 0.0.51 for
 * ten releases — so the build refuses instead of shipping the disagreement.
 */
const versionAgrees = () => ({
  name: 'version-agrees',
  buildStart() {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    const src = readFileSync(new URL('./src/constants.js', import.meta.url), 'utf8');
    const lit = /VERSION: CONST\('([^']+)'\)/.exec(src);
    if (!lit) this.error('src/constants.js: `VERSION: CONST(…)` not found');
    else if (lit[1] !== pkg.version)
      this.error(`src/constants.js VERSION is ${lit[1]} but package.json is ${pkg.version}`);
  },
});

export default [
  // 1) ESM build (npm/bundlers): keep deps external
  {
    input: 'src/index.js',
    external: ['p5', '@nakednous/tree', '@nakednous/host', '@nakednous/ui'],
    output: {
      file: 'dist/p5.tree.esm.js',
      format: 'es',
      sourcemap: true
    },
    plugins: [resolve(), versionAgrees()]
  },

  // 2) IIFE build (CDN <script>): bundle tree + ui, externalize only p5
  {
    input: 'src/index.js',
    external: ['p5'],
    output: {
      file: 'dist/p5.tree.js',
      format: 'iife',
      name: 'Tree',
      globals: { p5: 'p5' },
      exports: 'none',
      sourcemap: true
    },
    plugins: [resolve(), versionAgrees()]
  }
];
