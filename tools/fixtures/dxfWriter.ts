// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

/**
 * Minimal streaming DXF (R2000 / AC1015 ASCII) writer for test fixtures.
 *
 * Deliberately hand-rolled and dependency-free: fixtures must be generatable in CI without
 * network access, and a fixture generator that shares a library with the importer would let a
 * single wrong assumption pass through both sides unnoticed.
 *
 * Output is written incrementally so a 10M-entity fixture never lives in memory.
 *
 * R2000, not R12. The first version of this writer declared AC1009 (R12) while emitting
 * LWPOLYLINE, which did not exist until R14, and omitted the `100` subclass markers that R2000+
 * requires. Our own lenient TypeScript parser read it happily, so the fixtures looked fine until
 * ezdxf — a real DXF reader — rejected them with "missing 'AcDbPolyline' subclass". Fixtures that
 * only our own code can read test nothing about reading real files, so this now emits handles and
 * subclass markers the way AutoCAD does.
 */

import { createWriteStream, type WriteStream } from 'node:fs';
import { once } from 'node:events';

export type Entity =
  | { type: 'POINT'; layer: string; x: number; y: number; z?: number }
  | { type: 'LINE'; layer: string; x1: number; y1: number; x2: number; y2: number; z?: number }
  | { type: 'CIRCLE'; layer: string; cx: number; cy: number; r: number }
  | { type: 'ARC'; layer: string; cx: number; cy: number; r: number; startDeg: number; endDeg: number }
  | { type: 'LWPOLYLINE'; layer: string; points: Array<[number, number]>; closed?: boolean; bulges?: number[] }
  | { type: 'TEXT'; layer: string; x: number; y: number; height: number; value: string }
  | { type: 'INSERT'; layer: string; blockName: string; x: number; y: number; rotationDeg?: number };

export class DxfWriter {
  #stream: WriteStream;
  #pending = 0;
  #entityCount = 0;
  // DXF handles are hex strings and must be unique within the file. Starting well clear of the
  // low values a real file reserves for its tables.
  #handle = 0x1000;

  constructor(path: string) {
    this.#stream = createWriteStream(path, { encoding: 'utf-8', highWaterMark: 1 << 20 });
  }

  get entityCount(): number {
    return this.#entityCount;
  }

  async #write(text: string): Promise<void> {
    if (!this.#stream.write(text)) {
      this.#pending++;
      await once(this.#stream, 'drain');
      this.#pending--;
    }
  }

