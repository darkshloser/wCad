// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

/**
 * Decorative CAD/GIS drawing behind the public pages: a drafting grid, topographic contours, a
 * cadastral parcel with a dimension, a survey traverse being drawn (in the app's own in-progress
 * style), a north arrow and a scale bar. Purely decorative, so it is hidden from screen readers.
 *
 * Inline SVG on purpose: no image requests, crisp at any resolution, and it works on an
 * air-gapped on-prem install.
 */
export function CadBackdrop() {
  return (
    <svg className="lp-backdrop" viewBox="0 0 1600 1000" preserveAspectRatio="xMaxYMid slice" aria-hidden="true">
      <defs>
        <pattern id="lp-grid-minor" width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M20 0H0V20" fill="none" stroke="rgba(255,255,255,0.028)" strokeWidth="1" />
        </pattern>
        <pattern id="lp-grid-major" width="100" height="100" patternUnits="userSpaceOnUse">
          <rect width="100" height="100" fill="url(#lp-grid-minor)" />
          <path d="M100 0H0V100" fill="none" stroke="rgba(255,255,255,0.055)" strokeWidth="1" />
        </pattern>
        <radialGradient id="lp-glow" cx="72%" cy="45%" r="55%">
          <stop offset="0" stopColor="#d4b483" stopOpacity="0.07" />
          <stop offset="1" stopColor="#d4b483" stopOpacity="0" />
        </radialGradient>
      </defs>

      <rect width="1600" height="1000" fill="url(#lp-grid-major)" />
      <rect width="1600" height="1000" fill="url(#lp-glow)" />

      {/* Topographic contours */}
      <g fill="none" stroke="#d4b483" strokeWidth="1">
        <path className="lp-contour" strokeOpacity="0.22" d="M1150 330c70-8 132 30 140 92s-48 112-128 114-150-36-150-100 68-98 138-106z" />
        <path className="lp-contour" strokeOpacity="0.17" d="M1140 270c110-14 214 42 222 150s-82 186-210 186-232-58-226-164 104-158 214-172z" />
        <path className="lp-contour" strokeOpacity="0.13" d="M1132 205c150-20 296 54 304 214s-118 260-292 258-318-80-308-232 146-220 296-240z" />
        <path className="lp-contour" strokeOpacity="0.09" d="M1120 140c196-24 378 70 384 276s-160 338-378 330-404-104-386-300 184-282 380-306z" />
        <path className="lp-contour" strokeOpacity="0.06" d="M1104 70c246-30 462 90 462 350s-210 420-470 404-484-130-456-370 218-354 464-384z" />
      </g>

      {/* Cadastral parcel with a dimension */}
      <g>
        <path d="M770 300 L940 250 L1005 395 L835 455 Z" fill="rgba(229,231,235,0.035)" stroke="rgba(229,231,235,0.28)" strokeWidth="1" />
        <path d="M773 278 L937 230" stroke="rgba(212,180,131,0.55)" strokeWidth="1" />
        <path d="M770 300 L767 272 M940 250 L934 222" stroke="rgba(212,180,131,0.4)" strokeWidth="1" />
        <text x="842" y="246" className="lp-dim" transform="rotate(-16.4 842 246)">42.318 m</text>
        <text x="868" y="362" className="lp-label">PI 68134.402.117</text>
      </g>

      {/* Survey traverse being drawn — the app's in-progress style */}
      <g fill="none">
        <path className="lp-traverse" d="M860 900 L990 800 L1110 838 L1240 720 L1370 758" stroke="rgba(229,231,235,0.7)" strokeWidth="1.4" />
        <path className="lp-rubber" d="M1370 758 L1460 630" stroke="rgba(229,231,235,0.7)" strokeWidth="1.2" strokeDasharray="6 5" />
        {[
          [860, 900],
          [990, 800],
          [1110, 838],
          [1240, 720],
          [1370, 758],
        ].map(([x, y]) => (
          <rect key={`${x}-${y}`} x={x! - 4} y={y! - 4} width="8" height="8" fill="#06080b" stroke="rgba(229,231,235,0.8)" strokeWidth="1.2" />
        ))}
        <g className="lp-crosshair" stroke="#e5e7eb" strokeWidth="1.2">
          <path d="M1448 630H1472M1460 618V642" />
        </g>
        <g className="lp-snap">
          <rect x="1231" y="711" width="18" height="18" transform="rotate(45 1240 720)" stroke="#22c55e" strokeWidth="1.5" fill="rgba(34,197,94,0.12)" />
        </g>
      </g>
      <text x="1482" y="624" className="lp-coord">E 500 123.456</text>
      <text x="1482" y="642" className="lp-coord">N 4 650 321.987</text>

      {/* North arrow */}
      <g transform="translate(1490 130)" stroke="rgba(229,231,235,0.45)" fill="none" strokeWidth="1">
        <circle r="26" />
        <path d="M0 -36 L8 6 L0 0 L-8 6 Z" fill="rgba(229,231,235,0.45)" />
        <text y="-44" className="lp-north">N</text>
      </g>

      {/* Scale bar */}
      <g transform="translate(1310 920)">
        <rect width="60" height="6" fill="rgba(229,231,235,0.5)" />
        <rect x="60" width="60" height="6" fill="none" stroke="rgba(229,231,235,0.5)" strokeWidth="1" />
        <rect x="120" width="60" height="6" fill="rgba(229,231,235,0.5)" />
        <text y="24" className="lp-scale">0</text>
        <text x="120" y="24" className="lp-scale">50</text>
        <text x="180" y="24" className="lp-scale">75 m</text>
      </g>
    </svg>
  );
}
