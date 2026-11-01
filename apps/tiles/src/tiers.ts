// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type Redis from 'ioredis';
import type { TileCacheTier } from './cache.ts';

/** Hot tier: Valkey, shared across API replicas. */
export class ValkeyTier implements TileCacheTier {
  readonly name = 'valkey';

  // Explicit fields, not constructor parameter properties: this service runs under
  // `node --experimental-strip-types`, which erases types without generating code, and a
  // parameter property requires a generated assignment.
  readonly #client: Redis;
  readonly #ttlSeconds: number;

  constructor(client: Redis, ttlSeconds = 3600) {
    this.#client = client;
    this.#ttlSeconds = ttlSeconds;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const buf = await this.#client.getBuffer(this.#k(key));
    return buf ? new Uint8Array(buf) : null;
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    await this.#client.set(this.#k(key), Buffer.from(value), 'EX', this.#ttlSeconds);
  }

  async delete(key: string): Promise<void> {
    await this.#client.del(this.#k(key));
  }

  #k(key: string): string {
    return `tile:${key}`;
  }
}

/**
 * Cold tier: plain files on a mounted volume.
 *
 * Keys are hashed into a two-level directory fan-out. A single flat directory with millions of
 * tile files is pathological on most filesystems, and tile keys contain characters (`/`, `?`,
 * `,`) that cannot go into a filename unescaped anyway.
 */
export class FilesystemTier implements TileCacheTier {
  readonly name = 'filesystem';

  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.#path(key)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    const path = this.#path(key);
    await mkdir(dirname(path), { recursive: true });
    // Write-then-rename so a concurrent reader never sees a half-written tile.
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, value);
    await rename(tmp, path);
  }

  async delete(key: string): Promise<void> {
    await rm(this.#path(key), { force: true });
  }

  #path(key: string): string {
    const hash = createHash('sha256').update(key).digest('hex');
    return join(this.#root, hash.slice(0, 2), hash.slice(2, 4), `${hash}.mvt`);
  }
}

async function rename(from: string, to: string): Promise<void> {
  const { rename: fsRename } = await import('node:fs/promises');
  await fsRename(from, to);
}
