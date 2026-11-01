// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

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

    // Version, not just entity count. Fixtures written by the original writer declared AC1009
    // (R12) while containing LWPOLYLINE — an entity that did not exist until R14 — and no subclass
    // markers. Our own lenient parser read them happily; ezdxf rejected them nine minutes into a
    // 10M-entity import. A fixture only our own code can read tests nothing about reading real
    // files, so a stale one must fail here rather than mid-benchmark.
    if (!text.slice(0, 4096).includes('AC1015')) {
      console.error(`STALE    ${name.padEnd(20)} not valid R2000 DXF — regenerate with pnpm fixtures:generate`);
      failed = true;
      continue;
    }

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
