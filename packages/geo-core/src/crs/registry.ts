// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import proj4 from 'proj4';
import type { Coord2, Coord3, CrsDefinition } from '../types.ts';
import { BUILTIN_CRS } from './definitions.ts';
import { baseToLocal, baseToLocal3, localToBase, localToBase3, validateLocalCrs } from './localCrs.ts';

/**
 * The single source of truth for coordinate systems (architecture doc section 9).
 *
 * The same registry content is consumed by the web app, the API and — via a generated
 * Python module — the workers. Never maintain a second hand-written copy: divergence here
 * produces silently shifted data.
 */
export class CrsRegistry {
  readonly #defs = new Map<string, CrsDefinition>();

  constructor(defs: readonly CrsDefinition[] = BUILTIN_CRS) {
    for (const d of defs) this.register(d);
  }

  register(def: CrsDefinition): void {
    if (def.kind === 'local') {
      if (!def.local) throw new Error(`Local CRS ${def.code} is missing local parameters`);
      validateLocalCrs(def.local);
      if (!this.#defs.has(def.local.baseCrs) && !BUILTIN_CRS.some((b) => b.code === def.local!.baseCrs)) {
        throw new Error(`Local CRS ${def.code} references unknown base CRS ${def.local.baseCrs}`);
      }
    } else {
      if (!def.proj4) throw new Error(`CRS ${def.code} of kind ${def.kind} requires a proj4 string`);
      proj4.defs(def.code, def.proj4);
    }
    this.#defs.set(def.code, def);
  }

  get(code: string): CrsDefinition {
    const d = this.#defs.get(code);
    if (!d) throw new Error(`Unknown CRS: ${code}`);
    return d;
  }

  has(code: string): boolean {
    return this.#defs.has(code);
  }

  list(): readonly CrsDefinition[] {
    return [...this.#defs.values()];
  }

  /** Transform a 2D coordinate between any two registered systems, including local ones. */
  transform(from: string, to: string, p: Coord2): Coord2 {
    if (from === to) return [p[0], p[1]];
    const fromDef = this.get(from);
    const toDef = this.get(to);

    // Resolve local systems down to their base CRS first, then project.
    if (fromDef.kind === 'local') {
      const base = localToBase(p, fromDef.local!);
      return this.transform(fromDef.local!.baseCrs, to, base);
    }
    if (toDef.kind === 'local') {
      const inBase = this.transform(from, toDef.local!.baseCrs, p);
      return baseToLocal(inBase, toDef.local!);
    }
    const out = proj4(from, to, [p[0], p[1]]);
    return [out[0]!, out[1]!];
  }

  /** 3D variant. Height is treated as an offset only — no geoid model is applied. */
  transform3(from: string, to: string, p: Coord3): Coord3 {
    if (from === to) return [p[0], p[1], p[2]];
    const fromDef = this.get(from);
    const toDef = this.get(to);
    if (fromDef.kind === 'local') {
      const base = localToBase3(p, fromDef.local!);
      return this.transform3(fromDef.local!.baseCrs, to, base);
    }
    if (toDef.kind === 'local') {
      const inBase = this.transform3(from, toDef.local!.baseCrs, p);
      return baseToLocal3(inBase, toDef.local!);
    }
    const xy = this.transform(from, to, [p[0], p[1]]);
    return [xy[0], xy[1], p[2]];
  }

  /** Axis labels for UI readouts and typed coordinate entry (X/Y/Z vs N/E/H vs Lon/Lat). */
  axisLabels(code: string): readonly [string, string, string] {
    return this.get(code).axisLabels;
  }
}

export const defaultRegistry = new CrsRegistry();
