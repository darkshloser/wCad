// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOOL,
  TOOL_GUIDE,
  isDrawingTool,
  dedupeConsecutive,
  distinctVertexCount,
  drawnShapeProblem,
  keyAction,
  selectionVertices,
} from '../src/map/toolRules.ts';

describe('distinctVertexCount', () => {
  it('ignores consecutive duplicates from a double-click finish', () => {
    expect(distinctVertexCount([[0, 0], [1, 1], [1, 1]])).toBe(2);
  });

  it('ignores the closing vertex of a ring', () => {
    expect(distinctVertexCount([[0, 0], [1, 0], [1, 1], [0, 0]], true)).toBe(3);
  });
});

describe('dedupeConsecutive', () => {
  it('drops repeats but keeps a ring closed', () => {
    expect(dedupeConsecutive([[0, 0], [1, 0], [1, 0], [1, 1], [0, 0]])).toEqual([[0, 0], [1, 0], [1, 1], [0, 0]]);
  });
});

describe('drawnShapeProblem', () => {
  it('accepts a valid polyline and polygon', () => {
    expect(drawnShapeProblem('polyline', [[0, 0], [1, 0]])).toBeNull();
    expect(drawnShapeProblem('polygon', [[0, 0], [1, 0], [1, 1], [0, 0]])).toBeNull();
  });

  it('rejects a zero-length polyline', () => {
    expect(drawnShapeProblem('polyline', [[2, 2], [2, 2]])).toMatch(/at least 2/);
  });

  it('rejects a polygon with two distinct vertices', () => {
    expect(drawnShapeProblem('polygon', [[0, 0], [1, 0], [1, 0], [0, 0]])).toMatch(/at least 3/);
  });

  it('rejects a circle without a positive radius', () => {
    expect(drawnShapeProblem('circle', [], 0)).not.toBeNull();
    expect(drawnShapeProblem('circle', [], Number.NaN)).not.toBeNull();
    expect(drawnShapeProblem('circle', [], 5)).toBeNull();
  });

  it('accepts any point', () => {
    expect(drawnShapeProblem('point', [[0, 0]])).toBeNull();
  });
});

describe('selectionVertices', () => {
  it('marks no handles on a point', () => {
    expect(selectionVertices('point', [[1, 2]])).toEqual([]);
  });

  it('marks every polyline vertex', () => {
    expect(selectionVertices('polyline', [[0, 0], [1, 0], [2, 1]])).toEqual([[0, 0], [1, 0], [2, 1]]);
  });

  it('drops the duplicated closing vertex of a polygon', () => {
    expect(selectionVertices('polygon', [[0, 0], [1, 0], [1, 1], [0, 0]])).toEqual([[0, 0], [1, 0], [1, 1]]);
  });

  it('marks only start and end of an arc, not its tessellation', () => {
    const tessellated = Array.from({ length: 50 }, (_, i) => [Math.cos(i / 10), Math.sin(i / 10)] as const);
    const v = selectionVertices('arc', tessellated);
    expect(v).toHaveLength(2);
    expect(v[0]).toEqual([tessellated[0]![0], tessellated[0]![1]]);
    expect(v[1]).toEqual([tessellated[49]![0], tessellated[49]![1]]);
  });

  it('marks the centre of a circle', () => {
    expect(selectionVertices('circle', [], [5, 6])).toEqual([[5, 6]]);
  });
});

describe('keyAction', () => {
  it('maps the drawing keys on the map', () => {
    expect(keyAction('Escape', 'DIV')).toBe('cancel');
    expect(keyAction('Enter', 'CANVAS')).toBe('finish');
    expect(keyAction('Backspace', undefined)).toBe('undo-vertex');
    expect(keyAction('a', 'DIV')).toBeNull();
  });

  it('leaves Enter and Backspace to the coordinate field but still lets Esc cancel', () => {
    expect(keyAction('Enter', 'INPUT')).toBeNull();
    expect(keyAction('Backspace', 'input')).toBeNull();
    expect(keyAction('Escape', 'INPUT')).toBe('cancel');
  });

  it('never intercepts typing in the metadata editor', () => {
    expect(keyAction('Escape', 'TEXTAREA')).toBeNull();
    expect(keyAction('Backspace', 'TEXTAREA')).toBeNull();
  });
});

describe('TOOL_GUIDE', () => {
  it('tells the user Select is read-only', () => {
    expect(TOOL_GUIDE.select).toMatch(/read-only/);
  });
});

describe('tools (selection spec §1, §5, §6)', () => {
  it('opens in Pan', () => {
    expect(DEFAULT_TOOL).toBe('pan');
  });

  it('classifies drawing tools', () => {
    expect(isDrawingTool('pan')).toBe(false);
    expect(isDrawingTool('select')).toBe(false);
    for (const t of ['point', 'line', 'polygon', 'circle', 'arc3'] as const) expect(isDrawingTool(t)).toBe(true);
  });

  it('maps Delete on the map, never while typing in a field', () => {
    expect(keyAction('Delete', 'BODY')).toBe('delete');
    expect(keyAction('Delete', 'INPUT')).toBeNull();
    expect(keyAction('Delete', 'TEXTAREA')).toBeNull();
  });
});
