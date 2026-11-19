// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import { expect, test } from '@playwright/test';

/** Public pages. No authentication yet: Sign in goes straight into the app. */
test.describe('landing and register', () => {
  test('landing offers Register and Sign in; Sign in opens the app', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Precision drawing');
    await expect(page.getByRole('button', { name: 'Register' })).toBeVisible();
    await page.getByRole('navigation').getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/app$/);
    await page.waitForSelector('.map canvas', { timeout: 30_000 });
  });

  test('register is a separate page; invalid input is explained; valid input continues', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Register' }).click();
    await expect(page).toHaveURL(/\/register$/);
    await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();

    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('Enter your full name.')).toBeVisible();
    await expect(page.getByText('Accept the terms and privacy notice to continue.')).toBeVisible();
    await expect(page).toHaveURL(/\/register$/);

    await page.getByLabel('Full name').fill('Test User');
    await page.getByLabel('Work email').fill('test.user@example.com');
    await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery');
    await page.getByLabel('Confirm password').fill('correct-horse-battery');
    await page.getByLabel('I agree to the terms of use and the privacy notice.').check();
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).toHaveURL(/\/app$/);
  });

  test('browser back returns from register to the landing page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Register' }).click();
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Precision drawing');
  });

  test('/app opens the application directly', async ({ page }) => {
    await page.goto('/app');
    await page.waitForSelector('.map canvas', { timeout: 30_000 });
  });
});
