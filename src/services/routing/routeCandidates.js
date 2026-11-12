const { importConfig } = require('../../config/importConfig');
const {
  calculateRouteExposure,
  unavailableRouteExposure
} = require('../../domain/routes/routeExposure');
const { validateShadedRouteRequest } = require('../../domain/routes/routeRequest');
const {
  calculateRouteVegetation,
  unavailableRouteVegetation
} = require('../../domain/routes/routeVegetation');
const { calculateSolarPosition } = require('../../domain/solar/solarPosition');
const {
  getAlternativeWalkingRoutes
} = require('../../integrations/openRouteService/directionsClient');
const defaultRouteSegmentRepository = require('../../repositories/routeSegmentRepository');
const defaultVegetationRepository = require('../../repositories/vegetationRepository');
const { calculateSegmentExposures } = require('../shadow/exposureService');

function referenceFromSolarPosition(position) {
  return {
    instant: position.instant,
    localDateTime: position.localDateTime,
    timeZone: position.timeZone,
    latitude: position.latitude,
    longitude: position.longitude
  };
}

/**
 * The ORS candidates between two points, each with its sun/shade exposure at the given local date
 * and time (PBI-5.3) and, with includeVegetation, its green percentage (PBI-10 phase B, ADR-031).
 * Shared by the Shaded Route and the weighted routes. Without includeShade no shadows are
 * calculated (a wind-only route, ADR-025); without either, not even the segments of the routes.
 */
async function evaluateRouteCandidates(
  input,
  {
    routesProvider = getAlternativeWalkingRoutes,
    routeSegmentRepository = defaultRouteSegmentRepository,
    exposureCalculator = calculateSegmentExposures,
    solarCalculator = calculateSolarPosition,
    vegetationRepository = defaultVegetationRepository,
    includeShade = true,
    includeVegetation = false
  } = {}
) {
  const timeZone = validateShadedRouteRequest(input, importConfig.zaragozaBbox);
  const solarInput = {
    date: input.date,
    time: input.time,
    timeZone,
    latitude: input.origin.lat,
    longitude: input.origin.lng
  };
  // Validate and retain the reference before spending quota on ORS. The exposure service reuses
  // the same PBI-5.1 contract when it invokes PBI-5.2 for the mapped street segments.
  const solarPosition = solarCalculator(solarInput);
  const candidates = await routesProvider({
    origin: { lat: input.origin.lat, lng: input.origin.lng },
    destination: { lat: input.destination.lat, lng: input.destination.lng }
  });
  const indexedCandidates = candidates.map((route, routeIndex) => ({ ...route, routeIndex }));
  if (!includeShade && !includeVegetation) {
    return {
      routes: indexedCandidates.map((route) => ({
        ...route,
        exposure: unavailableRouteExposure('not_requested'),
        vegetation: unavailableRouteVegetation('not_requested')
      })),
      exposureStatus: null,
      reference: referenceFromSolarPosition(solarPosition)
    };
  }
  const coverageRows = await routeSegmentRepository.findSegmentsForRoutes(indexedCandidates);
  const segmentIds = [...new Set(coverageRows.map(({ segmentId }) => Number(segmentId)))];
  const coverageOf = (route) =>
    coverageRows.filter(({ routeIndex }) => Number(routeIndex) === route.routeIndex);

  let exposureResult = null;
  if (includeShade && segmentIds.length > 0) {
    exposureResult = await exposureCalculator({ segmentIds, ...solarInput });
  }
  const exposuresBySegmentId = new Map(
    (exposureResult?.segments || []).map((exposure) => [Number(exposure.segmentId), exposure])
  );
  const greenRatios = includeVegetation
    ? await vegetationRepository.findGreenRatios(segmentIds)
    : null;

  const routes = indexedCandidates.map((route) => ({
    ...route,
    exposure: includeShade
      ? calculateRouteExposure(route, coverageOf(route), exposuresBySegmentId)
      : unavailableRouteExposure('not_requested'),
    vegetation: greenRatios
      ? calculateRouteVegetation(route, coverageOf(route), greenRatios)
      : unavailableRouteVegetation('not_requested')
  }));

  return {
    routes,
    // Without projected shadows (night or a sun too low, ADR-015) the reason is more useful than
    // the generic lack of exposure data.
    exposureStatus:
      exposureResult && exposureResult.status !== 'calculated' ? exposureResult.status : null,
    reference: exposureResult?.reference || referenceFromSolarPosition(solarPosition)
  };
}

module.exports = { evaluateRouteCandidates };
