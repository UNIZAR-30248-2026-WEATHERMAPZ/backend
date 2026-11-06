const { QueryTypes } = require('sequelize');

const { sequelize } = require('../config/database');

function select(sql, replacements, transaction) {
  return sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction });
}

/*
 * Runs callback(transaction) with a PostgreSQL statement_timeout that applies to each statement
 * of that transaction (SET LOCAL), so a single batch cannot keep the database busy indefinitely.
 */
function withStatementTimeout(timeoutMs, callback) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive integer');
  }
  return sequelize.transaction(async (transaction) => {
    // SET does not accept bind parameters; timeoutMs is a validated integer.
    await sequelize.query(`SET LOCAL statement_timeout = ${timeoutMs}`, { transaction });
    return callback(transaction);
  });
}

/*
 * The data the index is calculated from: the latest finished tree association and the latest
 * finished green areas import (runs in progress are skipped, as markStale does).
 */
async function getInputs() {
  const [treeAssociation] = await select(
    `SELECT id, status, (params ->> 'treeRadiusM')::float8 AS "treeRadiusM"
     FROM association_runs WHERE element_type = 'tree' AND status <> 'running'
     ORDER BY id DESC LIMIT 1`
  );
  const [greenAreasImport] = await select(
    `SELECT id, status FROM import_runs WHERE dataset = 'green_areas' AND status <> 'running'
     ORDER BY started_at DESC, id DESC LIMIT 1`
  );
  return { treeAssociation: treeAssociation ?? null, greenAreasImport: greenAreasImport ?? null };
}

async function createRun(params, { treeAssociationRunId, greenAreasImportRunId }) {
  const [row] = await select(
    `INSERT INTO vegetation_runs (params, tree_association_run_id, green_areas_import_run_id)
     VALUES (CAST(:params AS jsonb), :treeAssociationRunId, :greenAreasImportRunId)
     RETURNING id`,
    { params: JSON.stringify(params), treeAssociationRunId, greenAreasImportRunId }
  );
  return row.id;
}

async function finishRun(runId, fields) {
  await sequelize.query(
    `UPDATE vegetation_runs SET
       finished_at = now(), status = :status, segments = :segments,
       street_segments = :streetSegments, length_m = :lengthM, green_length_m = :greenLengthM,
       details = CAST(:details AS jsonb)
     WHERE id = :runId`,
    {
      replacements: {
        runId,
        status: fields.status,
        segments: fields.segments ?? null,
        streetSegments: fields.streetSegments ?? null,
        lengthM: fields.lengthM ?? null,
        greenLengthM: fields.greenLengthM ?? null,
        details: JSON.stringify(fields.details ?? {})
      }
    }
  );
}

// Starts the recalculation: the previous index is discarded.
async function clear(transaction) {
  await sequelize.query('DELETE FROM segment_vegetation', { transaction });
}

async function segmentIdRange(transaction) {
  const [row] = await select(
    'SELECT min(id) AS "minId", max(id) AS "maxId" FROM street_segments',
    {},
    transaction
  );
  return { minId: row.minId, maxId: row.maxId };
}

/*
 * Index of the segments with fromId <= id <= toId, in EPSG:25830 (ADR-003). The trees within
 * treeRadiusM come from segment_trees (ADR-009), which already links every segment within the
 * larger association radius; each one becomes a disc of that radius. Green areas are found with
 * their GIST index. The length of the segment inside the union of all of them is the green
 * length, so a stretch near a tree inside a park counts once.
 */
