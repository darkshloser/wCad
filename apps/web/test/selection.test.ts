// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later

// One test per row of the tables in knowledge/selection-spec.md.

import { describe, expect, it } from 'vitest';
import {
  applySelection,
  clickSelection,
  contextMenuSelection,
  extentContains,
  isDrag,
  modifierFrom,
  normalizeRect,
  rectMode,
  rightClickDecision,
  sameSelection,
} from '../src/map/selection.ts';

const sel = (...ids: string[]) => new Set(ids);
const sorted = (s: Set<string>) => [...s].sort();

describe('modifierFrom', () => {
  it('maps keys to replace / add / remove', () => {
    expect(modifierFrom({ shiftKey: false, ctrlKey: false })).toBe('replace');
    expect(modifierFrom({ shiftKey: true, ctrlKey: false })).toBe('add');
    expect(modifierFrom({ shiftKey: false, ctrlKey: true })).toBe('remove');
    expect(modifierFrom({ shiftKey: false, ctrlKey: false, metaKey: true })).toBe('remove');
    expect(modifierFrom({ shiftKey: true, ctrlKey: true })).toBe('remove');
  });
});

describe('click vs drag threshold (~4 px)', () => {
  it('treats small movement as a click', () => {
    expect(isDrag([100, 100], [100, 100])).toBe(false);
    expect(isDrag([100, 100], [102, 102])).toBe(false);
  });
  it('treats 4 px or more as a drag', () => {
    expect(isDrag([100, 100], [104, 100])).toBe(true);
    expect(isDrag([100, 100], [90, 95])).toBe(true);
  });
});

describe('§3.1 single click', () => {
  it('click an object: only it is selected', () => {
    expect(sorted(clickSelection(sel('a', 'b'), 'c', 'replace'))).toEqual(['c']);
  });
  it('clicking an already-selected object among several selects only it', () => {
    expect(sorted(clickSelection(sel('a', 'b'), 'a', 'replace'))).toEqual(['a']);
  });
  it('Shift+click adds', () => {
    expect(sorted(clickSelection(sel('a'), 'b', 'add'))).toEqual(['a', 'b']);
  });
  it('Ctrl+click a selected object removes it', () => {
    expect(sorted(clickSelection(sel('a', 'b'), 'b', 'remove'))).toEqual(['a']);
  });
  it('Ctrl+click an unselected object changes nothing', () => {
    expect(sorted(clickSelection(sel('a'), 'b', 'remove'))).toEqual(['a']);
  });
  it('click empty space deselects all', () => {
    expect(clickSelection(sel('a', 'b'), null, 'replace').size).toBe(0);
  });
  it('Shift/Ctrl+click empty space changes nothing', () => {
    expect(sorted(clickSelection(sel('a', 'b'), null, 'add'))).toEqual(['a', 'b']);
    expect(sorted(clickSelection(sel('a', 'b'), null, 'remove'))).toEqual(['a', 'b']);
  });
});

describe('§3.2 rectangle', () => {
  it('left→right is window, right→left is crossing', () => {
    expect(rectMode(10, 200)).toBe('window');
    expect(rectMode(200, 10)).toBe('crossing');
  });
  it('no modifier replaces; an empty rectangle deselects all', () => {
    expect(sorted(applySelection(sel('a'), ['b', 'c'], 'replace'))).toEqual(['b', 'c']);
    expect(applySelection(sel('a', 'b'), [], 'replace').size).toBe(0);
  });
  it('Shift adds the result', () => {
    expect(sorted(applySelection(sel('a'), ['b', 'c'], 'add'))).toEqual(['a', 'b', 'c']);
  });
  it('Ctrl removes the result', () => {
    expect(sorted(applySelection(sel('a', 'b', 'c'), ['b', 'x'], 'remove'))).toEqual(['a', 'c']);
  });
  it('normalizes corners in any drag direction', () => {
    expect(normalizeRect([10, 50], [2, 3])).toEqual([2, 3, 10, 50]);
  });
  it('window containment is edge-inclusive and rejects overhang', () => {
    expect(extentContains([0, 0, 10, 10], [0, 0, 10, 10])).toBe(true);
    expect(extentContains([0, 0, 10, 10], [2, 2, 5, 5])).toBe(true);
    expect(extentContains([0, 0, 10, 10], [2, 2, 11, 5])).toBe(false);
  });
});

describe('§4 right-click', () => {
  it('on an already-selected object keeps the selection', () => {
    expect(sorted(contextMenuSelection(sel('a', 'b'), 'b'))).toEqual(['a', 'b']);
  });
  it('on an unselected object selects only it', () => {
    expect(sorted(contextMenuSelection(sel('a', 'b'), 'c'))).toEqual(['c']);
  });
  it('on empty space changes nothing', () => {
    expect(sorted(contextMenuSelection(sel('a'), null))).toEqual(['a']);
  });
});

describe('sameSelection', () => {
  it('compares by content', () => {
    expect(sameSelection(sel('a', 'b'), sel('b', 'a'))).toBe(true);
    expect(sameSelection(sel('a'), sel('a', 'b'))).toBe(false);
  });
});

describe('§4 / §4.1 / §6 right-click decision', () => {
  const none = { sketching: false };

  it('Select: object opens the object menu and applies the right-click selection rule', () => {
    const d = rightClickDecision({ tool: 'select', ...none }, 'c', sel('a'));
    expect(d.kind).toBe('object-menu');
    if (d.kind === 'object-menu') {
      expect(d.elementId).toBe('c');
      expect(sorted(d.selection)).toEqual(['c']);
    }
  });

  it('Pan and drawing tools: object opens the menu but never changes the selection', () => {
    for (const tool of ['pan', 'point', 'line', 'polygon', 'circle', 'arc3']) {
      const d = rightClickDecision({ tool, ...none }, 'c', sel('a'));
      expect(d.kind, tool).toBe('object-menu');
      expect(sorted(d.selection), tool).toEqual(['a']);
    }
  });

  it('empty space opens the view menu in every tool, selection unchanged', () => {
    for (const tool of ['pan', 'select', 'point', 'line', 'polygon', 'circle', 'arc3']) {
      const d = rightClickDecision({ tool, ...none }, null, sel('a'));
      expect(d.kind, tool).toBe('view-menu');
      expect(sorted(d.selection), tool).toEqual(['a']);
    }
  });

  it('mid-shape in Polyline/Polygon, right-click finishes the shape even over an object', () => {
    expect(rightClickDecision({ tool: 'line', sketching: true }, 'c', sel()).kind).toBe('finish-shape');
    expect(rightClickDecision({ tool: 'polygon', sketching: true }, null, sel()).kind).toBe('finish-shape');
  });

  it('mid-circle there is nothing to finish, so the menu opens', () => {
    expect(rightClickDecision({ tool: 'circle', sketching: true }, 'c', sel()).kind).toBe('object-menu');
  });
});
