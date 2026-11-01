// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { MemoryTier, TileCache, type TileCacheTier } from '../src/cache.ts';

const bytes = (...v: number[]) => new Uint8Array(v);

function makeCache(generate = vi.fn(async () => bytes(1, 2, 3))) {
  const hot = new MemoryTier();
  const cold = new MemoryTier();
  return { cache: new TileCache(hot, cold, { generate }), hot, cold, generate };
}

describe('three-tier tile cache', () => {
  it('generates on a full miss and populates both tiers', async () => {
    const { cache, hot, cold, generate } = makeCache();
    expect([...(await cache.get('t/0/0/0'))]).toEqual([1, 2, 3]);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(await hot.get('t/0/0/0')).not.toBeNull();
    expect(await cold.get('t/0/0/0')).not.toBeNull();
    expect(cache.stats.misses).toBe(1);
  });

  it('serves the second request from the hot tier without regenerating', async () => {
    const { cache, generate } = makeCache();
    await cache.get('k');
    await cache.get('k');
    expect(generate).toHaveBeenCalledTimes(1);
    expect(cache.stats.hotHits).toBe(1);
  });

  // A restart empties memory but not disk; the cold tier must warm the hot tier back up under
  // real traffic rather than needing a separate warming job.
  it('promotes a cold hit into the hot tier', async () => {
    const generate = vi.fn(async () => bytes(9));
    const hot = new MemoryTier();
    const cold = new MemoryTier();
    await cold.set('k', bytes(7));
    const cache = new TileCache(hot, cold, { generate });

    expect([...(await cache.get('k'))]).toEqual([7]);
    expect(generate).not.toHaveBeenCalled();
    expect(cache.stats.coldHits).toBe(1);
    expect([...(await hot.get('k'))!]).toEqual([7]);
  });

  it('evicts from every tier on invalidation', async () => {
    const { cache, hot, cold } = makeCache();
    await cache.get('k');
    await cache.invalidate('k');
    expect(await hot.get('k')).toBeNull();
    expect(await cold.get('k')).toBeNull();
  });

  it('regenerates lazily after invalidation rather than eagerly', async () => {
    const { cache, generate } = makeCache();
    await cache.get('k');
    await cache.invalidate('k');
    expect(generate).toHaveBeenCalledTimes(1); // no eager rebuild
    await cache.get('k');
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('invalidates a batch of keys', async () => {
    const { cache, hot } = makeCache();
    for (const k of ['a', 'b', 'c']) await cache.get(k);
    await cache.invalidateMany(['a', 'c']);
    expect(await hot.get('a')).toBeNull();
    expect(await hot.get('b')).not.toBeNull();
    expect(await hot.get('c')).toBeNull();
  });

  it('caches empty tiles, since "nothing here" is expensive to recompute', async () => {
    const generate = vi.fn(async () => new Uint8Array(0));
    const { cache } = makeCache(generate);
    await cache.get('empty');
    await cache.get('empty');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('can be configured not to cache empty tiles', async () => {
    const generate = vi.fn(async () => new Uint8Array(0));
    const cache = new TileCache(new MemoryTier(), new MemoryTier(), { generate, cacheEmpty: false });
    await cache.get('empty');
    await cache.get('empty');
    expect(generate).toHaveBeenCalledTimes(2);
  });

  // A cache is an optimization, not a dependency.
  it('still serves tiles when the hot tier is completely broken', async () => {
    const broken: TileCacheTier = {
      name: 'broken',
      get: async () => {
        throw new Error('valkey down');
      },
      set: async () => {
        throw new Error('valkey down');
      },
      delete: async () => {
        throw new Error('valkey down');
      },
    };
    const cache = new TileCache(broken, new MemoryTier(), { generate: async () => bytes(4, 5) });
    expect([...(await cache.get('k'))]).toEqual([4, 5]);
    expect(cache.stats.errors).toBeGreaterThan(0);
  });

  it('survives a broken cold tier too', async () => {
    const broken: TileCacheTier = {
      name: 'broken',
      get: async () => {
        throw new Error('disk full');
      },
      set: async () => {
        throw new Error('disk full');
      },
      delete: async () => undefined,
    };
    const cache = new TileCache(new MemoryTier(), broken, { generate: async () => bytes(1) });
    expect([...(await cache.get('k'))]).toEqual([1]);
  });

  it('reports a hit rate for the performance dashboards', async () => {
    const { cache } = makeCache();
    expect(cache.hitRate).toBe(0);
    await cache.get('a');
    await cache.get('a');
    await cache.get('a');
    expect(cache.hitRate).toBeCloseTo(2 / 3, 6);
  });
});

describe('MemoryTier', () => {
  it('evicts least recently used entries beyond its bound', async () => {
    const tier = new MemoryTier(3);
    await tier.set('a', bytes(1));
    await tier.set('b', bytes(2));
    await tier.set('c', bytes(3));
    await tier.get('a'); // refresh a
    await tier.set('d', bytes(4)); // should evict b
    expect(tier.size).toBe(3);
    expect(await tier.get('b')).toBeNull();
    expect(await tier.get('a')).not.toBeNull();
  });

  it('overwrites without growing', async () => {
    const tier = new MemoryTier(10);
    await tier.set('k', bytes(1));
    await tier.set('k', bytes(2));
    expect(tier.size).toBe(1);
    expect([...(await tier.get('k'))!]).toEqual([2]);
  });
});
