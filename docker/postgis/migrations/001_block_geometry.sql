-- wCAD — CAD/GIS Web Application
-- Copyright (C) 2026 Dobromir
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- See the LICENSE file at the root of this repository.

-- Block definitions hold real PostGIS geometry, not an opaque blob.
--
-- The baseline declared `geometry_blob bytea`, which cannot be transformed or clipped by the
-- database. Principle P5 (instance, don't explode) only pays off if instances can be expanded at
-- tile time — one ST_Affine per instance against a stored GEOMETRYCOLLECTION — rather than
-- materialised as exploded copies in `elements`. A bytea column would force that expansion into
-- the application, which means shipping every block's geometry to the tile service for every tile
-- that touches an instance.
--
-- The column was never populated, so there is nothing to migrate.

ALTER TABLE block_definitions DROP COLUMN IF EXISTS geometry_blob;
ALTER TABLE block_definitions ADD COLUMN IF NOT EXISTS geometry geometry;

-- Base point of the block, in its own coordinate space. Instance transforms are relative to it,
-- and it is almost never the origin in real drawings.
ALTER TABLE block_definitions ADD COLUMN IF NOT EXISTS base_point double precision[2];

-- Tile generation looks definitions up by id while expanding instances; the primary key covers
-- that. This index serves import, which resolves them by name.
CREATE INDEX IF NOT EXISTS block_definitions_project_name
  ON block_definitions (project_id, name);

-- Instances are found by block during "where is this block used" queries and when a definition
-- changes and its tiles must be invalidated.
CREATE INDEX IF NOT EXISTS elements_block_ref
  ON elements (project_id, block_id)
  WHERE block_id IS NOT NULL;
