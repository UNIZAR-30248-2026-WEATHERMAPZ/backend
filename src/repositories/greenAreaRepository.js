const { QueryTypes } = require('sequelize');

const { sequelize } = require('../config/database');
const { shadowConfig } = require('../config/shadowConfig');
const { withStatementTimeout } = require('./statementTimeout');

// A park counts as passed through if the route goes through it or along its edge (PBI-19, ADR-038).
const ALONG_ROUTE_M = 20;
// About 50 m in degrees at the latitude of Zaragoza: a cheap bounding-box filter for the GIST index
// before the exact distance in metres.
const BBOX_MARGIN_DEG = 0.0006;

/**
 * The parks and gardens of OpenStreetMap (PBI-10, ADR-026) the route passes through or along, with
 * their name (null if they have none) and area, in one query. Same time limit as the other route
 * queries (ADR-015).
 */
async function findAlongRoute(geometry, distanceM = ALONG_ROUTE_M) {
  if (geometry?.type !== 'LineString' || !Array.isArray(geometry.coordinates)) {
    throw new TypeError('geometry must be a GeoJSON LineString');
  }
  return withStatementTimeout(shadowConfig.queryTimeoutMs, (transaction) =>
    sequelize.query(
      `WITH route AS (
         SELECT ST_SetSRID(ST_GeomFromGeoJSON(:geometry), 4326) AS geom
       )
       SELECT g.id, NULLIF(trim(g.name), '') AS name, g.kind,
         ST_Area(g.geom::geography)::float8 AS "areaM2"
       FROM green_areas g, route r
       WHERE g.geom && ST_Expand(r.geom, :bboxMarginDeg)
         AND ST_DWithin(g.geom::geography, r.geom::geography, :distanceM)
       ORDER BY "areaM2" DESC`,
      {
        replacements: {
          geometry: JSON.stringify(geometry),
          distanceM,
          bboxMarginDeg: BBOX_MARGIN_DEG
        },
        type: QueryTypes.SELECT,
        transaction
      }
    )
  );
}

module.exports = { ALONG_ROUTE_M, findAlongRoute };
