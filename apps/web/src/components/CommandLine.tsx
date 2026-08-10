// Copyright (c) 2026 Dobromir. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
//
// Use of this file is governed by the Business Source License 1.1 found in the
// LICENSE file at the root of this repository. Production use requires a
// commercial license until the Change Date, after which the Change License
// (Apache-2.0) applies.

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
