// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import type { Route } from '../routes.ts';
import { CadBackdrop } from './CadBackdrop.tsx';
import './landing.css';

/**
 * Public landing page. "Sign in" goes straight into the application for now; authentication is
 * the next piece of work (see knowledge/project-status.md).
 */
export function Landing(props: { onNavigate: (route: Route) => void }) {
  return (
    <div className="lp">
      <CadBackdrop />
      <div className="lp-shade" aria-hidden="true" />

      <header className="lp-header">
        <Wordmark />
        <nav className="lp-nav" aria-label="Account">
          <button className="lp-btn lp-btn--ghost" onClick={() => props.onNavigate('register')}>
            Register
          </button>
          <button className="lp-btn lp-btn--primary" onClick={() => props.onNavigate('app')}>
            Sign in
          </button>
        </nav>
      </header>

      <main className="lp-hero">
        <p className="lp-eyebrow">CAD · GIS · On-premises</p>
        <h1 className="lp-title">
          Precision drawing,
          <br />
          <span>at map scale.</span>
        </h1>
        <p className="lp-lede">
          Professional CAD drawing and mapping, right in your browser. Nothing to install. Nothing overcomplicated.
        </p>
        <div className="lp-cta">
          <button className="lp-btn lp-btn--primary lp-btn--large" onClick={() => props.onNavigate('app')}>
            Sign in
          </button>
          <button className="lp-btn lp-btn--ghost lp-btn--large" onClick={() => props.onNavigate('register')}>
            Create an account
          </button>
        </div>

        <ul className="lp-features">
          <li>
            <span className="lp-feature-title">Exact geometry</span>
            <span className="lp-feature-text">Full float64 coordinates, true arcs, precise snapping.</span>
          </li>
          <li>
            <span className="lp-feature-title">Any scale</span>
            <span className="lp-feature-text">From a whole region down to a single survey point.</span>
          </li>
          <li>
            <span className="lp-feature-title">Open formats</span>
            <span className="lp-feature-text">DXF, LandXML and GIS data in, open formats out.</span>
          </li>
        </ul>
      </main>

      <footer className="lp-footer">
        <span>EPSG:7801 · BGS2005 / CCS2005</span>
        <span>Open source · AGPL-3.0</span>
      </footer>
    </div>
  );
}

/** The wCAD wordmark with a small crosshair, shared by the public pages. */
export function Wordmark(props: { onClick?: () => void }) {
  return (
    <button className="lp-wordmark" onClick={props.onClick} tabIndex={props.onClick ? 0 : -1} aria-label="wCAD home">
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
        <path d="M10 1V19M1 10H19" stroke="#d4b483" strokeWidth="1.4" />
        <rect x="6.5" y="6.5" width="7" height="7" fill="none" stroke="#d4b483" strokeWidth="1.4" />
      </svg>
      <span>wCAD</span>
    </button>
  );
}
