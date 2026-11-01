// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

/**
 * Extended Well-Known Binary (EWKB) encoding — PostGIS's native geometry wire format.
 *
 * Why binary rather than WKT text: guardrail G2 requires coordinates to round-trip through the
 * database BIT-EXACTLY. Text formatting does not guarantee that. `Number.prototype.toString`
 * produces the shortest round-trippable decimal, PostGIS parses with its own reader, and
 * `ST_AsText` truncates to 15 significant digits by default. Somewhere in that chain a surveyor's
 * millimetre quietly disappears.
 *
 * EWKB writes IEEE-754 doubles as 8 raw bytes. There is no formatting step, so nothing can round.
 *
 * Layout (little-endian):
 *   byte      order flag, 1 = little-endian
 *   uint32    geometry type, OR-ed with EWKB flags
 *   uint32    SRID          (present when the SRID flag is set)
 *   ...       geometry body, doubles throughout
 */

export const EWKB_FLAG_Z = 0x8000_0000;
export const EWKB_FLAG_SRID = 0x2000_0000;

export const WKB_POINT = 1;
export const WKB_LINESTRING = 2;
export const WKB_POLYGON = 3;

export type WkbGeometryType = 'Point' | 'LineString' | 'Polygon';

export interface WkbGeometry {
  readonly type: WkbGeometryType;
  readonly srid: number;
  readonly hasZ: boolean;
  /**
   * Point:      [[x, y, z?]]
   * LineString: [[x, y, z?], ...]
   * Polygon:    outer ring only, closed. Interior rings are not used by wCAD element geometry.
   */
  readonly coordinates: ReadonlyArray<readonly number[]>;
}

class ByteWriter {
  #buf: Uint8Array;
  #view: DataView;
  #pos = 0;

  constructor(size: number) {
    this.#buf = new Uint8Array(size);
    this.#view = new DataView(this.#buf.buffer);
  }

  u8(v: number): void {
    this.#view.setUint8(this.#pos, v);
    this.#pos += 1;
  }

  u32(v: number): void {
    this.#view.setUint32(this.#pos, v >>> 0, true);
    this.#pos += 4;
  }

  f64(v: number): void {
    this.#view.setFloat64(this.#pos, v, true);
    this.#pos += 8;
  }

  done(): Uint8Array {
    if (this.#pos !== this.#buf.length) {
      throw new Error(`WKB writer size mismatch: wrote ${this.#pos} of ${this.#buf.length} bytes`);
    }
    return this.#buf;
  }
}

class ByteReader {
  #view: DataView;
  #pos = 0;
  #le = true;

  constructor(buf: Uint8Array) {
    this.#view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  order(): void {
    this.#le = this.#view.getUint8(this.#pos) === 1;
    this.#pos += 1;
  }

  u32(): number {
    const v = this.#view.getUint32(this.#pos, this.#le);
    this.#pos += 4;
    return v >>> 0;
  }

  f64(): number {
    const v = this.#view.getFloat64(this.#pos, this.#le);
    this.#pos += 8;
    return v;
  }
}

function ordinates(hasZ: boolean): number {
  return hasZ ? 3 : 2;
}

function bodySize(geom: WkbGeometry): number {
  const per = ordinates(geom.hasZ) * 8;
  switch (geom.type) {
    case 'Point':
      return per;
    case 'LineString':
      return 4 + geom.coordinates.length * per;
    case 'Polygon':
      return 4 + 4 + geom.coordinates.length * per;
  }
}

export function encodeEwkb(geom: WkbGeometry): Uint8Array {
  validate(geom);
  const header = 1 + 4 + 4; // order + type + srid
  const w = new ByteWriter(header + bodySize(geom));

  const baseType = geom.type === 'Point' ? WKB_POINT : geom.type === 'LineString' ? WKB_LINESTRING : WKB_POLYGON;
  w.u8(1);
  w.u32((baseType | EWKB_FLAG_SRID | (geom.hasZ ? EWKB_FLAG_Z : 0)) >>> 0);
  w.u32(geom.srid);

  const n = ordinates(geom.hasZ);
  const writePoints = () => {
    for (const c of geom.coordinates) {
      for (let i = 0; i < n; i++) w.f64(c[i] ?? 0);
    }
  };

  if (geom.type === 'Point') {
    writePoints();
  } else if (geom.type === 'LineString') {
    w.u32(geom.coordinates.length);
    writePoints();
  } else {
    w.u32(1); // single outer ring
    w.u32(geom.coordinates.length);
    writePoints();
  }

  return w.done();
}

export function decodeEwkb(buf: Uint8Array): WkbGeometry {
  const r = new ByteReader(buf);
  r.order();
  const raw = r.u32();
  const hasZ = (raw & EWKB_FLAG_Z) !== 0;
  const hasSrid = (raw & EWKB_FLAG_SRID) !== 0;
  const baseType = raw & 0x0000_ffff;
  const srid = hasSrid ? r.u32() : 0;
  const n = ordinates(hasZ);

  const readPoints = (count: number): number[][] => {
    const out: number[][] = new Array(count);
    for (let i = 0; i < count; i++) {
      const c: number[] = new Array(n);
      for (let j = 0; j < n; j++) c[j] = r.f64();
      out[i] = c;
    }
    return out;
  };

  if (baseType === WKB_POINT) {
    return { type: 'Point', srid, hasZ, coordinates: readPoints(1) };
  }
  if (baseType === WKB_LINESTRING) {
    return { type: 'LineString', srid, hasZ, coordinates: readPoints(r.u32()) };
  }
  if (baseType === WKB_POLYGON) {
    const rings = r.u32();
    if (rings < 1) return { type: 'Polygon', srid, hasZ, coordinates: [] };
    const outer = readPoints(r.u32());
    return { type: 'Polygon', srid, hasZ, coordinates: outer };
  }
  throw new Error(`Unsupported WKB geometry type: ${baseType}`);
}

/** PostGIS accepts EWKB as a lowercase hex string, which is what the pg driver sends cleanly. */
export function toHex(buf: Uint8Array): string {
  let s = '';
  for (const b of buf) s += b.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith('\\x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error('Hex string has an odd length');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function validate(geom: WkbGeometry): void {
  if (!Number.isInteger(geom.srid) || geom.srid < 0) {
    throw new Error(`SRID must be a non-negative integer, got ${geom.srid}`);
  }
  if (geom.coordinates.length === 0) {
    throw new Error(`${geom.type} needs at least one coordinate`);
  }
  if (geom.type === 'Point' && geom.coordinates.length !== 1) {
    throw new Error(`Point must have exactly one coordinate, got ${geom.coordinates.length}`);
  }
  if (geom.type === 'LineString' && geom.coordinates.length < 2) {
    throw new Error('LineString needs at least two coordinates');
  }
  if (geom.type === 'Polygon') {
    if (geom.coordinates.length < 4) throw new Error('Polygon ring needs at least four coordinates');
    const first = geom.coordinates[0]!;
    const last = geom.coordinates[geom.coordinates.length - 1]!;
    if (first[0] !== last[0] || first[1] !== last[1]) {
      throw new Error('Polygon ring must be closed: the last coordinate must equal the first');
    }
  }
  const need = ordinates(geom.hasZ);
  for (const c of geom.coordinates) {
    if (c.length < need) {
      throw new Error(`Coordinate needs ${need} ordinates for this geometry, got ${c.length}`);
    }
  }
}
