// Copyright (c) 2026 Dobromir. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
//
// Use of this file is governed by the Business Source License 1.1 found in the
// LICENSE file at the root of this repository. Production use requires a
// commercial license until the Change Date, after which the Change License
// (Apache-2.0) applies.

export function StatusBar(props: {
  message: string;
  coordinate: string;
  crs: string;
  elementCount: number;
}) {
  return (
    <footer className="status-bar">
      <span className="message">{props.message}</span>
      <span className="spacer" />
      <span className="coordinate">{props.coordinate}</span>
      <span className="crs">{props.crs}</span>
      <span className="count">{props.elementCount} elements</span>
    </footer>
  );
}
