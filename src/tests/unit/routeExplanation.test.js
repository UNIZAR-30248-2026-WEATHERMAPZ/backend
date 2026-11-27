const {
  EXPLANATION_CONFIG,
  explainParks,
  explainSunShade,
  explainWind,
  routeStreets,
  suggestChange
} = require('../../domain/routes/routeExplanation');

// A route whose steps cover the coordinates [from, to] of each street; unnamed steps have name null.
function route(streets, windExposure = 30) {
  let index = 0;
  const steps = streets.map(([name, distance]) => {
    const step = { name, distance, wayPoints: [index, index + 2] };
    index += 2;
    return step;
  });
  return { steps, windExposure: { status: 'available', exposure: windExposure } };
}

// Pieces of a route walked north (bearing 0) that end at each coordinate, so a wind from the north
// (0°) blows in the face; `facing` lists the coordinate indexes walked north, the rest go east.
function pieces(count, facing = []) {
  return Array.from({ length: count }, (_, i) => ({
    index: i + 1,
    lengthM: 50,
    bearingDeg: facing.includes(i + 1) ? 0 : 90,
    openness: 0
  }));
}

const NORTH_WIND = { speedKmh: 40, directionDeg: 0 };

describe('route explanation (PBI-19, ADR-038)', () => {
  describe('routeStreets', () => {
    it('groups the steps of each named street and leaves the unnamed ones out', () => {
      const streets = routeStreets(
        route([
          ['Calle del Coso', 100],
          [null, 40],
          ['Calle del Coso', 60]
        ]),
        pieces(6)
      );
      expect(streets).toHaveLength(1);
      expect(streets[0]).toMatchObject({ name: 'Calle del Coso', lengthM: 160 });
      expect(streets[0].pieces.map((piece) => piece.index)).toEqual([1, 2, 5, 6]);
    });
  });

  describe('explainWind', () => {
    // Fastest: Paseo de la Independencia (north, windy) and Calle Alfonso I (east); chosen: Calle
    // del Coso (east, sheltered) and Calle Alfonso I.
    const fastest = route(
      [
        ['Paseo de la Independencia', 300],
        ['Calle Alfonso I', 200]
      ],
      60
    );
    const selected = route(
      [
        ['Calle del Coso', 400],
        ['Calle Alfonso I', 200]
      ],
      20
    );
    const input = {
      fastest,
      selected,
      fastestPieces: pieces(4, [1, 2]),
      selectedPieces: pieces(4),
      wind: NORTH_WIND
    };

    it('names the windy street it avoids and the sheltered street it takes instead', () => {
      expect(explainWind(input)).toEqual({
        status: 'available',
        fastestExposure: 60,
        selectedExposure: 20,
        avoided: [{ street: 'Paseo de la Independencia', exposure: expect.any(Number) }],
        via: [{ street: 'Calle del Coso', exposure: 0 }]
      });
      expect(explainWind(input).avoided[0].exposure).toBeGreaterThan(30);
    });

    it('does not name streets shorter than the minimum or both routes share', () => {
      const short = route(
        [
          ['Paseo de la Independencia', EXPLANATION_CONFIG.minStreetLengthM - 1],
          ['Calle Alfonso I', 200]
        ],
        60
      );
      const result = explainWind({ ...input, fastest: short });
      expect(result.avoided).toEqual([]);
      expect(result.via.map((street) => street.street)).toEqual(['Calle del Coso']);
    });

    it('says nothing without a clear difference', () => {
      // The street left out is sheltered and the one taken faces the wind: nothing to explain.
      expect(
        explainWind({
          ...input,
          fastestPieces: pieces(4),
          selectedPieces: pieces(4, [1, 2, 3, 4])
        })
      ).toEqual({ status: 'unavailable', reason: 'no_relevant_streets' });
    });

    it.each([
      ['without wind', { wind: null }, 'no_wind_data'],
      ['with calm wind', { wind: { speedKmh: 0, directionDeg: 0 } }, 'calm'],
      [
        'without the exposure of a route',
        { fastest: { ...fastest, windExposure: { status: 'unavailable', exposure: null } } },
        'no_wind_data'
      ]
    ])('is unavailable %s', (_case, overrides, reason) => {
      expect(explainWind({ ...input, ...overrides })).toEqual({ status: 'unavailable', reason });
    });
  });

  describe('explainSunShade', () => {
    const fastest = route([
      ['Paseo de Sagasta', 300],
      ['Calle de Ávila', 150]
    ]);
    const selected = route([
      ['Calle del Doctor Horno Alcorta', 250],
      ['Calle de Ávila', 150]
    ]);
    const shades = (r, values) => new Map(r.steps.map((step, i) => [step, values[i]]));

    it('names the shaded streets of the chosen route and the sunny one it leaves out', () => {
      expect(
        explainSunShade({
          kind: 'shade',
          fastest,
          selected,
          fastestStepShade: shades(fastest, [20, 70]),
          selectedStepShade: shades(selected, [95, 70])
        })
      ).toEqual({
        status: 'available',
        kind: 'shade',
        streets: [{ street: 'Calle del Doctor Horno Alcorta', percentage: 95 }],
        instead: { street: 'Paseo de Sagasta', percentage: 20 }
      });
    });

    it('speaks of sun with «Sol» and uses shared streets if no own one is noticeable', () => {
      const result = explainSunShade({
        kind: 'sun',
        fastest,
        selected,
        fastestStepShade: shades(fastest, [50, 10]),
        selectedStepShade: shades(selected, [70, 10])
      });
      expect(result).toEqual({
        status: 'available',
        kind: 'sun',
        streets: [{ street: 'Calle de Ávila', percentage: 90 }],
        instead: null
      });
    });

    it('ignores steps whose shade could not be measured and says nothing without evidence', () => {
      expect(
        explainSunShade({
          kind: 'shade',
          fastest,
          selected,
          fastestStepShade: new Map(),
          selectedStepShade: new Map()
        })
      ).toEqual({ status: 'unavailable', reason: 'no_relevant_streets' });
    });
  });

  describe('explainParks', () => {
    it('names the largest parks once and counts the green areas without a name', () => {
      expect(
        explainParks([
          { name: 'Parque Grande José Antonio Labordeta', areaM2: 444260 },
          { name: null, areaM2: 900 },
          { name: 'Parque Pignatelli', areaM2: 30000 },
          { name: 'Parque Grande José Antonio Labordeta', areaM2: 200 },
          { name: null, areaM2: 300 }
        ])
      ).toEqual({
        status: 'available',
        named: ['Parque Grande José Antonio Labordeta', 'Parque Pignatelli'],
        moreNamedCount: 0,
        unnamedCount: 2
      });
    });

    it('names at most three and says how many more', () => {
      const areas = ['A', 'B', 'C', 'D', 'E'].map((name, i) => ({
        name: `Parque ${name}`,
        areaM2: 100 - i
      }));
      expect(explainParks(areas)).toMatchObject({
        named: ['Parque A', 'Parque B', 'Parque C'],
        moreNamedCount: 2
      });
    });

    it('is unavailable without green areas along the route or without data', () => {
      expect(explainParks([])).toEqual({ status: 'unavailable', reason: 'no_parks' });
      expect(explainParks(null)).toEqual({ status: 'unavailable', reason: 'no_green_data' });
    });
  });

  describe('suggestChange', () => {
    const preferences = (extraMinutes, sunShade = 'any') => ({ sunShade, extraMinutes });

    it.each([
      [
        'the minutes that let in the shortest better route',
        5,
        7 * 60 + 10,
        { kind: 'more_minutes', minutes: 10 }
      ],
      ['a whole number of minutes, rounded up', 2, 121, { kind: 'more_minutes', minutes: 5 }],
      ['nothing if not even 15 minutes are enough', 10, 16 * 60, { kind: 'too_long' }]
    ])('over the extra time: %s', (_case, extraMinutes, seconds, expected) => {
      expect(
        suggestChange({
          status: 'over_extra_time',
          preferences: preferences(extraMinutes),
          betterAlternativeExtraSeconds: seconds
        })
      ).toEqual(expected);
    });

    it.each([
      [2, { kind: 'more_minutes', minutes: 10 }],
      [10, { kind: 'more_minutes', minutes: 15 }],
      [15, { kind: 'other_preference' }]
    ])('without a better route and %s minutes: %j', (extraMinutes, expected) => {
      expect(
        suggestChange({ status: 'no_better_alternative', preferences: preferences(extraMinutes) })
      ).toEqual(expected);
    });

    it('suggests another hour without sun for shade, and leaving shade without its data', () => {
      expect(
        suggestChange({ status: 'sun_too_low', preferences: preferences(5, 'shade') })
      ).toEqual({ kind: 'other_time' });
      expect(
        suggestChange({ status: 'sun_below_horizon', preferences: preferences(5) })
      ).toBeNull();
      expect(
        suggestChange({ status: 'insufficient_exposure_data', preferences: preferences(5, 'sun') })
      ).toEqual({ kind: 'without_sun_shade' });
      expect(suggestChange({ status: 'selected', preferences: preferences(5) })).toBeNull();
    });
  });
});
