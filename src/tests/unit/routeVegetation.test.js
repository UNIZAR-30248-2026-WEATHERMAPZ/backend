const {
  calculateRouteVegetation,
  unavailableRouteVegetation
} = require('../../domain/routes/routeVegetation');

const ratios = new Map([
  [1, 1],
  [2, 0],
  [3, 0.5]
]);

describe('green percentage of a route (PBI-10 phase B, ADR-031)', () => {
  it('weights the green ratio of each segment by the length of route over it', () => {
    const result = calculateRouteVegetation(
      { distance: 1000 },
      [
        { segmentId: 1, overlapLengthM: 300 },
        { segmentId: 2, overlapLengthM: 500 },
        { segmentId: 3, overlapLengthM: 200 }
      ],
      ratios
    );

    // (300 × 1 + 500 × 0 + 200 × 0.5) / 1000 = 40 %, not the plain mean of the ratios (50 %).
    expect(result).toEqual({
      status: 'available',
      reason: null,
      coverageRatio: 1,
      coveragePercentage: 100,
      greenPercentage: 40
    });
  });

  it('only counts the segments with an index, and needs 80 % of the route covered', () => {
    const covered = calculateRouteVegetation(
      { distance: 1000 },
      [
        { segmentId: 1, overlapLengthM: 800 },
        { segmentId: 99, overlapLengthM: 200 }
      ],
      ratios
    );
    expect(covered).toMatchObject({ status: 'available', greenPercentage: 100 });
    expect(covered.coverageRatio).toBeCloseTo(0.8);

    const notCovered = calculateRouteVegetation(
      { distance: 1000 },
      [{ segmentId: 1, overlapLengthM: 790 }],
      ratios
    );
    expect(notCovered).toMatchObject({
      status: 'unavailable',
      reason: 'insufficient_segment_coverage',
      greenPercentage: null
    });
    expect(notCovered.coverageRatio).toBeCloseTo(0.79);
  });

  it('is unavailable without the vegetation index (never calculated)', () => {
    expect(
      calculateRouteVegetation(
        { distance: 500 },
        [{ segmentId: 1, overlapLengthM: 500 }],
        new Map()
      )
    ).toMatchObject({ status: 'unavailable', reason: 'insufficient_segment_coverage' });
  });

  it.each([[{ distance: 0 }], [{ distance: Number.NaN }], [null]])(
    'rejects a route without a valid distance: %j',
    (route) => {
      expect(calculateRouteVegetation(route, [], ratios)).toEqual(
        unavailableRouteVegetation('invalid_route_distance')
      );
    }
  );

  it('ignores coverage rows without a usable length', () => {
    const result = calculateRouteVegetation(
      { distance: 100 },
      [
        { segmentId: 1, overlapLengthM: 100 },
        { segmentId: 2, overlapLengthM: 'x' },
        { segmentId: 2, overlapLengthM: -5 }
      ],
      ratios
    );
    expect(result).toMatchObject({ status: 'available', greenPercentage: 100 });
  });
});
