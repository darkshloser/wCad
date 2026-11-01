// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import type { ElementKind } from '@wcad/geo-core';

/**
 * Numeric codes for element kinds, as stored in `elements.kind`.
 *
 * A smallint rather than text: at 10M rows the difference in table size and index cost is
 * material, and the set is closed. The mapping lives in store-contract rather than in one store
 * implementation so PostGIS and SQLite-WASM cannot drift apart — a project exported from one and
 * opened in the other must agree on what a 3 means.
 *
 * Codes are APPEND-ONLY. Never renumber an existing kind; that would silently reinterpret every
 * row already written.
 */
export const ELEMENT_KIND_CODE: Readonly<Record<ElementKind, number>> = {
  point: 1,
  line: 2,
  polyline: 3,
  polygon: 4,
  arc: 5,
  circle: 6,
  text: 7,
  insert: 8,
};

export const ELEMENT_KIND_BY_CODE: Readonly<Record<number, ElementKind>> = Object.freeze(
  Object.fromEntries(Object.entries(ELEMENT_KIND_CODE).map(([k, v]) => [v, k as ElementKind])),
);

export function kindToCode(kind: ElementKind): number {
  const code = ELEMENT_KIND_CODE[kind];
  if (code === undefined) throw new Error(`Unknown element kind: ${kind}`);
  return code;
}

export function codeToKind(code: number): ElementKind {
  const kind = ELEMENT_KIND_BY_CODE[code];
  if (kind === undefined) throw new Error(`Unknown element kind code: ${code}`);
  return kind;
}
