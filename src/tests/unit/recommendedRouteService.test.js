const { calculateRecommendedRoute } = require('../../services/routing/recommendedRouteService');

const points = {
  origin: { lat: 41.6488, lng: -0.8891 },
  destination: { lat: 41.656, lng: -0.878 }
};

const hotWeather = {
  temperature: 31,
  apparentTemperature: 32,
  windSpeed: 8,
  windGusts: 20,
  windDirection: 300,
  time: '2026-07-15T13:00',
  timeZone: 'Europe/Madrid',
  fetchedAt: '2026-07-15T11:00:05.000Z'
};

describe('recommended route service', () => {
  const weather = jest.fn();
  const weightedComparison = jest.fn();
  const solarCalculator = jest.fn();
  // 13:00 in Zaragoza (summer time).
  const now = () => new Date('2026-07-15T11:00:00Z');
  const dependencies = { weather, weightedComparison, solarCalculator, now };

  beforeEach(() => {
    jest.clearAllMocks();
    solarCalculator.mockReturnValue({ elevationDegrees: 69.84 });
    weather.mockResolvedValue(hotWeather);
    weightedComparison.mockResolvedValue({ status: 'selected', fastest: {}, selected: {} });
  });

  it('calculates a weighted route now, with the weights of the rule', async () => {
    const result = await calculateRecommendedRoute(points, dependencies);

    expect(solarCalculator).toHaveBeenCalledWith({
      date: '2026-07-15',
      time: '13:00',
      timeZone: 'Europe/Madrid',
      latitude: 41.6488,
      longitude: -0.8891
    });
    expect(weightedComparison).toHaveBeenCalledWith(
      {
        ...points,
        date: '2026-07-15',
        time: '13:00',
        timeZone: 'Europe/Madrid',
        weights: { shade: 50, sun: 0, wind: 0, vegetation: 0 },
        maxDetourPercentage: 25
      },
      expect.objectContaining({ solarCalculator })
    );
    expect(result).toMatchObject({
      status: 'selected',
      recommendation: {
        criterion: 'hot',
        weights: { shade: 50, sun: 0, wind: 0 },
        maxDetourPercentage: 25,
        weather: {
          temperature: 31,
          apparentTemperature: 32,
          windSpeed: 8,
          windGusts: 20,
          windDirection: 300,
          observedAt: '2026-07-15T13:00',
          timeZone: 'Europe/Madrid',
          source: 'open-meteo'
        },
        sun: { elevationDeg: 69.8 },
        calculatedAt: { date: '2026-07-15', time: '13:00', timeZone: 'Europe/Madrid' }
      }
    });
  });

  it('asks for the weather once and hands the same one to the weighted route', async () => {
    await calculateRecommendedRoute(points, dependencies);
    const { weather: handed } = weightedComparison.mock.calls[0][1];

    await expect(handed()).resolves.toBe(hotWeather);
    expect(weather).toHaveBeenCalledTimes(1);
  });

  it('recommends the fastest route without an error when Open-Meteo fails', async () => {
    const failure = Object.assign(new Error('Weather provider timed out.'), { status: 504 });
    weather.mockRejectedValue(failure);

    const result = await calculateRecommendedRoute(points, dependencies);

    expect(weightedComparison.mock.calls[0][0].weights).toEqual({
      shade: 0,
      sun: 0,
      wind: 0,
      vegetation: 0
    });
    expect(result.recommendation).toMatchObject({
      criterion: 'weather_unavailable',
      weather: null
    });
    // The weighted route sees the same failure, without asking Open-Meteo again.
    await expect(weightedComparison.mock.calls[0][1].weather()).rejects.toBe(failure);
    expect(weather).toHaveBeenCalledTimes(1);
  });

  it('sends null for the optional values the provider did not give', async () => {
    weather.mockResolvedValue({ ...hotWeather, apparentTemperature: undefined, windGusts: null });

    const result = await calculateRecommendedRoute(points, dependencies);

    expect(result.recommendation.weather).toMatchObject({
      apparentTemperature: null,
      windGusts: null
    });
    expect(result.recommendation.rules[0].variable).toBe('temperature');
  });

  it.each(['date', 'time', 'timeZone'])(
    'rejects a %s: the route is always for now',
    async (field) => {
      await expect(
        calculateRecommendedRoute({ ...points, [field]: 'x' }, dependencies)
      ).rejects.toMatchObject({
        status: 400,
        fields: { [field]: 'La ruta recomendada se calcula para ahora, con el tiempo actual.' }
      });
      expect(weather).not.toHaveBeenCalled();
    }
  );

  it('rejects points outside Zaragoza before asking for the weather', async () => {
    await expect(
      calculateRecommendedRoute(
        { ...points, destination: { lat: 40.4168, lng: -3.7038 } },
        dependencies
      )
    ).rejects.toMatchObject({ status: 400 });
    expect(weather).not.toHaveBeenCalled();
    expect(weightedComparison).not.toHaveBeenCalled();
  });

  it.each([
    [
      'throws',
      () => {
        throw new RangeError('date and time are ambiguous because of a daylight-saving transition');
      }
    ],
    ['returns no elevation', () => ({ elevationDegrees: undefined })]
  ])('treats the Sun as unavailable when the solar calculator %s', async (_case, calculator) => {
    solarCalculator.mockImplementation(calculator);
    weather.mockResolvedValue({ ...hotWeather, windSpeed: 40 });

    const result = await calculateRecommendedRoute(points, dependencies);

    // Only wind, and the same instant in UTC for the route (never ambiguous).
    expect(weightedComparison.mock.calls[0][0]).toMatchObject({
      date: '2026-07-15',
      time: '11:00',
      timeZone: 'UTC',
      weights: { shade: 0, sun: 0, wind: 50 }
    });
    expect(result.recommendation).toMatchObject({
      criterion: 'low_sun_windy',
      label: 'Sol no disponible y cierzo',
      sun: { elevationDeg: null },
      calculatedAt: { date: '2026-07-15', time: '11:00', timeZone: 'UTC' }
    });
  });

  it('propagates the errors of the route itself', async () => {
    weightedComparison.mockRejectedValue(Object.assign(new Error('ORS'), { status: 502 }));

    await expect(calculateRecommendedRoute(points, dependencies)).rejects.toMatchObject({
      status: 502
    });
  });
});
