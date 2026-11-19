// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { pathFor, routeFromPath } from '../src/routes.ts';
import { MIN_PASSWORD_LENGTH, isValid, validateRegistration } from '../src/landing/registerForm.ts';

describe('routes', () => {
  it('maps paths to pages', () => {
    expect(routeFromPath('/')).toBe('landing');
    expect(routeFromPath('')).toBe('landing');
    expect(routeFromPath('/register')).toBe('register');
    expect(routeFromPath('/register/')).toBe('register');
    expect(routeFromPath('/app')).toBe('app');
    expect(routeFromPath('/app/')).toBe('app');
    expect(routeFromPath('/app/anything')).toBe('app');
    expect(routeFromPath('/unknown')).toBe('landing');
    expect(routeFromPath('/application')).toBe('landing');
  });

  it('round-trips', () => {
    for (const r of ['landing', 'register', 'app'] as const) expect(routeFromPath(pathFor(r))).toBe(r);
  });
});

describe('registration form', () => {
  const good = {
    name: 'Dobromir Ivanov',
    email: 'd.ivanov@example.com',
    organisation: '',
    password: 'x'.repeat(MIN_PASSWORD_LENGTH),
    confirm: 'x'.repeat(MIN_PASSWORD_LENGTH),
    consent: true,
  };

  it('accepts a complete form; organisation is optional', () => {
    expect(isValid(validateRegistration(good))).toBe(true);
  });

  it('flags each problem', () => {
    const e = validateRegistration({ name: ' ', email: 'nope', organisation: '', password: 'short', confirm: 'other', consent: false });
    expect(Object.keys(e).sort()).toEqual(['confirm', 'consent', 'email', 'name', 'password']);
  });

  it('requires consent to the privacy notice (GDPR)', () => {
    expect(validateRegistration({ ...good, consent: false }).consent).toBeDefined();
  });
});