  #pair(code: number, value: string | number): string {
    return `${code}\n${value}\n`;
  }

  async begin(blocks: Array<{ name: string; entities: Entity[] }> = []): Promise<void> {
    let head = '';
    head += this.#pair(0, 'SECTION') + this.#pair(2, 'HEADER');
    head += this.#pair(9, '$ACADVER') + this.#pair(1, 'AC1015');
    head += this.#pair(9, '$INSBASE') + this.#pair(10, 0) + this.#pair(20, 0) + this.#pair(30, 0);
    head += this.#pair(9, '$HANDSEED') + this.#pair(5, 'FFFF');
    head += this.#pair(0, 'ENDSEC');

    head += this.#pair(0, 'SECTION') + this.#pair(2, 'BLOCKS');
    for (const block of blocks) {
      head += this.#pair(0, 'BLOCK') + this.#pair(5, this.#nextHandle());
      head += this.#pair(100, 'AcDbEntity') + this.#pair(8, '0');
      head += this.#pair(100, 'AcDbBlockBegin');
      head += this.#pair(2, block.name) + this.#pair(70, 0);
      head += this.#pair(10, 0) + this.#pair(20, 0) + this.#pair(30, 0) + this.#pair(3, block.name);
      head += this.#pair(1, '');
      for (const e of block.entities) head += this.#entity(e);
      head += this.#pair(0, 'ENDBLK') + this.#pair(5, this.#nextHandle());
      head += this.#pair(100, 'AcDbEntity') + this.#pair(8, '0');
      head += this.#pair(100, 'AcDbBlockEnd');
    }
    head += this.#pair(0, 'ENDSEC');

    head += this.#pair(0, 'SECTION') + this.#pair(2, 'ENTITIES');
    await this.#write(head);
  }

  #nextHandle(): string {
    return (this.#handle++).toString(16).toUpperCase();
  }

  /**
   * One entity in R2000 form.
   *
   * Layout is fixed by the specification: type, handle, `AcDbEntity` subclass with the common
   * attributes, then the type-specific subclass with its own. ARC carries two subclass markers
   * because it extends CIRCLE.
   */
  #entity(e: Entity): string {
    let s = this.#pair(0, e.type) + this.#pair(5, this.#nextHandle());
    s += this.#pair(100, 'AcDbEntity') + this.#pair(8, e.layer);

    switch (e.type) {
      case 'POINT':
        s += this.#pair(100, 'AcDbPoint');
        s += this.#pair(10, e.x) + this.#pair(20, e.y) + this.#pair(30, e.z ?? 0);
        break;
      case 'LINE':
        s += this.#pair(100, 'AcDbLine');
        s +=
          this.#pair(10, e.x1) + this.#pair(20, e.y1) + this.#pair(30, e.z ?? 0) +
          this.#pair(11, e.x2) + this.#pair(21, e.y2) + this.#pair(31, e.z ?? 0);
        break;
      case 'CIRCLE':
        s += this.#pair(100, 'AcDbCircle');
        s += this.#pair(10, e.cx) + this.#pair(20, e.cy) + this.#pair(30, 0) + this.#pair(40, e.r);
        break;
      case 'ARC':
        // An ARC is a CIRCLE with angles, and the file must say so in that order.
        s += this.#pair(100, 'AcDbCircle');
        s += this.#pair(10, e.cx) + this.#pair(20, e.cy) + this.#pair(30, 0) + this.#pair(40, e.r);
        s += this.#pair(100, 'AcDbArc');
        s += this.#pair(50, e.startDeg) + this.#pair(51, e.endDeg);
        break;
      case 'LWPOLYLINE':
        s += this.#pair(100, 'AcDbPolyline');
        s += this.#pair(90, e.points.length) + this.#pair(70, e.closed ? 1 : 0);
        for (let i = 0; i < e.points.length; i++) {
          s += this.#pair(10, e.points[i]![0]) + this.#pair(20, e.points[i]![1]);
          const bulge = e.bulges?.[i];
          if (bulge !== undefined && bulge !== 0) s += this.#pair(42, bulge);
        }
        break;
      case 'TEXT':
        s += this.#pair(100, 'AcDbText');
        s +=
          this.#pair(10, e.x) + this.#pair(20, e.y) + this.#pair(30, 0) +
          this.#pair(40, e.height) + this.#pair(1, e.value);
        break;
      case 'INSERT':
        s += this.#pair(100, 'AcDbBlockReference');
        s += this.#pair(2, e.blockName) + this.#pair(10, e.x) + this.#pair(20, e.y) + this.#pair(30, 0);
        if (e.rotationDeg) s += this.#pair(50, e.rotationDeg);
        break;
    }
    return s;
  }

  async add(e: Entity): Promise<void> {
    this.#entityCount++;
    await this.#write(this.#entity(e));
  }

  /** Batched writer: one string build per chunk keeps 10M-entity generation practical. */
  async addMany(entities: Entity[]): Promise<void> {
    let buf = '';
    for (const e of entities) {
      buf += this.#entity(e);
      this.#entityCount++;
    }
    await this.#write(buf);
  }

  async end(): Promise<void> {
    // ENTITIES is followed by OBJECTS in every real R2000 file, and streaming readers rely on it:
    // ezdxf's iterdxf locates the end of the entity stream by finding the OBJECTS section, and
    // refuses to open a file without one ("OBJECTS section not found").
    let tail = this.#pair(0, 'ENDSEC');
    tail += this.#pair(0, 'SECTION') + this.#pair(2, 'OBJECTS');
    tail += this.#pair(0, 'DICTIONARY') + this.#pair(5, this.#nextHandle());
    tail += this.#pair(100, 'AcDbDictionary') + this.#pair(281, 1);
    tail += this.#pair(0, 'ENDSEC');
    tail += this.#pair(0, 'EOF');
    await this.#write(tail);
    await new Promise<void>((resolve, reject) => {
      this.#stream.end((err?: Error) => (err ? reject(err) : resolve()));
    });
  }
}
