// Copyright (c) 2026 Dobromir. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
//
// Use of this file is governed by the Business Source License 1.1 found in the
// LICENSE file at the root of this repository. Production use requires a
// commercial license until the Change Date, after which the Change License
// (Apache-2.0) applies.

/**
 * Verifies fixtures still match their manifest.
 *
 * Fixtures that drift silently make every test built on them meaningless, so entity counts are
 * recorded at generation time and checked here.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(process.cwd(), 'fixtures');
const manifestPath = join(DIR, 'manifest.json');

if (!existsSync(manifestPath)) {
  console.error('No fixtures/manifest.json. Run: pnpm fixtures:generate');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, number>;
let failed = false;

for (const [name, expected] of Object.entries(manifest)) {
  const path = join(DIR, name);
  if (!existsSync(path)) {
    console.error(`MISSING  ${name}`);
    failed = true;
    continue;
  }
  if (name.endsWith('.dxf')) {
    const text = readFileSync(path, 'utf-8');
    // Count entity starts inside the ENTITIES section only.
    const entitiesSection = text.slice(text.indexOf('\nENTITIES\n'));
    const actual = (entitiesSection.match(/^0\n(POINT|LINE|CIRCLE|ARC|LWPOLYLINE|TEXT|INSERT)$/gm) ?? []).length;
    const ok = actual === expected;
    if (!ok) failed = true;
    console.log(
      `${ok ? 'OK      ' : 'MISMATCH'} ${name.padEnd(20)} ${actual.toLocaleString()} entities ` +
        `(expected ${expected.toLocaleString()}, ${(statSync(path).size / 1024).toFixed(0)} KiB)`,
    );
  } else {
    console.log(`OK       ${name.padEnd(20)} present (${(statSync(path).size / 1024).toFixed(0)} KiB)`);
  }
}

process.exit(failed ? 1 : 0);
