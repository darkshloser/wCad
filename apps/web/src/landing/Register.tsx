// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import { type FormEvent, type ReactNode, useState } from 'react';
import type { Route } from '../routes.ts';
import { CadBackdrop } from './CadBackdrop.tsx';
import { Wordmark } from './Landing.tsx';
import {
  MIN_PASSWORD_LENGTH,
  type RegistrationErrors,
  type RegistrationInput,
  isValid,
  validateRegistration,
} from './registerForm.ts';
import './landing.css';

const EMPTY: RegistrationInput = { name: '', email: '', organisation: '', password: '', confirm: '', consent: false };

/**
 * Registration page — design and client-side checks only. Nothing entered is stored or sent
 * anywhere; account creation arrives with authentication.
 */
export function Register(props: { onNavigate: (route: Route) => void }) {
  const [form, setForm] = useState<RegistrationInput>(EMPTY);
  const [errors, setErrors] = useState<RegistrationErrors>({});
  const [submitted, setSubmitted] = useState(false);

  const set = <K extends keyof RegistrationInput>(key: K, value: RegistrationInput[K]) => {
    const next = { ...form, [key]: value };
    setForm(next);
    // Once the user has tried to submit, errors update as they type.
    if (submitted) setErrors(validateRegistration(next));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    const found = validateRegistration(form);
    setErrors(found);
    if (!isValid(found)) return;
    // Preview: no account is created. The password is dropped with the component's state.
    props.onNavigate('app');
  };

  return (
    <div className="lp lp--centered">
      <CadBackdrop />
      <div className="lp-shade lp-shade--even" aria-hidden="true" />

      <header className="lp-header">
        <Wordmark onClick={() => props.onNavigate('landing')} />
        <nav className="lp-nav" aria-label="Account">
          <button className="lp-btn lp-btn--ghost" onClick={() => props.onNavigate('app')}>
            Sign in
          </button>
        </nav>
      </header>

      <main className="lp-card-wrap">
        <form className="lp-card" onSubmit={submit} noValidate aria-labelledby="lp-register-title">
          <h1 id="lp-register-title" className="lp-card-title">
            Create your account
          </h1>
          <p className="lp-card-sub">A project owner grants you access to their drawings.</p>

          <Field label="Full name" error={errors.name}>
            <input autoComplete="name" value={form.name} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label="Work email" error={errors.email}>
            <input type="email" autoComplete="email" placeholder="name@company.com" value={form.email} onChange={(e) => set('email', e.target.value)} />
          </Field>
          <Field label="Organisation" optional>
            <input autoComplete="organization" value={form.organisation} onChange={(e) => set('organisation', e.target.value)} />
          </Field>
          <div className="lp-row">
            <Field label="Password" error={errors.password} hint={`At least ${MIN_PASSWORD_LENGTH} characters`}>
              <input type="password" autoComplete="new-password" value={form.password} onChange={(e) => set('password', e.target.value)} />
            </Field>
            <Field label="Confirm password" error={errors.confirm}>
              <input type="password" autoComplete="new-password" value={form.confirm} onChange={(e) => set('confirm', e.target.value)} />
            </Field>
          </div>

          <label className={`lp-consent ${errors.consent ? 'lp-consent--error' : ''}`}>
            <input type="checkbox" checked={form.consent} onChange={(e) => set('consent', e.target.checked)} />
            <span>I agree to the terms of use and the privacy notice.</span>
          </label>
          {errors.consent && <p className="lp-error">{errors.consent}</p>}

          <button type="submit" className="lp-btn lp-btn--primary lp-btn--block">
            Create account
          </button>

          <p className="lp-card-foot">
            Already registered?{' '}
            <button type="button" className="lp-link" onClick={() => props.onNavigate('app')}>
              Sign in
            </button>
          </p>
          <p className="lp-preview-note">Preview: accounts aren't stored yet.</p>
        </form>
      </main>
    </div>
  );
}

function Field(props: { label: string; error?: string | undefined; hint?: string; optional?: boolean; children: ReactNode }) {
  return (
    <label className={`lp-field ${props.error ? 'lp-field--error' : ''}`}>
      <span className="lp-field-label">
        {props.label}
        {props.optional && <span className="lp-optional">Optional</span>}
      </span>
      {props.children}
      {props.error ? <span className="lp-error">{props.error}</span> : props.hint && <span className="lp-hint">{props.hint}</span>}
    </label>
  );
}
