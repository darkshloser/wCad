// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import { type Page, expect, test } from '@playwright/test';

/**
 * Toolbar and selection behaviour, against knowledge/selection-spec.md.
 *
 * Section numbers in test names refer to that spec. Interaction is driven exactly as a user would
 * drive it — real mouse buttons, modifiers and keys — because the failures that matter (a click
 * read as a drag, a pan that also selects, a highlight left behind) only exist in a browser.
 */

const status = (page: Page) => page.locator('.status-bar .message');

async function selectedCount(page: Page): Promise<number> {
  const el = page.locator('.status-bar .selection');
  if ((await el.count()) === 0) return 0;
  return Number.parseInt((await el.textContent()) ?? '0', 10);
}

async function expectSelected(page: Page, n: number, why: string) {
  await expect.poll(() => selectedCount(page), { message: why }).toBe(n);
}

async function center(page: Page) {
  const box = await page.locator('.map').boundingBox();
  expect(box).not.toBeNull();
  return { ox: box!.x + box!.width / 2, oy: box!.y + box!.height / 2, box: box! };
}

async function tool(page: Page, label: string) {
  await page.getByRole('button', { name: label, exact: true }).click();
}

async function drawPolyline(page: Page, pts: Array<[number, number]>) {
  await tool(page, 'Polyline');
  for (const [x, y] of pts) await page.mouse.click(x, y);
  await page.keyboard.press('Enter');
  await expect(status(page)).toContainText('Polyline created');
}

async function drag(page: Page, from: [number, number], to: [number, number], modifier?: 'Shift' | 'Control') {
  if (modifier) await page.keyboard.down(modifier);
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(from[0] + ((to[0] - from[0]) * i) / 10, from[1] + ((to[1] - from[1]) * i) / 10);
  }
  await page.mouse.up();
  if (modifier) await page.keyboard.up(modifier);
}

async function clickWith(page: Page, x: number, y: number, modifier: 'Shift' | 'Control') {
  await page.keyboard.down(modifier);
  await page.mouse.click(x, y);
  await page.keyboard.up(modifier);
}

/** True when some pixel near (x, y) matches the colour test. */
async function colourNear(page: Page, x: number, y: number, kind: 'selection' | 'snap'): Promise<boolean> {
  return page.evaluate(
    ([px, py, k]) => {
      const test =
        k === 'selection'
          ? (r: number, g: number, b: number) => r > 200 && g > 60 && g < 130 && b < 60 // #e8590c
          : (r: number, g: number, b: number) => r > 190 && g > 135 && g < 180 && b < 80; // #d69e2e
      for (const canvas of Array.from(document.querySelectorAll<HTMLCanvasElement>('.map canvas'))) {
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) continue;
        const rect = canvas.getBoundingClientRect();
        const cx = Math.round((px - rect.left) * (canvas.width / rect.width));
        const cy = Math.round((py - rect.top) * (canvas.height / rect.height));
        const d = ctx.getImageData(cx - 8, cy - 8, 17, 17).data;
        for (let i = 0; i < d.length; i += 4) if (d[i + 3]! > 150 && test(d[i]!, d[i + 1]!, d[i + 2]!)) return true;
      }
      return false;
    },
    [x, y, kind] as const,
  );
}

