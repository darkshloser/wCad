/**
 * Architectural guardrails, enforced mechanically rather than by convention
 * (IMPLEMENTATION-PLAN.md section 3).
 */
module.exports = {
  forbidden: [
    {
      name: 'no-editing-from-tiles',
      comment:
        'G1: editing, snapping and measurement must never consume tile or backdrop geometry. ' +
        'Tile data is generalized and quantized; editing from it silently corrupts drawings (P1). ' +
        'Load authoritative geometry through the exact-geometry API instead.',
      severity: 'error',
      from: { path: '(editing|snapping|measurement)/' },
      to: { path: '(tiles|backdrop|mvt)/' },
    },
    {
      name: 'geo-core-is-standalone',
      comment:
        'geo-core is shared by the web app, the API and (via generation) the workers. It must not ' +
        'depend on any application package, or the shared-math guarantee breaks.',
      severity: 'error',
      from: { path: '^packages/geo-core' },
      to: { path: '^(apps|packages/store-)' },
    },
    {
      name: 'store-contract-has-no-implementation-deps',
      comment:
        'The contract must not import a concrete store, otherwise the conformance guarantee (G3) ' +
        'becomes circular.',
      severity: 'error',
      from: { path: '^packages/store-contract/src/GeometryStore' },
      to: { path: '(postgis|sqlite|remote)' },
    },
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
    { name: 'no-orphans', severity: 'warn', from: { orphan: true, pathNot: ['\\.d\\.ts$', 'config'] }, to: {} },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    exclude: { path: '(node_modules|dist|coverage)' },
  },
};
