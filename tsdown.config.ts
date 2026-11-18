import { defineConfig } from 'tsdown'

// DSH's browser module table owns these identities. Bundling either one would
// give slot components a second React runtime and make their Hooks invalid in
// the host renderer.
const CLIENT_EXTERNALS = new Set(['react', 'react/jsx-runtime', 'react-dom'])

/** Build the public entry point and invariant companion from TypeScript output. */
export default defineConfig([
  {
    entry: { preferences: 'lib/types/entries/preferences.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: { index: 'lib/types/entries/index.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: { 'tool-policy': 'lib/types/entries/tool-policy.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: { 'hybrid-executor': 'lib/types/entries/hybrid-executor.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: { 'compact-command': 'lib/types/entries/compact-command.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: { compaction: 'lib/types/entries/compaction.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: { typert: 'lib/types/entries/typert.host.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: { client: 'lib/types/entries/client.js' },
    outDir: 'lib',
    // DSH loads client plugins through a closure factory, not as native ESM.
    format: ['cjs'],
    platform: 'browser',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    clean: false,
    // React's browser CJS entry reads this Node-style global at runtime. The
    // DSH client preset replaces it at build time before the bundle reaches
    // the browser module loader.
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    deps: {
      neverBundle: (specifier: string) => CLIENT_EXTERNALS.has(specifier),
      alwaysBundle: (specifier: string) => !CLIENT_EXTERNALS.has(specifier),
    },
    outputOptions: {
      exports: 'named',
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "@shuind/dsh-codex-harness", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
