// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { type Route, pathFor, routeFromPath } from './routes.ts';
import { Landing } from './landing/Landing.tsx';
import { Register } from './landing/Register.tsx';

// The CAD application (OpenLayers, the stores, proj4…) is loaded only when entered, so the public
// pages open instantly.
const App = lazy(() => import('./App.tsx').then((m) => ({ default: m.App })));

export function Root() {
  const [route, setRoute] = useState<Route>(() => routeFromPath(window.location.pathname));

  useEffect(() => {
    const onPop = () => setRoute(routeFromPath(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    document.title = route === 'app' ? 'wCAD' : route === 'register' ? 'Create account — wCAD' : 'wCAD — Precision drawing at map scale';
  }, [route]);

  const navigate = useCallback((next: Route) => {
    if (routeFromPath(window.location.pathname) !== next) window.history.pushState(null, '', pathFor(next));
    setRoute(next);
    window.scrollTo(0, 0);
  }, []);

  if (route === 'app') {
    return (
      <Suspense fallback={<div className="lp-loading">Loading wCAD…</div>}>
        <App />
      </Suspense>
    );
  }
  if (route === 'register') return <Register onNavigate={navigate} />;
  return <Landing onNavigate={navigate} />;
}
