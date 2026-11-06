const { QueryTypes } = require('sequelize');

const { sequelize } = require('../config/database');

const INPUT_GEOMETRY = 'ST_SetSRID(ST_GeomFromGeoJSON(geometry::text), 4326)';

// Each query returns one row per input record with status 'ok', 'repaired' or 'invalid_geometry'.
const UPSERT_SQL = {
  buildings: `
    WITH input AS (
      SELECT * FROM jsonb_to_recordset(CAST(:rows AS jsonb)) AS r(
        item_id text, source_id text, height_m float8, height_source text, height_suspicious boolean,
        floors int,
        geometry jsonb)
    ), prepared AS (
      SELECT *, ${INPUT_GEOMETRY} AS g FROM input
    ), fixed AS (
      SELECT *, ST_IsValid(g) AS was_valid,
        ST_Multi(ST_CollectionExtract(ST_MakeValid(g), 3)) AS mg
      FROM prepared
    ), upserted AS (
      INSERT INTO buildings
        (source, source_id, height_m, height_source, height_suspicious, floors, geom, import_run_id)
      SELECT :source, source_id, height_m, height_source, height_suspicious, floors, mg, :runId
      FROM fixed WHERE NOT ST_IsEmpty(mg)
      ON CONFLICT (source, source_id) DO UPDATE SET
        height_m = EXCLUDED.height_m, height_source = EXCLUDED.height_source,
        height_suspicious = EXCLUDED.height_suspicious,
        floors = EXCLUDED.floors, geom = EXCLUDED.geom, import_run_id = EXCLUDED.import_run_id
      RETURNING 1
    )
    SELECT item_id, CASE
      WHEN ST_IsEmpty(mg) THEN 'invalid_geometry'
      WHEN was_valid THEN 'ok'
      ELSE 'repaired' END AS status
    FROM fixed`,
  trees: `
    WITH input AS (
      SELECT * FROM jsonb_to_recordset(CAST(:rows AS jsonb)) AS r(
        item_id text, source_id text, species text, height_m float8, crown_diameter_m float8,
        geometry jsonb)
    ), checked AS (
      SELECT *, ${INPUT_GEOMETRY} AS g FROM input
    ), upserted AS (
      INSERT INTO trees (source, source_id, species, height_m, crown_diameter_m, geom, import_run_id)
      SELECT :source, source_id, species, height_m, crown_diameter_m, g, :runId
      FROM checked WHERE ST_IsValid(g)
      ON CONFLICT (source, source_id) DO UPDATE SET
        species = EXCLUDED.species, height_m = EXCLUDED.height_m,
        crown_diameter_m = EXCLUDED.crown_diameter_m, geom = EXCLUDED.geom,
        import_run_id = EXCLUDED.import_run_id
      RETURNING 1
    )
    SELECT item_id, CASE WHEN ST_IsValid(g) THEN 'ok' ELSE 'invalid_geometry' END AS status
    FROM checked`,
  street_segments: `
    WITH input AS (
      SELECT * FROM jsonb_to_recordset(CAST(:rows AS jsonb)) AS r(
        item_id text, source_id text, osm_way_id bigint, name text, highway text, geometry jsonb)
    ), checked AS (
      SELECT *, ${INPUT_GEOMETRY} AS g FROM input
    ), upserted AS (
      INSERT INTO street_segments
        (source, source_id, osm_way_id, name, highway, geom, length_m, import_run_id)
      SELECT :source, source_id, osm_way_id, name, highway, g, ST_Length(g::geography), :runId
      FROM checked WHERE ST_IsValid(g)
      ON CONFLICT (source, source_id) DO UPDATE SET
        osm_way_id = EXCLUDED.osm_way_id, name = EXCLUDED.name, highway = EXCLUDED.highway,
        geom = EXCLUDED.geom, length_m = EXCLUDED.length_m, import_run_id = EXCLUDED.import_run_id
      RETURNING 1
    )
    SELECT item_id, CASE WHEN ST_IsValid(g) THEN 'ok' ELSE 'invalid_geometry' END AS status
    FROM checked`,
  // The rings arrive as a MultiLineString; ST_BuildArea joins them into polygons with holes.
  green_areas: `
    WITH input AS (
      SELECT * FROM jsonb_to_recordset(CAST(:rows AS jsonb)) AS r(
        item_id text, source_id text, kind text, name text, geometry jsonb)
    ), built AS (
      SELECT *, ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_BuildArea(${INPUT_GEOMETRY})), 3)) AS mg
      FROM input
    ), upserted AS (
      INSERT INTO green_areas (source, source_id, kind, name, geom, import_run_id)
      SELECT :source, source_id, kind, name, mg, :runId
      FROM built WHERE mg IS NOT NULL AND NOT ST_IsEmpty(mg)
      ON CONFLICT (source, source_id) DO UPDATE SET
        kind = EXCLUDED.kind, name = EXCLUDED.name, geom = EXCLUDED.geom,
        import_run_id = EXCLUDED.import_run_id
      RETURNING 1
    )
    SELECT item_id, CASE WHEN mg IS NULL OR ST_IsEmpty(mg) THEN 'invalid_geometry' ELSE 'ok' END
      AS status
    FROM built`
};

function toRow(record) {
  return {
    item_id: record.itemId,
    source_id: record.sourceId,
    height_m: record.heightM,
    height_source: record.heightSource,
    height_suspicious: record.heightSuspicious,
    floors: record.floors,
    species: record.species,
    crown_diameter_m: record.crownDiameterM,
    osm_way_id: record.osmWayId,
    name: record.name,
    highway: record.highway,
    kind: record.kind,
    geometry: record.geometry
  };
}

function runUpsert(table, records, { source, runId }, transaction) {
  return sequelize.query(UPSERT_SQL[table], {
    replacements: { rows: JSON.stringify(records.map(toRow)), source, runId },
    type: QueryTypes.SELECT,
    transaction
  });
}

/*
 * Upserts a batch in one transaction. If the batch fails (e.g. a geometry PostGIS cannot
 * parse), records are retried one by one so only the offending ones are reported as failures.
 */
async function upsertBatch(table, records, options) {
  let rows;
  try {
    rows = await sequelize.transaction((transaction) =>
      runUpsert(table, records, options, transaction)
    );
  } catch {
    rows = [];

    for (const record of records) {
      try {
        // eslint-disable-next-line no-await-in-loop
        rows.push(...(await runUpsert(table, [record], options)));
      } catch (error) {
        rows.push({ item_id: record.itemId, status: `database_error: ${error.message}` });
      }
    }
  }
  return {
    failures: rows
      .filter((row) => row.status !== 'ok' && row.status !== 'repaired')
      .map((row) => ({ itemId: row.item_id, reason: row.status })),
    repaired: rows.filter((row) => row.status === 'repaired').length
  };
}

async function deleteStale(table, { source, runId }) {
  if (!UPSERT_SQL[table]) throw new Error(`Unknown table ${table}`);
  const [, result] = await sequelize.query(
    `DELETE FROM ${table} WHERE source = :source AND import_run_id IS DISTINCT FROM :runId`,
    { replacements: { source, runId } }
  );
  return result.rowCount;
}

module.exports = { upsertBatch, deleteStale };
