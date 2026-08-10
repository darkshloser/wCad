-- Copyright (c) 2026 Dobromir. All rights reserved.
-- SPDX-License-Identifier: BUSL-1.1
--
-- Use of this file is governed by the Business Source License 1.1 found in the
-- LICENSE file at the root of this repository.

-- wCAD initial schema (architecture doc section 4.2).
--
-- Design notes that matter at scale:
--   * `elements` is LIST-partitioned by project so one huge drawing cannot slow down others,
--     and dropping a project is a DROP PARTITION rather than a mass DELETE.
--   * `geom` is the authoritative float64 geometry and is never generalized (principle P1).
--     `geom_lod1..3` are the pre-generalized display copies used by the tile pipeline.
--   * metadata is JSONB with a GIN index: schema-less JSON per element, queryable, and one
--     fewer database to run on-premise than a separate document store.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

CREATE TABLE IF NOT EXISTS projects (
  id            bigserial PRIMARY KEY,
  name          text        NOT NULL,
  crs_code      text        NOT NULL,
  -- Render origin for float32 rebasing on the GPU path (architecture doc section 5.2).
  render_origin double precision[2],
  extent        box2d,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS layers (
  id             bigserial PRIMARY KEY,
  project_id     bigint      NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name           text        NOT NULL,
  style_defaults jsonb,
  -- Optional JSON Schema used to validate metadata written against this layer.
  metadata_schema jsonb,
  UNIQUE (project_id, name)
);

-- Styles are deduplicated: a million elements share a few hundred styles, so storing style
-- JSON per element would be pure waste on the render path.
CREATE TABLE IF NOT EXISTS styles (
  id         serial PRIMARY KEY,
  project_id bigint REFERENCES projects(id) ON DELETE CASCADE,
  definition jsonb NOT NULL
);

-- Principle P5: geometry stored once, placed many times.
CREATE TABLE IF NOT EXISTS block_definitions (
  id            bigserial PRIMARY KEY,
  project_id    bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          text   NOT NULL,
  geometry_blob bytea  NOT NULL,
  bbox          box2d,
  entity_count  integer NOT NULL DEFAULT 0,
  UNIQUE (project_id, name)
);

CREATE TABLE IF NOT EXISTS elements (
  id          bigserial,
  project_id  bigint      NOT NULL,
  layer_id    bigint      NOT NULL,
  kind        smallint    NOT NULL,
  srid        integer     NOT NULL,

  geom        geometry    NOT NULL,
  z_values    double precision[],
  params      jsonb,

  geom_lod1   geometry,
  geom_lod2   geometry,
  geom_lod3   geometry,
  bbox        box2d       NOT NULL,

  block_id    bigint,
  transform   double precision[6],

  style_id    integer,
  metadata    jsonb,

  version     integer     NOT NULL DEFAULT 1,
  created_by  bigint,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  bigint,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,

  PRIMARY KEY (project_id, id)
) PARTITION BY LIST (project_id);

-- Append-only change log for audit and recovery. Distinct from client-side undo, which is a
-- local command stack and never a server round trip.
CREATE TABLE IF NOT EXISTS element_history (
  id         bigserial PRIMARY KEY,
  project_id bigint      NOT NULL,
  element_id bigint      NOT NULL,
  version    integer     NOT NULL,
  op         text        NOT NULL CHECK (op IN ('create', 'update', 'delete')),
  payload    jsonb,
  actor      bigint,
  at         timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (at);

CREATE TABLE IF NOT EXISTS dirty_tiles (
  project_id bigint      NOT NULL,
  z          smallint    NOT NULL,
  x          integer     NOT NULL,
  y          integer     NOT NULL,
  marked_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, z, x, y)
);

-- Creates a project together with its own partition. Partition creation is deliberately part
-- of project creation so no code path can insert into an unpartitioned table.
CREATE OR REPLACE FUNCTION create_project(p_name text, p_crs text)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  new_id bigint;
BEGIN
  INSERT INTO projects (name, crs_code) VALUES (p_name, p_crs) RETURNING id INTO new_id;

  EXECUTE format(
    'CREATE TABLE elements_p%s PARTITION OF elements FOR VALUES IN (%s)', new_id, new_id);
  EXECUTE format(
    'CREATE INDEX elements_p%s_geom_gist ON elements_p%s USING GIST (geom)', new_id, new_id);
  EXECUTE format(
    'CREATE INDEX elements_p%s_lod1_gist ON elements_p%s USING GIST (geom_lod1)', new_id, new_id);
  EXECUTE format(
    'CREATE INDEX elements_p%s_meta_gin ON elements_p%s USING GIN (metadata jsonb_path_ops)', new_id, new_id);
  EXECUTE format(
    'CREATE INDEX elements_p%s_layer ON elements_p%s (layer_id) WHERE deleted_at IS NULL', new_id, new_id);

  RETURN new_id;
END;
$$;

-- Default history partition so writes never fail before a monthly partition exists.
CREATE TABLE IF NOT EXISTS element_history_default PARTITION OF element_history DEFAULT;

CREATE INDEX IF NOT EXISTS element_history_element ON element_history (project_id, element_id, version);
