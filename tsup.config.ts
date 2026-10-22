import { defineConfig } from 'tsup';

const shared = {
  format: ['esm', 'cjs'] as Array<'esm' | 'cjs'>,
  dts: true,
  sourcemap: true,
  treeshake: true,
  clean: false,
  target: 'es2022',
  outDir: 'dist',
};

export default defineConfig([
  {
    ...shared,
    clean: true,
    entry: {
      index: 'src/index.ts',
      'testing/index': 'src/testing/index.ts',
    },
    external: ['react'],
  },
  {
    ...shared,
    entry: {
      'react/index': 'src/react/index.ts',
    },
    external: ['react'],
    // The entry carries a `'use client'` directive; treeshake drops it.
    treeshake: false,
  },
]);
