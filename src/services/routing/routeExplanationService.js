const { calculateRouteExposure } = require('../../domain/routes/routeExposure');
const {
  explainParks,
  explainSunShade,
  explainWind,
  suggestChange
} = require('../../domain/routes/routeExplanation');
const defaultGreenAreaRepository = require('../../repositories/greenAreaRepository');
const defaultRouteSegmentRepository = require('../../repositories/routeSegmentRepository');
const { logger } = require('../../utils/logger');

const unavailable = (reason) => ({ status: 'unavailable', reason });

// The geometry of one step: the coordinates between its way points.
function stepGeometry(route, step) {
  const [start, end] = step.wayPoints;
  const coordinates = route.geometry.coordinates.slice(start, end + 1);
  return coordinates.length >= 2 ? { type: 'LineString', coordinates } : null;
}

/*
 * The shade percentage of each named step of the two routes, from the segment exposures the route
 * calculation already projected (PBI-5.3): the steps are matched to the street segments with the
 * same query as the routes, and no shadow is calculated again.
 */
async function stepShades(routes, segmentExposures, routeSegmentRepository) {
  const steps = [];
  routes.forEach((route, routeNumber) => {
    (route.steps ?? []).forEach((step) => {
      const geometry = step.name && step.distance > 0 ? stepGeometry(route, step) : null;
      if (geometry) steps.push({ routeNumber, step, geometry, routeIndex: steps.length });
    });
  });
  const shades = routes.map(() => new Map());
  if (!steps.length) return shades;
  const coverage = await routeSegmentRepository.findSegmentsForRoutes(
    steps.map(({ routeIndex, geometry }) => ({ routeIndex, geometry }))
  );
  steps.forEach(({ routeNumber, step, routeIndex }) => {
    const rows = coverage.filter((row) => Number(row.routeIndex) === routeIndex);
    const exposure = calculateRouteExposure({ distance: step.distance }, rows, segmentExposures);
    if (exposure.status === 'available') shades[routeNumber].set(step, exposure.shadePercentage);
  });
  return shades;
}

// One part of the explanation; if its data cannot be read it is left out, never the route.
async function safely(part, compute) {
  try {
    return await compute();
  } catch (error) {
    logger.warn(`Route explanation without ${part}: ${error.message}`);
    return unavailable('error');
  }
}

/**
 * Why the route of the answers suits them better than the fastest one, in streets, parks and minutes
 * (PBI-19, ADR-038), or, without a better route, a concrete change to try. It reuses what the route
 * calculation measured (`evidence`: the wind of each piece and the shade of each segment) and the ORS
 * steps; only the parks need a query of their own.
 *
 * @param {object} comparison as returned by the weighted comparison.
 * @param {object} preferences the answers and minutes of PBI-18.
 * @param {object} evidence filled by the weighted comparison.
 */
async function explainComparison(
  comparison,
  preferences,
  evidence = {},
  {
    routeSegmentRepository = defaultRouteSegmentRepository,
    greenAreaRepository = defaultGreenAreaRepository
  } = {}
) {
  const { status, fastest, selected } = comparison;
  if (status !== 'selected' || !selected) {
    return {
      status,
      suggestion: suggestChange({
        status,
        preferences,
        betterAlternativeExtraSeconds: comparison.betterAlternativeExtraSeconds
      })
    };
  }

  const time = {
    durationSeconds: selected.duration,
    fastestDurationSeconds: fastest.duration,
    extraSeconds:
      comparison.additionalDurationSeconds ?? Math.max(0, selected.duration - fastest.duration)
  };

  const wind = preferences.avoidWind
    ? explainWind({
        fastest,
        selected,
        fastestPieces: evidence.windPieces?.get(fastest.routeIndex) ?? [],
        selectedPieces: evidence.windPieces?.get(selected.routeIndex) ?? [],
        wind: evidence.wind
      })
    : unavailable('not_requested');

  const sunShade =
    preferences.sunShade === 'any'
      ? unavailable('not_requested')
      : await safely('shade', async () => {
          if (!evidence.segmentExposures) return unavailable('no_shade_data');
          const [fastestStepShade, selectedStepShade] = await stepShades(
            [fastest, selected],
            evidence.segmentExposures,
            routeSegmentRepository
          );
          return explainSunShade({
            kind: preferences.sunShade,
            fastest,
            selected,
            fastestStepShade,
            selectedStepShade
          });
        });

  const parks = preferences.preferParks
    ? await safely('parks', async () =>
        explainParks(await greenAreaRepository.findAlongRoute(selected.geometry))
      )
    : unavailable('not_requested');

  return { status, time, wind, sunShade, parks, suggestion: null };
}

module.exports = { explainComparison, stepGeometry };
