const request = require('supertest');

// The whole chain is real (rule, weighted route, shade and wind exposure); only the outside world is
// simulated: Open-Meteo through fetch, OpenRouteService and the PostGIS queries (also the openness of
// the streets of PBI-8.3).
jest.mock('../api/middleware/requireAuth', () => ({
  requireAuth: (_req, _res, next) => next()
}));
jest.mock('../integrations/openRouteService/directionsClient', () => ({
  getAlternativeWalkingRoutes: jest.fn(),
  getFastestWalkingRoute: jest.fn()
}));
jest.mock('../repositories/routeSegmentRepository', () => ({ findSegmentsForRoutes: jest.fn() }));
jest.mock('../services/shadow/exposureService', () => ({ calculateSegmentExposures: jest.fn() }));
jest.mock('../repositories/opennessRepository', () => ({ findOpennessNearPoints: jest.fn() }));
jest.mock('../repositories/vegetationRepository', () => ({ findGreenRatios: jest.fn() }));

const { createApp } = require('../app');
const {
  getAlternativeWalkingRoutes,
  getFastestWalkingRoute
} = require('../integrations/openRouteService/directionsClient');
const { findOpennessNearPoints } = require('../repositories/opennessRepository');
const { findSegmentsForRoutes } = require('../repositories/routeSegmentRepository');
const { findGreenRatios } = require('../repositories/vegetationRepository');
const { calculateSegmentExposures } = require('../services/shadow/exposureService');
const { clearWeatherCache } = require('../services/weather/weatherService');

const body = {
  origin: { lat: 41.65, lng: -0.87 },
  destination: { lat: 41.65, lng: -0.882 }
};

// Fastest: 1000 m straight to the west, sunny. Alternative: 300 m north, 1000 m west and 300 m
// south, shaded and with the first and last pieces across a west wind.
const FASTEST = {
  geometry: {
    type: 'LineString',
    coordinates: [
      [-0.87, 41.65],
      [-0.882, 41.65]
    ]
  },
  distance: 1000,
  duration: 600
};
const ALTERNATIVE = {
  geometry: {
    type: 'LineString',
    coordinates: [
      [-0.87, 41.65],
      [-0.87, 41.6527],
      [-0.882, 41.6527],
      [-0.882, 41.65]
    ]
  },
  distance: 1600,
  duration: 640
};

// Summer midday, winter midday and a November night in Zaragoza.
const SUMMER_NOON = '2026-07-15T11:00:00Z';
const WINTER_NOON = '2026-01-15T12:00:00Z';
const NIGHT = '2026-11-12T22:00:00Z';

function openMeteo(current) {
  return {
    ok: true,
    json: async () => ({
      timezone: 'Europe/Madrid',
      current: {
        time: '2026-07-15T13:00',
        temperature_2m: 18,
        apparent_temperature: 18,
        wind_speed_10m: 5,
        wind_gusts_10m: 10,
        wind_direction_10m: 270,
        ...current
      }
    })
  };
}

function setNow(isoInstant) {
  // Only the clock is fake: the timers of supertest and the weather client stay real.
  jest.useFakeTimers({
    now: new Date(isoInstant),
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout'
    ]
  });
}

const postRecommended = (payload = body) =>
  request(createApp()).post('/api/routes/recommended').send(payload);

