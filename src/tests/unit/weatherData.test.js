const { normalizeCurrentWeather } = require('../../domain/weather/weatherData');

describe('normalizeCurrentWeather', () => {
  it('normalizes current Zaragoza weather and units', () => {
    expect(
      normalizeCurrentWeather({
        timezone: 'Europe/Madrid',
        current: {
          temperature_2m: 21.4,
          wind_speed_10m: 12.2,
          wind_direction_10m: 275,
          weather_code: 3,
          time: '2026-11-02T15:00'
        },
        current_units: {
          temperature_2m: '°C',
          wind_speed_10m: 'km/h',
          wind_direction_10m: '°'
        }
      })
    ).toEqual({
      temperature: 21.4,
      temperatureUnit: '°C',
      apparentTemperature: null,
      apparentTemperatureUnit: '°C',
      windSpeed: 12.2,
      windSpeedUnit: 'km/h',
      windGusts: null,
      windGustsUnit: 'km/h',
      windDirection: 275,
      windDirectionUnit: '°',
      weatherCode: 3,
      time: '2026-11-02T15:00',
      timeZone: 'Europe/Madrid'
    });
  });

  it('includes the apparent temperature and the gusts when the provider sends them', () => {
    expect(
      normalizeCurrentWeather({
        current: {
          temperature_2m: 8,
          apparent_temperature: 3.4,
          wind_speed_10m: 35,
          wind_gusts_10m: 62.6,
          wind_direction_10m: 300,
          time: '2026-01-15T13:00'
        },
        current_units: { apparent_temperature: '°C', wind_gusts_10m: 'km/h' }
      })
    ).toMatchObject({ temperature: 8, apparentTemperature: 3.4, windSpeed: 35, windGusts: 62.6 });
  });

  it('keeps the weather valid when the optional values are not numbers', () => {
    expect(
      normalizeCurrentWeather({
        current: {
          temperature_2m: 8,
          apparent_temperature: null,
          wind_speed_10m: 35,
          wind_gusts_10m: 'n/a',
          wind_direction_10m: 300,
          time: '2026-01-15T13:00'
        }
      })
    ).toMatchObject({ temperature: 8, apparentTemperature: null, windGusts: null });
  });

  it('rejects missing or invalid weather values', () => {
    expect(() => normalizeCurrentWeather({ current: {} })).toThrow(
      'Invalid weather provider response.'
    );
  });
});
