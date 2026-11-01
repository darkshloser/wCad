-- wCAD — CAD/GIS Web Application
-- Copyright (C) 2026 Dobromir
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- See the LICENSE file at the root of this repository.

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

-- ---------------------------------------------------------------------------------------------
-- Schema versioning.
--
-- This file is the BASELINE (version 000) and only ever runs on an empty data directory —
-- PostgreSQL skips docker-entrypoint-initdb.d entirely once a database exists. Everything after
-- the baseline lives in docker/postgis/migrations/ and is applied by `wcad.ps1 migrate`, which is
-- also run automatically by `up`.
--
-- Editing this file alone changes nothing for anyone who already has a database, which is exactly
-- how a schema change silently fails to reach the machines that matter.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    text        PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version) VALUES ('000_baseline')
ON CONFLICT (version) DO NOTHING;

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
  -- Draw order and tile ranking priority. Lower is drawn and ranked first.
  priority       integer     NOT NULL DEFAULT 100,
  visible        boolean     NOT NULL DEFAULT true,
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
  -- Precomputed bounding-box diagonal in CRS units. Drives per-tile importance ordering and
  -- small-feature culling. Stored rather than computed per row: at 10M rows, calling
  -- ST_BoundingDiagonal inside every tile query is the difference between hitting and missing
  -- the 300 ms tile budget.
  bbox_diag   double precision NOT NULL DEFAULT 0,

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
--
-- The primary key is (id, at), not id alone: PostgreSQL requires every unique or primary key
-- constraint on a partitioned table to include the partition key column, since uniqueness can
-- only be enforced per-partition, not across the whole table.
CREATE TABLE IF NOT EXISTS element_history (
  id         bigserial   NOT NULL,
  project_id bigint      NOT NULL,
  element_id bigint      NOT NULL,
  version    integer     NOT NULL,
  op         text        NOT NULL CHECK (op IN ('create', 'update', 'delete')),
  payload    jsonb,
  actor      bigint,
  at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, at)
) PARTITION BY RANGE (at);

CREATE TABLE IF NOT EXISTS dirty_tiles (
  project_id bigint      NOT NULL,
  z          smallint    NOT NULL,
  x          integer     NOT NULL,
  y          integer     NOT NULL,
  marked_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, z, x, y)
);

-- ---------------------------------------------------------------------------------------------
-- Job queue (architecture doc principle P6: everything large is a job, not a request).
--
-- The queue lives in PostgreSQL rather than in Valkey. The deciding argument is the chaos test:
-- a worker killed mid-import must leave the queue and the imported rows agreeing with each other.
-- With the queue in another process that is a distributed-consensus problem; here a stage
-- checkpoint and the rows it describes commit in ONE transaction, so a killed worker rolls back
-- to a state that is consistent by construction. `SELECT ... FOR UPDATE SKIP LOCKED` gives
-- correct concurrent claiming, and at import volumes (jobs per hour, not per millisecond) the
-- throughput ceiling is nowhere near relevant.

CREATE TABLE IF NOT EXISTS import_jobs (
  id            bigserial PRIMARY KEY,
  project_id    bigint      REFERENCES projects(id) ON DELETE CASCADE,
  kind          text        NOT NULL,
  source_uri    text        NOT NULL,
  source_bytes  bigint,
  source_sha256 text,
  params        jsonb       NOT NULL DEFAULT '{}'::jsonb,

  status        text        NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'dead')),
  priority      integer     NOT NULL DEFAULT 100,

  -- Resumability: the stage a worker last committed, plus its opaque progress cursor. A restart
  -- resumes from here rather than from the beginning.
  stage         text        NOT NULL DEFAULT 'pending',
  checkpoint    jsonb       NOT NULL DEFAULT '{}'::jsonb,

  entities_total       bigint NOT NULL DEFAULT 0,
  entities_imported    bigint NOT NULL DEFAULT 0,
  entities_unsupported bigint NOT NULL DEFAULT 0,
  -- Per-type counts of what could not be imported. Never silently dropped (plan section 7 step 4).
  unsupported_detail   jsonb  NOT NULL DEFAULT '{}'::jsonb,
  errors               jsonb  NOT NULL DEFAULT '[]'::jsonb,

  attempts      integer     NOT NULL DEFAULT 0,
  max_attempts  integer     NOT NULL DEFAULT 3,

  -- Liveness. A worker that dies without releasing its claim is reclaimed once this goes stale,
  -- which is why claiming checks the heartbeat rather than the status alone.
  claimed_by    text,
  claimed_at    timestamptz,
  heartbeat_at  timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz
);