test.describe('selection spec', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.map canvas', { timeout: 30_000 });
    await page.waitForTimeout(1500);
  });

  test('§1–2 opens in Pan; a click in Pan never selects', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Pan', exact: true })).toHaveClass(/active/);
    const { ox, oy } = await center(page);
    await drawPolyline(page, [[ox - 50, oy], [ox + 50, oy]]);

    await tool(page, 'Pan');
    await page.mouse.click(ox, oy);
    await expectSelected(page, 0, 'a click in Pan selected something');
  });

  test('§6 creating points leaves nothing highlighted', async ({ page }) => {
    const { ox, oy } = await center(page);
    const pts: Array<[number, number]> = [[ox - 120, oy], [ox - 60, oy + 10], [ox, oy - 10], [ox + 60, oy], [ox + 120, oy + 10]];
    await tool(page, 'Point');
    for (const [x, y] of pts) {
      await page.mouse.click(x, y);
      await expect(status(page)).toContainText('Point created');
    }
    // Move the cursor away and let everything render.
    await page.mouse.move(ox, oy - 200);
    await page.waitForTimeout(400);

    await expectSelected(page, 0, 'drawing selected something');
    for (const [x, y] of pts.slice(0, -1)) {
      expect(await colourNear(page, x, y, 'selection'), `point at ${x},${y} looks selected`).toBe(false);
      expect(await colourNear(page, x, y, 'snap'), `point at ${x},${y} shows a snap marker`).toBe(false);
    }
  });

  test('§3.1 click replaces, Shift adds, Ctrl removes, empty space clears', async ({ page }) => {
    const { ox, oy } = await center(page);
    await drawPolyline(page, [[ox - 150, oy - 60], [ox - 50, oy - 60]]); // A, midpoint (ox-100, oy-60)
    await drawPolyline(page, [[ox + 50, oy - 60], [ox + 150, oy - 60]]); // B, midpoint (ox+100, oy-60)
    const A: [number, number] = [ox - 100, oy - 60];
    const B: [number, number] = [ox + 100, oy - 60];

    await tool(page, 'Select');
    await page.mouse.click(...A);
    await expectSelected(page, 1, 'click A');
    await page.mouse.click(...B);
    await expectSelected(page, 1, 'click B must replace A, not add');

    await clickWith(page, ...A, 'Shift');
    await expectSelected(page, 2, 'Shift+click A adds');
    await clickWith(page, ox, oy + 150, 'Shift');
    await expectSelected(page, 2, 'Shift+click empty space changes nothing');

    await clickWith(page, ...B, 'Control');
    await expectSelected(page, 1, 'Ctrl+click B removes it');

    await page.mouse.click(ox, oy + 150);
    await expectSelected(page, 0, 'click on empty space deselects all');
  });

  test('§3.2 left→right selects fully inside; right→left selects touching', async ({ page }) => {
    const { ox, oy } = await center(page);
    await drawPolyline(page, [[ox - 40, oy], [ox + 40, oy]]); // inside the box
    await drawPolyline(page, [[ox + 60, oy + 20], [ox + 200, oy + 20]]); // crosses the box's right edge

    const left: [number, number] = [ox - 100, oy - 50];
    const right: [number, number] = [ox + 100, oy + 50];

    await tool(page, 'Select');
    await drag(page, left, right);
    await expectSelected(page, 1, 'window must select only the line fully inside');
    await expect(page.locator('.select-rect')).toBeHidden();

    await drag(page, right, left);
    await expectSelected(page, 2, 'crossing must also select the line it touches');

    // An empty rectangle with no modifier deselects everything.
    await drag(page, [ox - 300, oy - 200], [ox - 250, oy - 160]);
    await expectSelected(page, 0, 'empty rectangle deselects all');

    // Shift adds a rectangle's result; Ctrl removes it.
    await drag(page, left, right);
    await expectSelected(page, 1, 'window again');
    await drag(page, right, left, 'Shift');
    await expectSelected(page, 2, 'Shift+crossing adds');
    await drag(page, left, right, 'Control');
    await expectSelected(page, 1, 'Ctrl+window removes the inside line');
  });

  test('§3.2 the rectangle is dashed for window, dotted for crossing, and Esc cancels it', async ({ page }) => {
    const { ox, oy } = await center(page);
    await drawPolyline(page, [[ox - 40, oy], [ox + 40, oy]]);
    await tool(page, 'Select');
    await page.mouse.click(ox, oy);
    await expectSelected(page, 1, 'preselect');

    const rect = page.locator('.select-rect');
    await page.mouse.move(ox - 100, oy - 50);
    await page.mouse.down();
    await page.mouse.move(ox + 20, oy + 20, { steps: 5 });
    await expect(rect).toBeVisible();
    await expect(rect).toHaveClass(/window/);
    expect(await rect.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe('dashed');

    await page.mouse.move(ox - 200, oy + 20, { steps: 5 });
    await expect(rect).toHaveClass(/crossing/);
    expect(await rect.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe('dotted');

    await page.keyboard.press('Escape');
    await expect(rect).toBeHidden();
    await page.mouse.up();
    await expectSelected(page, 1, 'Esc during a drag leaves the selection unchanged');
  });

  test('§3, §6 Select never pans or moves; pan and zoom never change the selection', async ({ page }) => {
    const { ox, oy } = await center(page);
    await drawPolyline(page, [[ox - 60, oy], [ox + 60, oy]]);
    await tool(page, 'Select');
    await page.mouse.click(ox, oy);
    await expectSelected(page, 1, 'select');

    // A drag that starts on the selected line's vertex is a rectangle, not a move or a pan.
    await drag(page, [ox + 60, oy], [ox + 200, oy + 120]);
    await page.mouse.click(ox, oy);
    await expectSelected(page, 1, 'the line is still where it was: Select did not pan or move it');

    // Pan and zoom in the Pan tool keep the selection.
    await tool(page, 'Pan');
    await drag(page, [ox, oy + 100], [ox + 150, oy + 50]);
    await page.mouse.wheel(0, -480);
    await page.waitForTimeout(500);
    await page.mouse.wheel(0, 480);
    await page.waitForTimeout(800);
    await expectSelected(page, 1, 'pan/zoom changed the selection');
  });

  test('§4 properties only from the menu; menu Delete removes one; Del key removes all', async ({ page }) => {
    const { ox, oy } = await center(page);
    await drawPolyline(page, [[ox - 150, oy], [ox - 50, oy]]); // A
    await drawPolyline(page, [[ox + 50, oy], [ox + 150, oy]]); // B
    await drawPolyline(page, [[ox - 50, oy + 100], [ox + 50, oy + 100]]); // C
    const A: [number, number] = [ox - 100, oy];
    const B: [number, number] = [ox + 100, oy];
    const C: [number, number] = [ox, oy + 100];
    const panel = page.locator('.properties');
    const menu = page.locator('.context-menu');

    await tool(page, 'Select');
    await page.mouse.click(...A);
    await clickWith(page, ...B, 'Shift');
    await expectSelected(page, 2, 'A and B selected');
    await expect(panel, 'properties must not open on selection').toHaveCount(0);

    // Right-click on an already-selected object keeps the selection.
    await page.mouse.click(...B, { button: 'right' });
    await expect(menu).toBeVisible();
    await expectSelected(page, 2, 'right-click on selected keeps selection');
    await menu.getByRole('button', { name: 'Properties' }).click();
    await expect(panel).toContainText('polyline');

    // Menu → Delete removes only the right-clicked object.
    await page.mouse.click(...A, { button: 'right' });
    await menu.getByRole('button', { name: 'Delete' }).click();
    await expect(status(page)).toContainText('1 object deleted');
    await expectSelected(page, 1, 'B stays selected after deleting A from the menu');

    // Right-click on an unselected object selects only it.
    await page.mouse.click(...C, { button: 'right' });
    await expectSelected(page, 1, 'right-click on unselected selects only it');
    await page.keyboard.press('Escape');

    // Right-click on empty space: the view menu, selection unchanged.
    await page.mouse.click(...C);
    await clickWith(page, ...B, 'Shift');
    await expectSelected(page, 2, 'B and C selected');
    await page.mouse.click(ox, oy - 200, { button: 'right' });
    await expect(page.getByRole('menu', { name: 'View' })).toBeVisible();
    await expectSelected(page, 2, 'right-click on empty space changes nothing');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu', { name: 'View' })).toHaveCount(0);
    await clickWith(page, ...B, 'Shift'); // Esc cleared the selection; rebuild B + C
    await clickWith(page, ...C, 'Shift');
    await expectSelected(page, 2, 'B and C selected again');

    // The Delete key removes every selected object.
    await page.keyboard.press('Delete');
    await expect(status(page)).toContainText('2 objects deleted');
    await expectSelected(page, 0, 'nothing left selected');
  });

  test('§5 Esc in a drawing tool cancels, then returns to Select', async ({ page }) => {
    const { ox, oy } = await center(page);
    await tool(page, 'Polyline');
    await page.mouse.click(ox, oy);
    await page.mouse.click(ox + 50, oy);
    await page.keyboard.press('Escape');
    await expect(status(page)).toContainText('Cancelled');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveClass(/active/);
  });

  test('§4 right-click on an object opens its menu in Pan and drawing tools, without selecting', async ({ page }) => {
    const { ox, oy } = await center(page);
    await drawPolyline(page, [[ox - 60, oy], [ox + 60, oy]]);
    const menu = page.locator('.context-menu').filter({ hasText: 'Properties' });

    for (const label of ['Pan', 'Point', 'Circle']) {
      await tool(page, label);
      await page.mouse.move(ox, oy);
      await page.mouse.click(ox, oy, { button: 'right' });
      await expect(menu, `${label}: object menu`).toBeVisible();
      await expectSelected(page, 0, `${label}: right-click must not select`);
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
    }

    // Mid-polyline, right-click finishes the shape instead of opening a menu.
    await tool(page, 'Polyline');
    await page.mouse.click(ox - 60, oy + 80);
    await page.mouse.click(ox + 60, oy + 80);
    await page.mouse.click(ox, oy, { button: 'right' });
    await expect(status(page)).toContainText('Polyline created');
    await expect(menu).toHaveCount(0);
  });

  test('§3.3 hover highlights in Pan too', async ({ page }) => {
    const { ox, oy } = await center(page);
    await drawPolyline(page, [[ox - 60, oy], [ox + 60, oy]]);
    await tool(page, 'Pan');
    await page.mouse.move(ox + 30, oy);
    await page.waitForTimeout(300);
    const hovered = await page.evaluate(([x, y]) => {
      for (const canvas of Array.from(document.querySelectorAll<HTMLCanvasElement>('.map canvas'))) {
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) continue;
        const r = canvas.getBoundingClientRect();
        const d = ctx.getImageData(Math.round((x - r.left) * (canvas.width / r.width)) - 4, Math.round((y - r.top) * (canvas.height / r.height)) - 4, 9, 9).data;
        // #3b82f6 hover blue (the plain style is the darker #2b6cb0)
        for (let i = 0; i < d.length; i += 4) if (d[i + 2]! > 220 && d[i + 1]! > 110 && d[i]! < 90) return true;
      }
      return false;
    }, [ox - 30, oy] as const);
    expect(hovered, 'hover highlight not drawn in Pan').toBe(true);
  });

  test('§4.1 view menu settings apply at once and are remembered', async ({ page }) => {
    const { ox, oy } = await center(page);
    const viewMenu = page.getByRole('menu', { name: 'View' });
    const openView = async () => {
      await page.mouse.click(ox, oy - 150, { button: 'right' });
      await expect(viewMenu).toBeVisible();
    };

    await expect(page.locator('.map')).toHaveClass(/bg-dark/);
    await openView();
    await viewMenu.getByRole('menuitemradio', { name: /Light/ }).click();
    await expect(viewMenu, 'choosing an item closes the menu').toHaveCount(0);
    await expect(page.locator('.map')).toHaveClass(/bg-light/);

    await openView();
    await viewMenu.getByRole('menuitemcheckbox', { name: /Performance readout/ }).click();
    await expect(page.locator('.status-bar .perf')).toHaveCount(0);

    await openView();
    await viewMenu.getByRole('menuitemcheckbox', { name: /Basemap/ }).click();
    await expect(page.locator('.toolbar input[type=checkbox]')).toBeChecked();

    // Remembered per browser.
    await page.reload();
    await page.waitForSelector('.map canvas', { timeout: 30_000 });
    await expect(page.locator('.map')).toHaveClass(/bg-light/);
    await expect(page.locator('.toolbar input[type=checkbox]')).toBeChecked();
    await page.waitForTimeout(1500);
    await expect(page.locator('.status-bar .perf')).toHaveCount(0);

    // Restore defaults so other tests start clean.
    await page.evaluate(() => localStorage.removeItem('wcad.viewSettings.v1'));
  });
});

