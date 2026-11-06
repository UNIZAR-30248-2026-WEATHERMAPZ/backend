const { isInsideBbox } = require('../../domain/geo/geometryValidation');

// Public parks and gardens of OSM used by the vegetation index (ADR-026).
const GREEN_AREA_KINDS = ['park', 'garden'];
const CLOSED_ACCESS = ['private', 'no'];

function buildGreenAreasQuery(municipalityIneRef) {
  const filters = `["leisure"~"^(${GREEN_AREA_KINDS.join('|')})$"]["access"!~"^(${CLOSED_ACCESS.join('|')})$"]`;
  return [
    '[out:json][timeout:300];',
    `area["boundary"="administrative"]["admin_level"="8"]["ref:ine"~"^${municipalityIneRef}"]->.municipality;`,
    '(',
    `  way${filters}(area.municipality);`,
    `  relation${filters}["type"="multipolygon"](area.municipality);`,
    ');',
    'out geom;'
  ].join('\n');
}

const toLine = (geometry) =>
  (geometry || [])
    .filter((point) => point && Number.isFinite(point.lon) && Number.isFinite(point.lat))
    .map((point) => [point.lon, point.lat]);

// A way is one ring; a multipolygon is the rings of its member ways, joined later by PostGIS.
function ringLines(element) {
  if (element.type === 'way') return [toLine(element.geometry)];
  return (element.members || [])
    .filter((member) => member.type === 'way')
    .map((member) => toLine(member.geometry));
}

const isClosed = (line) =>
  line.length >= 4 &&
  line[0][0] === line[line.length - 1][0] &&
  line[0][1] === line[line.length - 1][1];

/*
 * Maps an Overpass element (with "out geom") to a green area. The geometry is sent as a
 * MultiLineString of its rings: ST_BuildArea in the upsert turns it into polygons with holes.
 */
function mapGreenArea(element, { bbox }) {
  const sourceId = `${element.type}/${element.id}`;
  const tags = element.tags || {};
  if (!GREEN_AREA_KINDS.includes(tags.leisure)) return { sourceId, rejection: 'not_green_area' };
  if (CLOSED_ACCESS.includes(tags.access)) return { sourceId, rejection: 'not_public' };
  if (element.type !== 'way' && element.type !== 'relation') {
    return { sourceId, rejection: 'unsupported_element' };
  }

  const lines = ringLines(element).filter((line) => line.length >= 2);
  if (lines.length === 0) return { sourceId, rejection: 'missing_geometry' };
  if (element.type === 'way' && !isClosed(lines[0])) return { sourceId, rejection: 'open_way' };
  if (!lines.every((line) => line.every((position) => isInsideBbox(position, bbox)))) {
    return { sourceId, rejection: 'outside_zaragoza_bbox' };
  }

  return {
    sourceId,
    records: [
      {
        itemId: sourceId,
        sourceId,
        kind: tags.leisure,
        name: tags.name || null,
        geometry: { type: 'MultiLineString', coordinates: lines }
      }
    ],
    stats: { [tags.leisure]: 1 },
    warnings: []
  };
}

module.exports = { CLOSED_ACCESS, GREEN_AREA_KINDS, buildGreenAreasQuery, mapGreenArea };