-- Supports the claim query's ordering without scanning finished jobs.
CREATE INDEX IF NOT EXISTS import_jobs_claimable
  ON import_jobs (priority ASC, id ASC)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS import_jobs_project ON import_jobs (project_id, created_at DESC);

-- Append-only progress log, for operators watching a long import and for post-mortems.
CREATE TABLE IF NOT EXISTS job_events (
  id       bigserial PRIMARY KEY,
  job_id   bigint      NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  at       timestamptz NOT NULL DEFAULT now(),
  level    text        NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warn', 'error')),
  stage    text,
  message  text        NOT NULL,
  detail   jsonb
);

CREATE INDEX IF NOT EXISTS job_events_job ON job_events (job_id, id DESC);

/**
 * Claims one job, atomically.
 *
 * Takes queued jobs, and running jobs whose worker has stopped heartbeating (a crashed worker
 * must not strand its job forever). SKIP LOCKED lets N workers claim concurrently without
 * blocking each other or handing the same job to two of them.
 */
CREATE OR REPLACE FUNCTION claim_import_job(p_worker text, p_stale_after interval DEFAULT '60 seconds')
RETURNS import_jobs LANGUAGE plpgsql AS $$
DECLARE
  claimed import_jobs;
BEGIN
  WITH candidate AS (
    SELECT id FROM import_jobs
     WHERE (status = 'queued')
        OR (status = 'running' AND heartbeat_at < now() - p_stale_after)
     ORDER BY priority ASC, id ASC
     FOR UPDATE SKIP LOCKED
     LIMIT 1
  )
  UPDATE import_jobs j
     SET status       = 'running',
         attempts     = j.attempts + 1,
         claimed_by   = p_worker,
         claimed_at   = now(),
         heartbeat_at = now(),
         started_at   = COALESCE(j.started_at, now())
    FROM candidate c
   WHERE j.id = c.id
   RETURNING j.* INTO claimed;

  RETURN claimed;
END;
$$;

/**
 * Records a resumable checkpoint.
 *
 * Called inside the same transaction as the batch of rows it describes, so the checkpoint and the
 * data it refers to can never disagree — the property the chaos tests exercise.
 */
CREATE OR REPLACE FUNCTION checkpoint_import_job(
  p_job_id bigint, p_stage text, p_checkpoint jsonb, p_imported bigint
) RETURNS void LANGUAGE sql AS $$
  UPDATE import_jobs
     SET stage             = p_stage,
         checkpoint        = p_checkpoint,
         entities_imported = p_imported,
         heartbeat_at      = now()
   WHERE id = p_job_id;
$$;

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
  -- Supports the tile query's ORDER BY bbox_diag DESC within a layer.
  EXECUTE format(
    'CREATE INDEX elements_p%s_tile ON elements_p%s (layer_id, bbox_diag DESC) WHERE deleted_at IS NULL',
    new_id, new_id);
  EXECUTE format(
    'CREATE INDEX elements_p%s_lod2_gist ON elements_p%s USING GIST (geom_lod2)', new_id, new_id);
  EXECUTE format(
    'CREATE INDEX elements_p%s_lod3_gist ON elements_p%s USING GIST (geom_lod3)', new_id, new_id);

  RETURN new_id;
END;
$$;

-- Default history partition so writes never fail before a monthly partition exists.
CREATE TABLE IF NOT EXISTS element_history_default PARTITION OF element_history DEFAULT;

CREATE INDEX IF NOT EXISTS element_history_element ON element_history (project_id, element_id, version);
