// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

/**
 * Line tool chain rules (knowledge/line-tool-spec.md), free of OpenLayers and the DOM.
 *
 * The Line tool behaves like AutoCAD's LINE: every click after the first stores one independent
 * two-point Line object, and its end becomes the start of the next. The state is immutable; the
 * engine asks what a click or a Backspace means and applies the answer.
 */

export type XY = readonly [number, number];

/** One segment created in the current chain. `id` is null until the store has accepted it. */
export interface ChainSegment {
  readonly from: XY;
  readonly to: XY;
  readonly id: string | null;
}

export interface LineChain {
  /** Where the next segment starts; null when no chain is in progress. */
  readonly start: XY | null;
  /** Segments created in this chain, oldest first (for Backspace, spec §3). */
  readonly segments: readonly ChainSegment[];
}

export const EMPTY_CHAIN: LineChain = Object.freeze({ start: null, segments: [] });

export type LineClick =
  /** First click: the chain starts here. */
  | { readonly kind: 'start'; readonly chain: LineChain }
  /** A segment from→to should be stored; `chain` already continues from `to`. */
  | { readonly kind: 'segment'; readonly from: XY; readonly to: XY; readonly chain: LineChain }
  /** Zero-length: nothing is created and the chain is unchanged (spec §4). */
  | { readonly kind: 'ignored'; readonly chain: LineChain };

/**
 * What a click (or a typed point) does (spec §2, §4).
 *
 * The chain moves on to `to` immediately, before the store answers, so fast clicking never loses
 * a vertex while a previous segment is still being saved.
 */
export function lineClick(chain: LineChain, p: XY): LineClick {
  if (!chain.start) return { kind: 'start', chain: { start: p, segments: [] } };
  if (chain.start[0] === p[0] && chain.start[1] === p[1]) return { kind: 'ignored', chain };
  const from = chain.start;
  return {
    kind: 'segment',
    from,
    to: p,
    chain: { start: p, segments: [...chain.segments, { from, to: p, id: null }] },
  };
}

/** Records the id the store gave the segment that ends at `to`. */
export function segmentStored(chain: LineChain, from: XY, to: XY, id: string): LineChain {
  let done = false;
  const segments = chain.segments.map((s) => {
    if (done || s.id !== null || !same(s.from, from) || !same(s.to, to)) return s;
    done = true;
    return { ...s, id };
  });
  return { ...chain, segments };
}

/** Removes a segment the store rejected, so Backspace never tries to delete it. */
export function segmentRejected(chain: LineChain, from: XY, to: XY): LineChain {
  const i = chain.segments.findIndex((s) => s.id === null && same(s.from, from) && same(s.to, to));
  if (i < 0) return chain;
  return { ...chain, segments: [...chain.segments.slice(0, i), ...chain.segments.slice(i + 1)] };
}

export type LineUndo =
  /** Delete this stored segment and continue from its start. */
  | { readonly kind: 'delete-segment'; readonly id: string; readonly chain: LineChain }
  /** Only the start point was placed: drop it. */
  | { readonly kind: 'drop-start'; readonly chain: LineChain }
  /** The last segment is still being saved; try again in a moment. */
  | { readonly kind: 'pending'; readonly chain: LineChain }
  | { readonly kind: 'nothing'; readonly chain: LineChain };

/** What Backspace does (spec §3). */
export function lineUndo(chain: LineChain): LineUndo {
  const last = chain.segments[chain.segments.length - 1];
  if (last) {
    if (last.id === null) return { kind: 'pending', chain };
    return {
      kind: 'delete-segment',
      id: last.id,
      chain: { start: last.from, segments: chain.segments.slice(0, -1) },
    };
  }
  if (chain.start) return { kind: 'drop-start', chain: EMPTY_CHAIN };
  return { kind: 'nothing', chain };
}

export function chainActive(chain: LineChain): boolean {
  return chain.start !== null;
}

function same(a: XY, b: XY): boolean {
  return a[0] === b[0] && a[1] === b[1];
}
