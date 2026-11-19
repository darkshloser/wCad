// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

/**
 * The three top-level pages. Deliberately tiny: three routes do not justify a router dependency,
 * and keeping the mapping pure means it is unit-tested rather than discovered in a browser.
 *
 *   /           landing page (public)
 *   /register   account registration (public)
 *   /app        the CAD application
 */

export type Route = 'landing' | 'register' | 'app';

export function routeFromPath(pathname: string): Route {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (p === '/app' || p.startsWith('/app/')) return 'app';
  if (p === '/register') return 'register';
  return 'landing';
}

export function pathFor(route: Route): string {
  return route === 'app' ? '/app' : route === 'register' ? '/register' : '/';
}
