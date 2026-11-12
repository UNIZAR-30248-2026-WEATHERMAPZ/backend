const { MIN_EXPOSURE_COVERAGE_RATIO } = require('./routeExposure');

/*
 * Green percentage of a route (PBI-10 phase B, ADR-031): the green_ratio of the street segments it
 * follows (ADR-026), weighted by the length of route over each one. Like the sun/shade exposure it
 * needs local data for most of the route; unlike it, it does not depend on the Sun.
 */
function unavailableRouteVegetation(reason, coverageRatio = 0) {
  return {
    status: 'unavailable',
    reason,
    coverageRatio,
    coveragePercentage: coverageRatio * 100,
    greenPercentage: null
  };
}

/**
 * @param route ORS route with its `distance` in metres.
 * @param segmentCoverage rows { segmentId, overlapLengthM } of that route.
 * @param greenRatioBySegmentId Map segmentId → green_ratio (0-1); a segment without it is not
 *   covered.
 */
function calculateRouteVegetation(route, segmentCoverage, greenRatioBySegmentId) {
  if (!Number.isFinite(route?.distance) || route.distance <= 0) {
    return unavailableRouteVegetation('invalid_route_distance');
  }

  let coveredLengthM = 0;
  let greenLengthM = 0;
  segmentCoverage.forEach(({ segmentId, overlapLengthM }) => {
    const ratio = greenRatioBySegmentId.get(Number(segmentId));
    const length = Number(overlapLengthM);
    if (!Number.isFinite(ratio) || !Number.isFinite(length) || length <= 0) return;
    coveredLengthM += length;
    greenLengthM += length * ratio;
  });

  const coverageRatio = Math.min(1, coveredLengthM / route.distance);
  if (coverageRatio < MIN_EXPOSURE_COVERAGE_RATIO) {
    return unavailableRouteVegetation('insufficient_segment_coverage', coverageRatio);
  }
  return {
    status: 'available',
    reason: null,
    coverageRatio,
    coveragePercentage: coverageRatio * 100,
    greenPercentage: Math.min(100, Math.max(0, (greenLengthM / coveredLengthM) * 100))
  };
}

module.exports = { calculateRouteVegetation, unavailableRouteVegetation };
