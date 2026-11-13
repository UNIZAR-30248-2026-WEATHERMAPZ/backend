const request = require('supertest');

jest.mock('../api/middleware/requireAuth', () => ({
  requireAuth: (_req, _res, next) => next()
}));

const { createApp } = require('../app');
const { clearWeatherCache } = require('../services/weather/weatherService');

describe('GET /api/weather/current', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    clearWeatherCache();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns normalized current weather for Zaragoza and caches provider data', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        timezone: 'Europe/Madrid',
        current: {
          temperature_2m: 18.5,
          wind_speed_10m: 7.2,
          wind_direction_10m: 240,
          weather_code: 3,
          time: '2026-11-02T15:00'
        },
        current_units: {
          temperature_2m: '°C',
          wind_speed_10m: 'km/h',
          wind_direction_10m: '°'
        }
      })
    });

    const first = await request(createApp()).get('/api/weather/current');
    const second = await request(createApp()).get('/api/weather/current');

    expect(first.status).toBe(200);
    expect(first.body.weather).toMatchObject({
      temperature: 18.5,
      windSpeed: 7.2,
      windDirection: 240,
      weatherCode: 3,
      apparentTemperature: null,
      windGusts: null,
      timeZone: 'Europe/Madrid'
    });
    expect(second.body).toEqual(first.body);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const url = new URL(global.fetch.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe('https://api.open-meteo.com/v1/forecast');
    expect(url.searchParams.get('current')).toBe(
      'temperature_2m,apparent_temperature,wind_speed_10m,wind_gusts_10m,wind_direction_10m,weather_code'
    );
    expect(url.searchParams.get('timezone')).toBe('Europe/Madrid');
  });

  it('returns a controlled provider error and does not cache it', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });

    const response = await request(createApp()).get('/api/weather/current');

    expect(response.status).toBe(502);
    expect(response.body.error.message).toMatch(/weather provider/i);
  });
});
