// Copyright (c) 2026 Dobromir. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
//
// Use of this file is governed by the Business Source License 1.1 found in the
// LICENSE file at the root of this repository. Production use requires a
// commercial license until the Change Date, after which the Change License
// (Apache-2.0) applies.

import { useEffect, useState } from 'react';
import type { ElementRecord } from '@wcad/store-contract';

/**
 * Element properties plus the free-form JSON metadata editor.
 *
 * Metadata is fetched lazily by the caller when the panel opens and is never carried on the
 * render path (architecture doc section 10).
 */
export function PropertiesPanel(props: {
  element: ElementRecord | null;
  axisLabels: readonly [string, string, string];
  onClose: () => void;
  onSaveMetadata: (id: string, metadata: Record<string, unknown>) => Promise<void>;
}) {
  const { element, axisLabels } = props;
  const [text, setText] = useState('{}');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(JSON.stringify(element?.metadata ?? {}, null, 2));
    setError(null);
  }, [element?.id, element?.version]);

  if (!element) return null;

  const save = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setError('Metadata must be a JSON object.');
      return;
    }
    setError(null);
    void props.onSaveMetadata(element.id, parsed as Record<string, unknown>);
  };

  return (
    <aside className="properties">
      <div className="properties-header">
        <h2>Properties</h2>
        <button onClick={props.onClose}>×</button>
      </div>

      <dl>
        <dt>Id</dt>
        <dd>{element.id}</dd>
        <dt>Type</dt>
        <dd>{element.kind}</dd>
        <dt>Layer</dt>
        <dd>{element.layerId}</dd>
        <dt>CRS</dt>
        <dd>{element.crs}</dd>
        <dt>Version</dt>
        <dd>{element.version}</dd>
        <dt>Vertices</dt>
        <dd>{element.coords.length}</dd>
      </dl>

      {element.params && (
        <>
          <h3>Parametric definition</h3>
          <table className="params">
            <tbody>
              {Object.entries(element.params).map(([k, v]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h3>Coordinates ({axisLabels.join(' / ')})</h3>
      <div className="coords">
        {element.coords.slice(0, 20).map((c, i) => (
          <div key={i}>
            {/* Full precision, deliberately: this is authoritative float64 data, not a display value. */}
            {c.map((v) => v.toPrecision(12)).join('   ')}
          </div>
        ))}
        {element.coords.length > 20 && <div>… {element.coords.length - 20} more</div>}
      </div>

      <h3>Metadata (JSON)</h3>
      <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} rows={12} />
      {error && <p className="error">{error}</p>}
      <button className="primary" onClick={save}>
        Save metadata
      </button>
    </aside>
  );
}
