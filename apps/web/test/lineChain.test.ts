// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later

// knowledge/line-tool-spec.md, section by section.

import { describe, expect, it } from 'vitest';
import {
  EMPTY_CHAIN,
  type LineChain,
  chainActive,
  lineClick,
  lineUndo,
  segmentRejected,
  segmentStored,
} from '../src/map/lineChain.ts';

const A = [500000, 4650000] as const;
const B = [500010, 4650000] as const;
const C = [500010, 4650010] as const;

/** Clicks through points, storing each segment with a sequential id. */
function draw(...pts: Array<readonly [number, number]>): LineChain {
  let chain = EMPTY_CHAIN;
  let n = 0;
  for (const p of pts) {
    const r = lineClick(chain, p);
    chain = r.chain;
    if (r.kind === 'segment') chain = segmentStored(chain, r.from, r.to, `el_${++n}`);
  }
  return chain;
}

describe('§2 drawing', () => {
  it('first click starts the chain and creates nothing', () => {
    const r = lineClick(EMPTY_CHAIN, A);
    expect(r.kind).toBe('start');
    expect(r.chain.start).toEqual(A);
    expect(chainActive(r.chain)).toBe(true);
  });

  it('each next click creates one 2-point segment and continues from its end', () => {
    const first = lineClick(EMPTY_CHAIN, A).chain;
    const r = lineClick(first, B);
    expect(r).toMatchObject({ kind: 'segment', from: A, to: B });
    expect(r.chain.start).toEqual(B);
    const r2 = lineClick(r.chain, C);
    expect(r2).toMatchObject({ kind: 'segment', from: B, to: C });
  });

  it('keeps the exact coordinates it was given', () => {
    const p = [500000.123456789, 4650000.987654321] as const;
    const r = lineClick(lineClick(EMPTY_CHAIN, A).chain, p);
    expect(r.kind === 'segment' && r.to).toBe(p);
  });
});

describe('§3 Backspace', () => {
  it('deletes the last stored segment and steps back to its start', () => {
    const u = lineUndo(draw(A, B, C));
    expect(u).toMatchObject({ kind: 'delete-segment', id: 'el_2' });
    expect(u.chain.start).toEqual(B);
    const u2 = lineUndo(u.chain);
    expect(u2).toMatchObject({ kind: 'delete-segment', id: 'el_1' });
    expect(u2.chain.start).toEqual(A);
  });

  it('with only the start point placed, drops it', () => {
    const u = lineUndo(draw(A));
    expect(u.kind).toBe('drop-start');
    expect(chainActive(u.chain)).toBe(false);
  });

  it('nothing to undo', () => {
    expect(lineUndo(EMPTY_CHAIN).kind).toBe('nothing');
  });

  it('waits for a segment the store has not answered yet', () => {
    const chain = lineClick(lineClick(EMPTY_CHAIN, A).chain, B).chain;
    expect(lineUndo(chain).kind).toBe('pending');
  });

  it('a rejected segment is forgotten, so undo goes past it', () => {
    let chain = draw(A, B);
    const r = lineClick(chain, C);
    chain = segmentRejected(r.chain, B, C);
    expect(lineUndo(chain)).toMatchObject({ kind: 'delete-segment', id: 'el_1' });
  });
});

describe('§4 rejected input', () => {
  it('a click on the current start (zero length, double-click) creates nothing', () => {
    const chain = draw(A, B);
    const r = lineClick(chain, B);
    expect(r.kind).toBe('ignored');
    expect(r.chain).toBe(chain);
  });
});