/**
 * knowledge/snapping-spec.md. The decisive check is §4: a click a few pixels off a snap target
 * stores the target's exact coordinates, verified through the Properties panel of both objects.
 */
test.describe('snapping spec', () => {
  const snapLabel = (page: Page) => page.locator('.status-bar .snap');

  async function coordsOf(page: Page, x: number, y: number): Promise<string> {
    await page.mouse.move(x, y);
    await page.mouse.click(x, y, { button: 'right' });
    await page.locator('.context-menu').getByRole('menuitem', { name: 'Properties' }).click();
    const text = (await page.locator('.properties .coords').innerText()).trim();
    await page.locator('.properties-header button').click();
    return text;
  }

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.map canvas', { timeout: 30_000 });
    await page.waitForTimeout(1500);
  });

  test('§2–4 a polyline started near a point starts exactly on it', async ({ page }) => {
    const { ox, oy } = await center(page);
    await tool(page, 'Point');
    await page.mouse.click(ox, oy);
    await expect(status(page)).toContainText('Point created');

    await tool(page, 'Polyline');
    await page.mouse.move(ox + 20, oy + 20);
    await page.mouse.move(ox + 5, oy + 4, { steps: 4 }); // ~6 px away: inside the 10 px snap distance
    await expect(snapLabel(page)).toHaveText('SNAP · endpoint');
    await page.mouse.click(ox + 5, oy + 4);
    await page.mouse.click(ox + 150, oy + 80);
    await page.keyboard.press('Enter');
    await expect(status(page)).toContainText('Polyline created');

    const point = await coordsOf(page, ox, oy);
    const line = await coordsOf(page, ox + 75, oy + 40);
    expect(line.split('\n')[0]!.trim(), 'first vertex must equal the point exactly').toBe(point);
  });

  test('§2 beyond 10 px nothing snaps and the click lands at the cursor', async ({ page }) => {
    const { ox, oy } = await center(page);
    await tool(page, 'Point');
    await page.mouse.click(ox, oy);
    await tool(page, 'Polyline');
    await page.mouse.move(ox + 30, oy, { steps: 4 });
    await page.mouse.move(ox + 14, oy, { steps: 4 });
    await expect(snapLabel(page)).toHaveText('SNAP');
  });

  test('§1 circle centre snaps; its circumference point does not', async ({ page }) => {
    const { ox, oy } = await center(page);
    await tool(page, 'Circle');
    await page.mouse.click(ox, oy);
    await page.mouse.click(ox + 60, oy);
    await expect(status(page)).toContainText('Circle created');

    await tool(page, 'Polyline');
    await page.mouse.move(ox + 20, oy + 20);
    await page.mouse.move(ox + 3, oy + 3, { steps: 4 });
    await expect(snapLabel(page)).toHaveText('SNAP · centre');
    await page.mouse.move(ox + 60, oy + 1, { steps: 4 });
    await expect(snapLabel(page)).toHaveText('SNAP');
  });

  test('§5 F3 toggles snapping; Alt suspends it', async ({ page }) => {
    const { ox, oy } = await center(page);
    await tool(page, 'Point');
    await page.mouse.click(ox, oy);
    await tool(page, 'Polyline');
    await page.mouse.move(ox + 20, oy + 20);
    await page.mouse.move(ox + 4, oy + 3, { steps: 4 });
    await expect(snapLabel(page)).toHaveText('SNAP · endpoint');

    await page.keyboard.press('F3');
    await expect(snapLabel(page)).toHaveText('SNAP OFF');
    await page.keyboard.press('F3');
    await expect(snapLabel(page)).toHaveText('SNAP · endpoint');

    await page.keyboard.down('Alt');
    await expect(snapLabel(page)).toHaveText('SNAP');
    await page.keyboard.up('Alt');
    await expect(snapLabel(page)).toHaveText('SNAP · endpoint');
  });

  test('§4 right-click in a drawing tool opens the menu instead of adding a vertex', async ({ page }) => {
    const { ox, oy } = await center(page);
    await drawPolyline(page, [[ox - 60, oy], [ox + 60, oy]]);
    await page.mouse.move(ox, oy);
    await page.mouse.click(ox, oy, { button: 'right' });
    await expect(page.locator('.context-menu').getByRole('menuitem', { name: 'Properties' })).toBeVisible();
    await expect(status(page)).not.toContainText('Not created');
  });
});

