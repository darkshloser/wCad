// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import { useState } from 'react';

/**
 * AutoCAD-style coordinate entry. Parsing lives in geo-core so typed input and mouse input
 * converge on exactly one geometry-building path.
 */
export function CommandLine(props: {
  onSubmit: (text: string) => void;
  axisLabels: readonly [string, string, string];
}) {
  const [value, setValue] = useState('');
  const [a, b, c] = props.axisLabels;

  return (
    <form
      className="command-line"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim().length === 0) return;
        props.onSubmit(value);
        setValue('');
      }}
    >
      <label htmlFor="cmd">Coordinate</label>
      <input
        id="cmd"
        value={value}
        autoComplete="off"
        placeholder={`${a},${b}  or  ${a},${b},${c}  or  @10,5  or  @50<45`}
        onChange={(e) => setValue(e.target.value)}
      />
      <button type="submit">Enter</button>
    </form>
  );
}
