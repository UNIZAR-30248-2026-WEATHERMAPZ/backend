const { calculatePreferredRoute } = require('../../services/routing/preferredRouteService');

const points = {
  origin: { lat: 41.6488, lng: -0.8891 },
  destination: { lat: 41.656, lng: -0.878 },
  date: '2026-06-21',
  time: '14:00',
  timeZone: 'Europe/Madrid'
};

const answers = (overrides = {}) => ({
  sunShade: 'any',
  avoidWind: false,
  preferParks: false,
  extraMinutes: 5,
  ...overrides
});

describe('preferred route service (PBI-18, ADR-036)', () => {
  const weightedComparison = jest.fn();
  const explain = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    weightedComparison.mockResolvedValue({ status: 'selected' });
    explain.mockResolvedValue({ status: 'selected', time: { extraSeconds: 60 } });
  });

  it('turns the answers into the weights of the weighted route and passes the minutes', async () => {
    const result = await calculatePreferredRoute(
      { ...points, preferences: answers({ sunShade: 'shade', avoidWind: true, extraMinutes: 10 }) },
      { weightedComparison, explain }
    );

    expect(weightedComparison).toHaveBeenCalledWith(
      {
        ...points,
        wind: undefined,
        weights: { shade: 50, sun: 0, wind: 50, vegetation: 0 },
        extraMinutes: 10
      },
      { evidence: {} }
    );
    expect(result).toEqual({
      status: 'selected',
      preferences: {
        ...answers({ sunShade: 'shade', avoidWind: true, extraMinutes: 10 }),
        hasPreference: true
      },
      explanation: { status: 'selected', time: { extraSeconds: 60 } }
    });
  });

  it('explains the comparison with the evidence the weighted comparison filled (PBI-19)', async () => {
    weightedComparison.mockImplementation(async (_input, { evidence }) => {
      Object.assign(evidence, { wind: { speedKmh: 40, directionDeg: 300 } });
      return { status: 'selected' };
    });
    await calculatePreferredRoute(
      { ...points, preferences: answers({ avoidWind: true }) },
      { weightedComparison, explain }
    );
    expect(explain).toHaveBeenCalledWith({ status: 'selected' }, answers({ avoidWind: true }), {
      wind: { speedKmh: 40, directionDeg: 300 }
    });
  });

  it('with everything indifferent asks for weights at 0 (the fastest route), without explanation', async () => {
    weightedComparison.mockResolvedValue({ status: 'fastest_only' });
    const result = await calculatePreferredRoute(
      { ...points, preferences: answers() },
      { weightedComparison, explain }
    );
    expect(result.explanation).toBeNull();
    expect(explain).not.toHaveBeenCalled();

    expect(weightedComparison.mock.calls[0][0].weights).toEqual({
      shade: 0,
      sun: 0,
      wind: 0,
      vegetation: 0
    });
    expect(result.preferences.hasPreference).toBe(false);
  });

  it('rejects invalid preferences before calculating anything', async () => {
    await expect(
      calculatePreferredRoute(
        { ...points, preferences: { sunShade: 'shade', extraMinutes: 5 } },
        { weightedComparison }
      )
    ).rejects.toMatchObject({ status: 400 });
    await expect(calculatePreferredRoute(points, { weightedComparison })).rejects.toMatchObject({
      status: 400,
      fields: { preferences: expect.any(String) }
    });
    expect(weightedComparison).not.toHaveBeenCalled();
  });
});
