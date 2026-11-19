// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

/**
 * Client-side checks for the registration form.
 *
 * Only usability checks: the real rules (password policy, unique email, verification) will live
 * in the identity provider once authentication is built. Nothing entered here is stored or sent.
 */

export interface RegistrationInput {
  readonly name: string;
  readonly email: string;
  readonly organisation: string;
  readonly password: string;
  readonly confirm: string;
  readonly consent: boolean;
}

export type RegistrationErrors = Partial<Record<keyof RegistrationInput, string>>;

export const MIN_PASSWORD_LENGTH = 12;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateRegistration(input: RegistrationInput): RegistrationErrors {
  const errors: RegistrationErrors = {};
  if (input.name.trim().length < 2) errors.name = 'Enter your full name.';
  if (!EMAIL.test(input.email.trim())) errors.email = 'Enter a valid work email.';
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    errors.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (input.confirm !== input.password) errors.confirm = "Passwords don't match.";
  if (!input.consent) errors.consent = 'Accept the terms and privacy notice to continue.';
  return errors;
}

export function isValid(errors: RegistrationErrors): boolean {
  return Object.keys(errors).length === 0;
}