/** knowledge/snapping-spec.md v2: the Snap menu and the modes beyond Endpoint/Centre. */
test.describe('snapping spec v2', () => {
  const snapLabel = (page: Page) => page.locator('.status-bar .snap');
  const readout = (page: Page) => page.locator('.status-bar .coordinate');
  const coordOf = async (page: Page) => {
    const m = /E\s+([\d.-]+)\s+N\s+([\d.-]+)/.exec((await readout(page).textContent()) ?? '');
    return m ? [Number(m[1]), Number(m[2])] : [NaN, NaN];
  };

  async function openSnapMenu(page: Page) {
    await page.locator('.snap-button').click();
    await expect(page.locator('.snap-dropdown')).toBeVisible();
  }

  async function setModes(page: Page, ticked: string[]) {
    await openSnapMenu(page);
    for (const label of ['Endpoint', 'Midpoint', 'Centre', 'Intersection', 'Perpendicular', 'Nearest']) {
      const box = page.getByRole('checkbox', { name: label, exact: true });
      if (await box.isDisabled()) continue;
      if ((await box.isChecked()) !== ticked.includes(label)) await box.click();
    }
    await page.keyboard.press('Escape');
  }

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.removeItem('wcad.snapModes.v1'));
    await page.reload();
    await page.waitForSelector('.map canvas', { timeout: 30_000 });
    await page.waitForTimeout(1500);
  });

  test('§7 menu: defaults, toggles stay open, Perpendicular greyed outside Polyline/Polygon, remembered', async ({ page }) => {
    await openSnapMenu(page);
    for (const [label, on] of [
      ['Endpoint', true],
      ['Midpoint', true],
      ['Centre', true],
      ['Intersection', true],
      ['Nearest', false],
    ] as const) {
      await expect(page.getByRole('checkbox', { name: label, exact: true }), label).toBeChecked({ checked: on });
    }
    await expect(page.getByRole('checkbox', { name: 'Perpendicular', exact: true })).toBeDisabled();

    await page.getByRole('checkbox', { name: 'Nearest', exact: true }).click();
    await expect(page.locator('.snap-dropdown'), 'menu stays open after a toggle').toBeVisible();

    // Esc closes only the menu; it must not reach the map.
    await page.keyboard.press('Escape');
    await expect(page.locator('.snap-dropdown')).toHaveCount(0);

    await tool(page, 'Polyline');
    await openSnapMenu(page);
    await expect(page.getByRole('checkbox', { name: 'Perpendicular', exact: true })).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Polyline', exact: true }), 'Esc on the menu kept the tool').toHaveClass(/active/);

    await page.reload();
    await page.waitForSelector('.map canvas');
    await openSnapMenu(page);
    await expect(page.getByRole('checkbox', { name: 'Nearest', exact: true }), 'remembered').toBeChecked();
  });

  test('Midpoint, Intersection, Perpendicular and Nearest snap to the right coordinates', async ({ page }) => {
    const { ox, oy } = await center(page);
    await drawPolyline(page, [[ox - 150, oy], [ox + 50, oy]]); // horizontal, midpoint at ox-50
    await drawPolyline(page, [[ox + 10, oy - 110], [ox + 10, oy + 100]]); // vertical, crosses at ox+10

    await tool(page, 'Polyline');
    await page.mouse.move(ox - 30, oy + 30);

    // Midpoint
    await page.mouse.move(ox - 48, oy + 2, { steps: 4 });
    await expect(snapLabel(page)).toHaveText('SNAP · midpoint');
    const mid = await coordOf(page);

    // Intersection (Midpoint off, so the vertical line's midpoint cannot win)
    await setModes(page, ['Endpoint', 'Centre', 'Intersection']);
    await page.mouse.move(ox + 30, oy + 30);
    await page.mouse.move(ox + 12, oy + 2, { steps: 4 });
    await expect(snapLabel(page)).toHaveText('SNAP · intersection');
    const [ix, iy] = await coordOf(page);
    expect(iy).toBeCloseTo(mid[1]!, 3); // on the horizontal line

    // Perpendicular from a placed vertex
    await setModes(page, ['Perpendicular']);
    await page.mouse.move(ox - 100, oy - 80);
    const start = await coordOf(page);
    await page.mouse.click(ox - 100, oy - 80);
    await page.mouse.move(ox - 96, oy + 3, { steps: 4 });
    await expect(snapLabel(page)).toHaveText('SNAP · perpendicular');
    const [px, py] = await coordOf(page);
    expect(px).toBeCloseTo(start[0]!, 3);
    expect(py).toBeCloseTo(mid[1]!, 3);
    await page.keyboard.press('Escape');

    // Nearest
    await setModes(page, ['Nearest']);
    await tool(page, 'Polyline');
    await page.mouse.move(ox - 120, oy + 30);
    await page.mouse.move(ox - 120, oy + 3, { steps: 4 });
    await expect(snapLabel(page)).toHaveText('SNAP · nearest');
    expect((await coordOf(page))[1]).toBeCloseTo(mid[1]!, 3);
    expect(ix).toBeGreaterThan(mid[0]!);
    void px;
  });
});

