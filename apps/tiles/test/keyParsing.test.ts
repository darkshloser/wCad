// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { tileKey } from '@wcad/tiling';

/**
 * The tile service turns a cache key back into a generation request. Key construction and
 * parsing must therefore be exact inverses — a mismatch means every request misses the cache
 * while still appearing to work, which is an expensive bug to notice.
 */
function parseKey(key: string) {
  const [path, query] = key.split('?');
  const parts = path!.split('/');
  if (parts.length !== 4) return null;
  const layers = query?.startsWith('l=') ? query.slice(2).split(',') : undefined;
  return {
    projectId: parts[0]!,
    tile: { z: Number(parts[1]), x: Number(parts[2]), y: Number(parts[3]) },
    layerIds: layers,
  };
}

describe('tile cache key round-trip', () => {
  it('parses a key without layers', () => {
    const key = tileKey('42', { z: 5, x: 3, y: 9 });
    expect(parseKey(key)).toEqual({ projectId: '42', tile: { z: 5, x: 3, y: 9 }, layerIds: undefined });
  });

  it('parses a key with a layer filter', () => {
    const key = tileKey('42', { z: 1, x: 0, y: 1 }, ['B', 'A']);
    expect(parseKey(key)).toEqual({ projectId: '42', tile: { z: 1, x: 0, y: 1 }, layerIds: ['A', 'B'] });
  });

  it('rejects a malformed key rather than generating the wrong tile', () => {
    expect(parseKey('nonsense')).toBeNull();
    expect(parseKey('a/b')).toBeNull();
  });

  it('round-trips every key the scheme can produce', () => {
    for (const layers of [undefined, ['A'], ['A', 'B', 'C']]) {
      for (let z = 0; z < 6; z++) {
        const tile = { z, x: z, y: z + 1 };
        const parsed = parseKey(tileKey('7', tile, layers))!;
        expect(parsed.tile).toEqual(tile);
        expect(parsed.projectId).toBe('7');
        expect(parsed.layerIds).toEqual(layers ? [...layers].sort() : undefined);
      }
    }
  });
});
