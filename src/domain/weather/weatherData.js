// Optional values (PBI-9.1): without them the rest of the weather is still valid.
const optionalNumber = (value) => (Number.isFinite(value) ? value : null);

function normalizeCurrentWeather(payload) {
  const current = payload?.current;
  const units = payload?.current_units;
  const temperature = current?.temperature_2m;
  const windSpeed = current?.wind_speed_10m;
  const windDirection = current?.wind_direction_10m;
  const time = current?.time;

  if (
    !Number.isFinite(temperature) ||
    !Number.isFinite(windSpeed) ||
    !Number.isFinite(windDirection) ||
    windDirection < 0 ||
    windDirection > 360 ||
    typeof time !== 'string' ||
    !Number.isFinite(Date.parse(time))
  ) {
    throw Object.assign(new Error('Invalid weather provider response.'), { status: 502 });
  }

  return {
    temperature,
    temperatureUnit: units?.temperature_2m || '°C',
    apparentTemperature: optionalNumber(current.apparent_temperature),
    apparentTemperatureUnit: units?.apparent_temperature || '°C',
    windSpeed,
    windSpeedUnit: units?.wind_speed_10m || 'km/h',
    windGusts: optionalNumber(current.wind_gusts_10m),
    windGustsUnit: units?.wind_gusts_10m || 'km/h',
    windDirection,
    windDirectionUnit: units?.wind_direction_10m || '°',
    weatherCode: optionalNumber(current.weather_code),
    time,
    timeZone: payload.timezone || 'Europe/Madrid'
  };
}

module.exports = { normalizeCurrentWeather };