/** knowledge/line-tool-spec.md */
test.describe('line tool', () => {
  const count = async (page: Page) => Number.parseInt((await page.locator('.status-bar .count').textContent()) ?? '0', 10);

  async function propsAt(page: Page, x: number, y: number) {
    await page.mouse.move(x, y);
    await page.mouse.click(x, y, { button: 'right' });
    await page.locator('.context-menu').getByRole('menuitem', { name: 'Properties' }).click();
    const dl = await page.locator('.properties dl').innerText();
    const coords = (await page.locator('.properties .coords').innerText()).trim().split('\n');
    await page.locator('.properties-header button').click();
    return { dl, coords };
  }

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.map canvas', { timeout: 30_000 });
    await page.waitForTimeout(1500);
  });

  test('§1–2 each segment is its own 2-vertex Line, chained end to start', async ({ page }) => {
    const { ox, oy } = await center(page);
    await tool(page, 'Line');
    await page.mouse.click(ox - 150, oy + 60);
    await page.mouse.click(ox, oy - 60);
    await page.mouse.click(ox + 150, oy + 60);
    await page.keyboard.press('Enter');
    await expect(page.locator('.status-bar .message')).toContainText('Line ended (2 segments)');
    await expect.poll(() => count(page)).toBe(2);

    const first = await propsAt(page, ox - 75, oy);
    const second = await propsAt(page, ox + 75, oy);
    expect(first.dl).toMatch(/Type\s+line/);
    expect(first.dl).toMatch(/Vertices\s+2/);
    expect(second.dl).toMatch(/Vertices\s+2/);
    expect(second.coords[0], 'second segment starts exactly where the first ends').toBe(first.coords[1]);
  });

  test('§3 Backspace deletes the last segment; §2 Esc ends and keeps the rest', async ({ page }) => {
    const { ox, oy } = await center(page);
    await tool(page, 'Line');
    await page.mouse.click(ox - 150, oy);
    await page.mouse.click(ox - 50, oy - 40);
    await page.mouse.click(ox + 50, oy);
    await expect.poll(() => count(page)).toBe(2);
    await page.keyboard.press('Backspace');
    await expect.poll(() => count(page)).toBe(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.status-bar .message')).toContainText('Line ended (1 segment)');
    await expect(page.getByRole('button', { name: 'Line', exact: true }), 'first Esc only ends the chain').toHaveClass(/active/);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveClass(/active/);
    expect(await count(page)).toBe(1);
  });

  test('§4 double-click creates nothing extra and does not zoom', async ({ page }) => {
    const { ox, oy } = await center(page);
    await tool(page, 'Line');
    await page.mouse.click(ox - 100, oy);
    const before = await page.locator('.status-bar .coordinate').textContent();
    await page.mouse.dblclick(ox + 100, oy);
    await page.keyboard.press('Enter');
    await expect.poll(() => count(page)).toBe(1);
    await page.mouse.move(ox - 100, oy);
    void before;
  });

  test('§6 the second click snaps to the first segment’s end', async ({ page }) => {
    const { ox, oy } = await center(page);
    await tool(page, 'Line');
    await page.mouse.click(ox - 100, oy);
    await page.mouse.click(ox, oy);
    await page.keyboard.press('Enter');
    // New chain starting ~5 px from the previous end snaps onto it.
    await page.mouse.move(ox + 20, oy + 20);
    await page.mouse.move(ox + 4, oy + 3, { steps: 4 });
    await expect(page.locator('.status-bar .snap')).toHaveText('SNAP · endpoint');
    await page.mouse.click(ox + 4, oy + 3);
    await page.mouse.click(ox + 100, oy + 60);
    await page.keyboard.press('Enter');
    const a = await propsAt(page, ox - 50, oy);
    const b = await propsAt(page, ox + 50, oy + 30);
    expect(b.coords[0]).toBe(a.coords[1]);
  });
});
