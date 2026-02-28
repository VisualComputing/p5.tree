// rollup.config.js
import resolve from '@rollup/plugin-node-resolve';

const external = ['p5'];

export default [
  // 1. ESM build (for bundlers like Vite / npm)
  {
    input: 'src/index.js',
    external,
    output: {
      file: 'dist/p5.tree.esm.js',
      format: 'es',
      sourcemap: true
    },
    plugins: [resolve()]
  },
  // 2. IIFE build (for <script> usage)
  {
    input: 'src/index.js',
    external,
    output: {
      file: 'dist/p5.tree.js',
      format: 'iife',
      name: 'Tree',
      globals: { p5: 'p5' },
      exports: 'none',
      sourcemap: true
    },
    plugins: [resolve()]
  }
];
