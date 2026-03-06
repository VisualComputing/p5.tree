import resolve from '@rollup/plugin-node-resolve';

export default [
  // 1) ESM build (npm/bundlers): keep deps external
  {
    input: 'src/index.js',
    external: ['p5', '@nakednous/tree', '@nakednous/ui'],
    output: {
      file: 'dist/p5.tree.esm.js',
      format: 'es',
      sourcemap: true
    },
    plugins: [resolve()]
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
    plugins: [resolve()]
  }
];
