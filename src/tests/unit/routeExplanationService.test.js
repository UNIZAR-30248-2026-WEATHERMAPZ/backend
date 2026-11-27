const { explainComparison } = require('../../services/routing/routeExplanationService');

const line = (count) => ({
  type: 'LineString',
  coordinates: Array.from({ length: count }, (_, i) => [-0.88 + i * 0.001, 41.65])
});

const fastest = {
  routeIndex: 0,
  duration: 900,
  geometry: line(5),
  windExposure: { status: 'available', exposure: 40 },
  steps: [
    { name: 'Paseo de Sagasta', distance: 300, wayPoints: [0, 2] },
    { name: null, distance: 50, wayPoints: [2, 4] }
  ]
};
const selected = {
  routeIndex: 1,
  duration: 960,
  geometry: line(5),
  windExposure: { status: 'available', exposure: 20 },
  steps: [
    { name: 'Calle del Doctor Horno Alcorta', distance: 250, wayPoints: [0, 2] },
    { name: 'Calle de Ávila', distance: 150, wayPoints: [2, 4] }
  ]
};
const comparison = { status: 'selected', fastest, selected, additionalDurationSeconds: 60 };
const answers = (overrides = {}) => ({
  sunShade: 'any',
  avoidWind: false,
  preferParks: false,
  extraMinutes: 5,
  ...overrides
});

describe('route explanation service (PBI-19, ADR-038)', () => {
  const routeSegmentRepository = { findSegmentsForRoutes: jest.fn() };
  const greenAreaRepository = { findAlongRoute: jest.fn() };
  const repositories = { routeSegmentRepository, greenAreaRepository };

  beforeEach(() => jest.clearAllMocks());

  it('gives the minutes and asks nothing for the answers that were not given', async () => {
    const explanation = await explainComparison(comparison, answers(), {}, repositories);
    expect(explanation).toEqual({
      status: 'selected',
      time: { durationSeconds: 960, fastestDurationSeconds: 900, extraSeconds: 60 },
      wind: { status: 'unavailable', reason: 'not_requested' },
      sunShade: { status: 'unavailable', reason: 'not_requested' },
      parks: { status: 'unavailable', reason: 'not_requested' },
      suggestion: null
    });
    expect(routeSegmentRepository.findSegmentsForRoutes).not.toHaveBeenCalled();
    expect(greenAreaRepository.findAlongRoute).not.toHaveBeenCalled();
  });

  it('measures the shade of each named step with the segment exposures already projected', async () => {
    // The steps are sent as routes: 0 is Paseo de Sagasta (fastest), 1 and 2 the chosen route.
    routeSegmentRepository.findSegmentsForRoutes.mockResolvedValue([
      { routeIndex: 0, segmentId: 10, overlapLengthM: 300 },
      { routeIndex: 1, segmentId: 11, overlapLengthM: 250 },
      { routeIndex: 2, segmentId: 12, overlapLengthM: 150 }
    ]);
    const segmentExposures = new Map([
      [10, { status: 'available', shadeRatio: 0.2 }],
      [11, { status: 'available', shadeRatio: 0.95 }],
      [12, { status: 'available', shadeRatio: 0.5 }]
    ]);

    const explanation = await explainComparison(
      comparison,
      answers({ sunShade: 'shade' }),
      { segmentExposures },
      repositories
    );

    const sent = routeSegmentRepository.findSegmentsForRoutes.mock.calls[0][0];
    expect(sent.map((step) => step.routeIndex)).toEqual([0, 1, 2]);
    expect(sent[0].geometry.coordinates).toEqual(fastest.geometry.coordinates.slice(0, 3));
    expect(explanation.sunShade).toEqual({
      status: 'available',
      kind: 'shade',
      streets: [{ street: 'Calle del Doctor Horno Alcorta', percentage: 95 }],
      instead: { street: 'Paseo de Sagasta', percentage: 20 }
    });
  });

  it('without projected shadows says so instead of querying', async () => {
    const explanation = await explainComparison(
      comparison,
      answers({ sunShade: 'sun' }),
      {},
      repositories
    );
    expect(explanation.sunShade).toEqual({ status: 'unavailable', reason: 'no_shade_data' });
    expect(routeSegmentRepository.findSegmentsForRoutes).not.toHaveBeenCalled();
  });

  it('names the parks along the chosen route', async () => {
    greenAreaRepository.findAlongRoute.mockResolvedValue([
      { name: 'Parque Pignatelli', areaM2: 30000 },
      { name: null, areaM2: 400 }
    ]);
    const explanation = await explainComparison(
      comparison,
      answers({ preferParks: true }),
      {},
      repositories
    );
    expect(greenAreaRepository.findAlongRoute).toHaveBeenCalledWith(selected.geometry);
    expect(explanation.parks).toEqual({
      status: 'available',
      named: ['Parque Pignatelli'],
      moreNamedCount: 0,
      unnamedCount: 1
    });
  });

  it('leaves a part out if its data cannot be read, never the route', async () => {
    greenAreaRepository.findAlongRoute.mockRejectedValue(new Error('timeout'));
    const explanation = await explainComparison(
      comparison,
      answers({ preferParks: true }),
      {},
      repositories
    );
    expect(explanation.parks).toEqual({ status: 'unavailable', reason: 'error' });
    expect(explanation.time.extraSeconds).toBe(60);
  });

  it('uses the wind of each piece kept by the route calculation', async () => {
    const explanation = await explainComparison(
      comparison,
      answers({ avoidWind: true }),
      { wind: null, windPieces: new Map() },
      repositories
    );
    expect(explanation.wind).toEqual({ status: 'unavailable', reason: 'no_wind_data' });
  });

  it('without a better route suggests a concrete change', async () => {
    expect(
      await explainComparison(
        { status: 'over_extra_time', fastest, selected: null, betterAlternativeExtraSeconds: 400 },
        answers({ preferParks: true, extraMinutes: 5 }),
        {},
        repositories
      )
    ).toEqual({ status: 'over_extra_time', suggestion: { kind: 'more_minutes', minutes: 10 } });
  });
});