describe('POST /api/routes/recommended', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    clearWeatherCache();
    getFastestWalkingRoute.mockResolvedValue(FASTEST);
    getAlternativeWalkingRoutes.mockResolvedValue([FASTEST, ALTERNATIVE]);
    // Every piece in a canyon (openness 0, ADR-028): only the wind along the street counts, so the
    // controlled wind cases do not depend on the buildings.
    findOpennessNearPoints.mockImplementation(async (points) => points.map(() => 0));
    // No green on either route: the recommendation does not weigh vegetation (ADR-029).
    findGreenRatios.mockResolvedValue(new Map());
    findSegmentsForRoutes.mockResolvedValue([
      { routeIndex: 0, segmentId: 1, overlapLengthM: 1000 },
      { routeIndex: 1, segmentId: 2, overlapLengthM: 1600 }
    ]);
    calculateSegmentExposures.mockImplementation(async ({ date, time, timeZone }) => ({
      status: 'calculated',
      reference: { localDateTime: `${date}T${time}`, timeZone },
      segments: [
        { segmentId: 1, status: 'available', shadeRatio: 0.1 },
        { segmentId: 2, status: 'available', shadeRatio: 0.8 }
      ]
    }));
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
  });

  it('heat: chooses the shaded alternative and explains why', async () => {
    setNow(SUMMER_NOON);
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        openMeteo({ temperature_2m: 33, apparent_temperature: 34, wind_speed_10m: 8 })
      );

    const response = await postRecommended();

    expect(response.status).toBe(200);
    const { comparison } = response.body;
    expect(comparison).toMatchObject({
      status: 'selected',
      weights: { shade: 50, sun: 0, wind: 0 },
      fastest: { distance: 1000 },
      selected: { distance: 1600, exposure: { shadePercentage: 80 } },
      recommendation: {
        criterion: 'hot',
        label: 'Calor',
        weights: { shade: 50, sun: 0, wind: 0 },
        maxDetourPercentage: 25,
        reason:
          'Hace calor (sensación de 34 °C): se busca sombra aceptando hasta un 25 % más de tiempo.',
        weather: {
          temperature: 33,
          apparentTemperature: 34,
          windSpeed: 8,
          windGusts: 10,
          windDirection: 270,
          observedAt: '2026-07-15T13:00',
          source: 'open-meteo'
        },
        calculatedAt: { date: '2026-07-15', time: '13:00', timeZone: 'Europe/Madrid' }
      }
    });
    expect(comparison.recommendation.rules).toContainEqual({
      variable: 'apparentTemperature',
      operator: '>=',
      threshold: 26,
      value: 34,
      unit: '°C'
    });
    expect(comparison.recommendation.sun.elevationDeg).toBeGreaterThan(60);
    // Shadows for the current instant, and the weather asked for only once.
    expect(calculateSegmentExposures).toHaveBeenCalledWith(
      expect.objectContaining({ date: '2026-07-15', time: '13:00' })
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('cold: seeks sun, so the sunny fastest route stays', async () => {
    setNow(WINTER_NOON);
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        openMeteo({ time: '2026-01-15T13:00', temperature_2m: 6, apparent_temperature: 3 })
      );

    const { body: result } = await postRecommended();

    expect(result.comparison).toMatchObject({
      status: 'no_better_alternative',
      weights: { shade: 0, sun: 50, wind: 0 },
      selected: null,
      recommendation: { criterion: 'cold', weights: { shade: 0, sun: 50, wind: 0 } }
    });
  });

  it('strong wind: avoids the headwind without calculating shadows', async () => {
    setNow(SUMMER_NOON);
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        openMeteo({ wind_speed_10m: 40, wind_gusts_10m: 60, wind_direction_10m: 270 })
      );

    const { body: result } = await postRecommended();

    expect(result.comparison).toMatchObject({
      status: 'selected',
      weights: { shade: 0, sun: 0, wind: 50 },
      wind: { speedKmh: 40, directionDeg: 270, source: 'open-meteo' },
      selected: { distance: 1600 },
      recommendation: { criterion: 'windy', label: 'Cierzo' }
    });
    expect(result.comparison.windChangePoints).toBeLessThan(-5);
    expect(calculateSegmentExposures).not.toHaveBeenCalled();
    // The wind exposure of the routes uses the openness of the streets (PBI-8.3), in one query.
    expect(findOpennessNearPoints).toHaveBeenCalledTimes(1);
  });

  it('heat and cierzo: shade and wind weigh together', async () => {
    setNow(SUMMER_NOON);
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        openMeteo({ apparent_temperature: 30, wind_speed_10m: 35, wind_direction_10m: 300 })
      );

    const { body: result } = await postRecommended();

    expect(result.comparison).toMatchObject({
      status: 'selected',
      weights: { shade: 50, sun: 0, wind: 50 },
      recommendation: { criterion: 'hot_windy', label: 'Calor y cierzo' }
    });
  });

  it('mild: only the fastest route is asked for', async () => {
    setNow(SUMMER_NOON);
    global.fetch = jest.fn().mockResolvedValue(openMeteo({ apparent_temperature: 17 }));

    const { body: result } = await postRecommended();

    expect(result.comparison).toMatchObject({
      status: 'fastest_only',
      weights: { shade: 0, sun: 0, wind: 0 },
      selected: null,
      recommendation: { criterion: 'mild', label: 'Tiempo templado' }
    });
    expect(getFastestWalkingRoute).toHaveBeenCalledTimes(1);
    expect(getAlternativeWalkingRoutes).not.toHaveBeenCalled();
  });

  it('night: neither shade nor sun, even when it is hot', async () => {
    setNow(NIGHT);
    global.fetch = jest
      .fn()
      .mockResolvedValue(openMeteo({ time: '2026-11-12T23:00', apparent_temperature: 28 }));

    const { body: result } = await postRecommended();

    expect(result.comparison).toMatchObject({
      status: 'fastest_only',
      recommendation: { criterion: 'low_sun', label: 'Noche', weights: { shade: 0, sun: 0 } }
    });
    expect(result.comparison.recommendation.sun.elevationDeg).toBeLessThan(0);
  });

  it('night with cierzo: a wind-only route, which works at night', async () => {
    setNow(NIGHT);
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        openMeteo({ time: '2026-11-12T23:00', apparent_temperature: 2, wind_speed_10m: 40 })
      );

    const { body: result } = await postRecommended();

    expect(result.comparison).toMatchObject({
      status: 'selected',
      weights: { shade: 0, sun: 0, wind: 50 },
      recommendation: { criterion: 'low_sun_windy' }
    });
  });

  describe('the repeated hour when the clocks go back (2026-10-25, 02:30 the first time)', () => {
    const REPEATED_HOUR = '2026-10-25T00:30:00Z';

    it('does not fail: without wind, the fastest route', async () => {
      setNow(REPEATED_HOUR);
      global.fetch = jest
        .fn()
        .mockResolvedValue(openMeteo({ time: '2026-10-25T02:30', apparent_temperature: 12 }));

      const response = await postRecommended();

      expect(response.status).toBe(200);
      expect(response.body.comparison).toMatchObject({
        status: 'fastest_only',
        recommendation: {
          criterion: 'low_sun',
          label: 'Sol no disponible',
          sun: { elevationDeg: null },
          calculatedAt: { date: '2026-10-25', time: '00:30', timeZone: 'UTC' }
        }
      });
      expect(response.body.comparison.recommendation.reason).toMatch(
        /^No se ha podido calcular la posición del Sol/
      );
    });

    it('does not fail: with cierzo, a wind-only route calculated in UTC', async () => {
      setNow(REPEATED_HOUR);
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          openMeteo({ time: '2026-10-25T02:30', apparent_temperature: 5, wind_speed_10m: 40 })
        );

      const response = await postRecommended();

      expect(response.status).toBe(200);
      expect(response.body.comparison).toMatchObject({
        status: 'selected',
        weights: { shade: 0, sun: 0, wind: 50 },
        selected: { distance: 1600 },
        recommendation: { criterion: 'low_sun_windy' }
      });
      expect(calculateSegmentExposures).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['is unavailable', () => Promise.resolve({ ok: false, status: 503 })],
    ['does not answer', () => Promise.reject(new TypeError('fetch failed'))],
    ['sends incomplete data', () => Promise.resolve(openMeteo({ temperature_2m: null }))]
  ])(
    'Open-Meteo %s: the fastest route, with 200 and a clear reason',
    async (_case, fetchResult) => {
      setNow(SUMMER_NOON);
      global.fetch = jest.fn().mockImplementation(fetchResult);

      const response = await postRecommended();

      expect(response.status).toBe(200);
      expect(response.body.comparison).toMatchObject({
        status: 'fastest_only',
        wind: null,
        fastest: { distance: 1000 },
        recommendation: {
          criterion: 'weather_unavailable',
          weather: null,
          reason:
            'No se ha podido consultar el tiempo actual: la ruta recomendada es la más rápida.'
        }
      });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    }
  );

  it('reuses the cached weather (PBI-7) on the next request', async () => {
    setNow(SUMMER_NOON);
    global.fetch = jest.fn().mockResolvedValue(openMeteo({ apparent_temperature: 30 }));

    await postRecommended();
    await postRecommended();

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a date or time with 400', async () => {
    global.fetch = jest.fn();

    const response = await postRecommended({ ...body, date: '2026-07-15', time: '13:00' });

    expect(response.status).toBe(400);
    expect(response.body.error.fields).toEqual({
      date: 'La ruta recomendada se calcula para ahora, con el tiempo actual.',
      time: 'La ruta recomendada se calcula para ahora, con el tiempo actual.'
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects points outside Zaragoza with 400 without calling the providers', async () => {
    global.fetch = jest.fn();

    const response = await postRecommended({ ...body, origin: { lat: 40.4168, lng: -3.7038 } });

    expect(response.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(getFastestWalkingRoute).not.toHaveBeenCalled();
  });

  it('keeps the controlled errors of OpenRouteService', async () => {
    setNow(SUMMER_NOON);
    global.fetch = jest.fn().mockResolvedValue(openMeteo({ apparent_temperature: 17 }));
    getFastestWalkingRoute.mockRejectedValue(
      Object.assign(new Error('Routing provider is busy.'), { status: 429 })
    );

    const response = await postRecommended();

    expect(response.status).toBe(429);
  });
});
