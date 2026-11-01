// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

/**
 * Three-tier tile cache (architecture doc section 5, point 3).
 *
 *   hot  — Valkey, in memory, shared across API replicas
 *   cold — object store on disk, survives restarts and is cheap per byte
 *   miss — generate from PostGIS, then promote into both tiers
 *
 * A hit in the cold tier is promoted back into hot, so a restart warms itself under real traffic
 * instead of needing a warming job.
 *
 * The tiers are behind narrow interfaces so the whole policy is testable with fakes. Cache
 * behaviour is the sort of thing that looks obviously correct and is quietly wrong — a promotion
 * that never fires or an invalidation that misses a tier costs a lot of confused debugging.
 */

export interface TileCacheTier {
  readonly name: string;
  get(key: string): Promise<Uint8Array | null>;
  set(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface TileCacheStats {
  hotHits: number;
  coldHits: number;
  misses: number;
  errors: number;
}

export interface TileCacheOptions {
  /** Called when both tiers miss. Must be deterministic for the same inputs. */
  generate(key: string): Promise<Uint8Array>;
  /** Cache empty tiles too: "nothing here" is an expensive answer to recompute. */
  cacheEmpty?: boolean;
}

export class TileCache {
  readonly stats: TileCacheStats = { hotHits: 0, coldHits: 0, misses: 0, errors: 0 };

  // Explicit fields rather than constructor parameter properties: these services run under
  // `node --experimental-strip-types`, which only erases type annotations and cannot generate
  // code. A parameter property needs a generated assignment, so it fails to parse there.
  readonly #hot: TileCacheTier;
  readonly #cold: TileCacheTier;
  readonly #opts: TileCacheOptions;

  constructor(hot: TileCacheTier, cold: TileCacheTier, opts: TileCacheOptions) {
    this.#hot = hot;
    this.#cold = cold;
    this.#opts = opts;
  }

  async get(key: string): Promise<Uint8Array> {
    const hot = await this.#safe(() => this.#hot.get(key));
    if (hot) {
      this.stats.hotHits++;
      return hot;
    }

    const cold = await this.#safe(() => this.#cold.get(key));
    if (cold) {
      this.stats.coldHits++;
      // Promote so the next request is served from memory.
      await this.#safe(() => this.#hot.set(key, cold));
      return cold;
    }

    this.stats.misses++;
    const generated = await this.#opts.generate(key);
    if (generated.length > 0 || this.#opts.cacheEmpty !== false) {
      await this.#safe(() => this.#hot.set(key, generated));
      await this.#safe(() => this.#cold.set(key, generated));
    }
    return generated;
  }

  /** Evicts from every tier. Regeneration is lazy, on the next request. */
  async invalidate(key: string): Promise<void> {
    await this.#safe(() => this.#hot.delete(key));
    await this.#safe(() => this.#cold.delete(key));
  }

  async invalidateMany(keys: readonly string[]): Promise<void> {
    for (const key of keys) await this.invalidate(key);
  }

  get hitRate(): number {
    const total = this.stats.hotHits + this.stats.coldHits + this.stats.misses;
    return total === 0 ? 0 : (this.stats.hotHits + this.stats.coldHits) / total;
  }

  /**
   * A cache is an optimization, never a dependency. If Valkey is down the tile still gets
   * served from PostGIS — slower, but the application stays up.
   */
  async #safe<T>(op: () => Promise<T>): Promise<T | null> {
    try {
      return await op();
    } catch {
      this.stats.errors++;
      return null;
    }
  }
}

/** In-memory tier with a bounded entry count. Used in tests and as a per-process L0. */
export class MemoryTier implements TileCacheTier {
  readonly name = 'memory';
  readonly #map = new Map<string, Uint8Array>();

  readonly #maxEntries: number;

  constructor(maxEntries = 1000) {
    this.#maxEntries = maxEntries;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const v = this.#map.get(key);
    if (!v) return null;
    // Refresh LRU position.
    this.#map.delete(key);
    this.#map.set(key, v);
    return v;
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    this.#map.delete(key);
    this.#map.set(key, value);
    while (this.#map.size > this.#maxEntries) {
      const oldest = this.#map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#map.delete(oldest);
    }
  }

  async delete(key: string): Promise<void> {
    this.#map.delete(key);
  }

  get size(): number {
    return this.#map.size;
  }
}