async function computeBatch(range, { treeRadiusM }, runId, transaction) {
  await sequelize.query(
    `INSERT INTO segment_vegetation (segment_id, length_m, tree_length_m, green_area_length_m,
       green_length_m, green_ratio, trees_count, vegetation_run_id)
     SELECT s.id, m.length_m, m.tree_length_m, m.green_area_length_m, m.green_length_m,
       CASE WHEN m.length_m > 0 THEN LEAST(1, m.green_length_m / m.length_m) ELSE 0 END,
       m.trees_count, :runId
     FROM street_segments s
     CROSS JOIN LATERAL (SELECT ST_Transform(s.geom, 25830) AS geom_m) g
     CROSS JOIN LATERAL (
       SELECT
         ST_Length(g.geom_m) AS length_m,
         COALESCE(ST_Length(ST_CollectionExtract(ST_Intersection(
           g.geom_m, ST_Union(green.geom) FILTER (WHERE green.kind = 'tree')), 2)), 0)
           AS tree_length_m,
         COALESCE(ST_Length(ST_CollectionExtract(ST_Intersection(
           g.geom_m, ST_Union(green.geom) FILTER (WHERE green.kind = 'area')), 2)), 0)
           AS green_area_length_m,
         COALESCE(ST_Length(ST_CollectionExtract(ST_Intersection(
           g.geom_m, ST_Union(green.geom)), 2)), 0) AS green_length_m,
         (count(*) FILTER (WHERE green.kind = 'tree'))::int AS trees_count
       FROM (
         SELECT 'tree' AS kind, ST_Buffer(ST_Transform(t.geom, 25830), :treeRadiusM) AS geom
         FROM segment_trees st JOIN trees t ON t.id = st.tree_id
         WHERE st.segment_id = s.id AND st.distance_m <= :treeRadiusM
         UNION ALL
         SELECT 'area', ST_Transform(a.geom, 25830)
         FROM green_areas a WHERE ST_Intersects(a.geom, s.geom)
       ) green
     ) m
     WHERE s.id BETWEEN :fromId AND :toId`,
    {
      replacements: { runId, treeRadiusM, fromId: range.fromId, toId: range.toId },
      transaction
    }
  );
}

// Counts used to reconcile the run and the distribution of green_ratio by length.
async function countResults(transaction) {
  const [row] = await select(
    `SELECT
       (SELECT count(*) FROM segment_vegetation)::int AS segments,
       (SELECT count(*) FROM street_segments)::int AS "streetSegments",
       (SELECT COALESCE(sum(length_m), 0) FROM segment_vegetation)::float8 AS "lengthM",
       (SELECT COALESCE(sum(green_length_m), 0) FROM segment_vegetation)::float8 AS "greenLengthM",
       (SELECT COALESCE(sum(tree_length_m), 0) FROM segment_vegetation)::float8 AS "treeLengthM",
       (SELECT COALESCE(sum(green_area_length_m), 0) FROM segment_vegetation)::float8
         AS "greenAreaLengthM"`,
    {},
    transaction
  );
  // Bucket 0: no green; 1 to 5: (0, 20] ... (80, 100] %.
  const distribution = await select(
    `SELECT bucket, count(*)::int AS segments, sum(length_m)::float8 AS "lengthM"
     FROM (
       SELECT CASE WHEN green_ratio = 0 THEN 0 ELSE LEAST(5, ceil(green_ratio * 5)::int) END
         AS bucket, length_m
       FROM segment_vegetation
     ) b
     GROUP BY bucket ORDER BY bucket`,
    {},
    transaction
  );
  return { ...row, distribution };
}

// Latest execution (also if it is still running), for /api/data/status.
async function getLatestRun() {
  const [run] = await select(
    `SELECT id, status, started_at AS "startedAt", finished_at AS "finishedAt", params,
       tree_association_run_id AS "treeAssociationRunId",
       green_areas_import_run_id AS "greenAreasImportRunId", segments,
       street_segments AS "streetSegments", length_m AS "lengthM", green_length_m AS "greenLengthM"
     FROM vegetation_runs ORDER BY id DESC LIMIT 1`
  );
  return run ?? null;
}

module.exports = {
  clear,
  computeBatch,
  countResults,
  createRun,
  finishRun,
  getInputs,
  getLatestRun,
  segmentIdRange,
  withStatementTimeout
};
