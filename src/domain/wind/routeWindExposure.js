const { httpError } = require('../../utils/httpError');
const { windIntensity } = require('./windExposure');

// Wind from behind bothers less than in the face (ADR-025). Provisional, like the thresholds.
const TAILWIND_FACTOR = 0.5;
const EARTH_RADIUS_M = 6371008.8;
const MAX_ACCEPTED_WIND_SPEED_KMH = 200;

const toRadians = (degrees) => (degrees * Math.PI) / 180;
const toDegrees = (radians) => (radians * 180) / Math.PI;

/*
 * Walking direction (initial bearing, degrees from north) and length of each straight piece of a
 * route. The pieces of an ORS route are a few metres long, so the haversine length is exact enough.
 */
function routePieces(geometry) {
  const coordinates = geometry?.coordinates;
  if (!Array.isArray(coordinates)) return [];
  const pieces = [];
  for (let index = 1; index < coordinates.length; index += 1) {
    const [lng1, lat1] = coordinates[index - 1].map(toRadians);
    const [lng2, lat2] = coordinates[index].map(toRadians);
    const deltaLng = lng2 - lng1;
    const haversine =
      Math.sin((lat2 - lat1) / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
    const lengthM = 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(haversine)));
    const bearingDeg =
      (toDegrees(
        Math.atan2(
          Math.sin(deltaLng) * Math.cos(lat2),
          Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng)
        )
      ) +
        360) %
      360;
    if (Number.isFinite(lengthM) && lengthM > 0) pieces.push({ bearingDeg, lengthM });
  }
  return pieces;
}

/*
 * How much a piece walked in bearingDeg faces a wind coming from windDirectionDeg: 1 in the face,
 * TAILWIND_FACTOR from behind and 0 across, like the |cos| of PBI-8.1 but with the walking direction.
 */
function directionalAlignment(bearingDeg, windDirectionDeg) {
  const cosine = Math.cos(toRadians(windDirectionDeg - bearingDeg));
  return cosine >= 0 ? cosine : -cosine * TAILWIND_FACTOR;
}

function unavailableRouteWindExposure(reason) {
  return { status: 'unavailable', reason, exposure: null, alignment: null, intensity: null };
}

// Length-weighted wind exposure (0-100) of a route walked from its first to its last point.
function calculateRouteWindExposure(route, { speedKmh, directionDeg }) {
  const pieces = routePieces(route?.geometry);
  const totalM = pieces.reduce((sum, piece) => sum + piece.lengthM, 0);
  if (totalM <= 0) return unavailableRouteWindExposure('invalid_route_geometry');

  const alignment =
    pieces.reduce(
      (sum, piece) => sum + piece.lengthM * directionalAlignment(piece.bearingDeg, directionDeg),
      0
    ) / totalM;
  const intensity = windIntensity(speedKmh);
  return {
    status: 'available',
    reason: null,
    exposure: 100 * alignment * intensity,
    alignment,
    intensity
  };
}

// Optional wind of a route request: { speedKmh, directionDeg }, both numbers.
function parseRouteWind(wind) {
  if (wind === undefined || wind === null) return null;
  const fields = {};
  const speedKmh = wind?.speedKmh;
  const directionDeg = wind?.directionDeg;
  if (!Number.isFinite(speedKmh) || speedKmh < 0 || speedKmh > MAX_ACCEPTED_WIND_SPEED_KMH) {
    fields.windSpeedKmh = `Debe ser un número entre 0 y ${MAX_ACCEPTED_WIND_SPEED_KMH}.`;
  }
  if (!Number.isFinite(directionDeg) || directionDeg < 0 || directionDeg > 360) {
    fields.windDirectionDeg = 'Debe ser un número entre 0 y 360.';
  }
  if (Object.keys(fields).length) throw httpError(400, 'El viento no es válido.', fields);
  return { speedKmh, directionDeg };
}

module.exports = {
  TAILWIND_FACTOR,
  calculateRouteWindExposure,
  directionalAlignment,
  parseRouteWind,
  routePieces,
  unavailableRouteWindExposure
};
