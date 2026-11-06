const { httpError } = require('../../utils/httpError');

// Each weight is a percentage: how much the user cares about that factor (ADR-023). Wind came with
// PBI-8.2 (ADR-025); vegetation will be added here as a new factor.
const WEIGHT_FACTORS = ['shade', 'sun', 'wind'];
const MAX_WEIGHT = 100;
const MAX_PROFILE_NAME_LENGTH = 40;
// How much longer than the fastest route the chosen one may be (ADR-023). 40 % is the default
// detour of ORS alternatives; asking it for more has not been checked.
const DEFAULT_MAX_DETOUR_PERCENTAGE = 25;
const MAX_DETOUR_PERCENTAGE = 40;

// Every user starts with a copy of these; "Sombreada" keeps the cost of ADR-014.
const PRESET_PROFILES = [
  { presetKey: 'fastest', name: 'Rápida', weights: { shade: 0, sun: 0, wind: 0 } },
  { presetKey: 'shaded', name: 'Sombreada', weights: { shade: 50, sun: 0, wind: 0 } },
  { presetKey: 'sunny', name: 'Soleada', weights: { shade: 0, sun: 50, wind: 0 } }
].map((preset) => ({ ...preset, maxDetourPercentage: DEFAULT_MAX_DETOUR_PERCENTAGE }));

function hasEnvironmentalWeight(weights) {
  return WEIGHT_FACTORS.some((factor) => weights[factor] > 0);
}

// Shadows are only needed when shade or sun weigh: a wind-only route also works at night.
function hasShadeWeight(weights) {
  return weights.shade > 0 || weights.sun > 0;
}

function parseWeights(weights) {
  if (weights === null || typeof weights !== 'object' || Array.isArray(weights)) {
    throw httpError(400, 'Los pesos no son válidos.', { weights: 'Indica los pesos de la ruta.' });
  }
  const fields = {};
  const parsed = {};
  WEIGHT_FACTORS.forEach((factor) => {
    const value = weights[factor] ?? 0;
    if (!Number.isInteger(value) || value < 0 || value > MAX_WEIGHT) {
      fields[factor] = `Debe ser un número entero entre 0 y ${MAX_WEIGHT}.`;
    } else {
      parsed[factor] = value;
    }
  });
  if (Object.keys(fields).length) throw httpError(400, 'Los pesos no son válidos.', fields);
  return parsed;
}

function parseMaxDetour(value = DEFAULT_MAX_DETOUR_PERCENTAGE) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_DETOUR_PERCENTAGE) {
    throw httpError(400, 'El tiempo extra no es válido.', {
      maxDetourPercentage: `Debe ser un número entero entre 0 y ${MAX_DETOUR_PERCENTAGE}.`
    });
  }
  return value;
}

function parseProfileInput(input) {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > MAX_PROFILE_NAME_LENGTH) {
    throw httpError(400, 'El nombre no es válido.', {
      name: `Escribe un nombre de 1 a ${MAX_PROFILE_NAME_LENGTH} caracteres.`
    });
  }
  return {
    name,
    weights: parseWeights(input.weights),
    maxDetourPercentage: parseMaxDetour(input.maxDetourPercentage)
  };
}

module.exports = {
  DEFAULT_MAX_DETOUR_PERCENTAGE,
  MAX_DETOUR_PERCENTAGE,
  MAX_PROFILE_NAME_LENGTH,
  MAX_WEIGHT,
  PRESET_PROFILES,
  WEIGHT_FACTORS,
  hasEnvironmentalWeight,
  hasShadeWeight,
  parseMaxDetour,
  parseProfileInput,
  parseWeights
};
