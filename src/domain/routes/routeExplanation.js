const { directionalAlignment } = require('../wind/routeWindExposure');
const { windIntensity } = require('../wind/windExposure');
const { EXTRA_MINUTES_OPTIONS } = require('./routePreferences');

/*
 * Why the route of the answers suits them better than the fastest one, in streets, parks and minutes
 * (PBI-19, ADR-038). Pure: it only reads what the route calculation already measured (the ORS steps
 * with their street names, the wind of each piece and the shade of each street segment) and never
 * makes up a street: steps without a name are left out. The thresholds are provisional (ADR-038).
 */
const EXPLANATION_CONFIG = Object.freeze({
  // A street must be walked at least this long to be named: shorter stretches are crossings.
  minStreetLengthM: 80,
  // A street is mentioned for the wind if its exposure differs this much from the other route.
  windMarginPoints: 10,
  // A street counts as «a la sombra» (or «al sol») from this percentage of its length.
  sunShadeMinPercentage: 60,
  // And as the opposite one up to this percentage.
  sunShadeMaxOppositePercentage: 40,
  maxStreets: 2,
  maxParks: 3
});

const round = (value) => Math.round(value);

// Length-weighted mean of value() over items with a lengthM.
function weightedMean(items, value) {
  const total = items.reduce((sum, item) => sum + item.lengthM, 0);
  if (total <= 0) return null;
  return items.reduce((sum, item) => sum + item.lengthM * value(item), 0) / total;
}

/*
 * The named streets of a route in the order they are walked, each with its walked length and the
 * pieces (from routePieces, with their coordinate `index`) of its steps. A street walked in several
 * steps is one entry.
 */
function routeStreets(route, pieces = []) {
  const streets = new Map();
  (route?.steps ?? []).forEach((step) => {
    if (!step?.name) return;
    const [start, end] = step.wayPoints ?? [];
    const stepPieces = pieces.filter((piece) => piece.index > start && piece.index <= end);
    const street = streets.get(step.name) ?? { name: step.name, lengthM: 0, steps: [], pieces: [] };
    street.lengthM += step.distance;
    street.steps.push(step);
    street.pieces.push(...stepPieces);
    streets.set(step.name, street);
  });
  return [...streets.values()];
}

/** Wind exposure (0-100) of each piece, as the route exposure of PBI-8.2 and PBI-8.3 does. */
function pieceWindExposure(piece, { speedKmh, directionDeg }) {
  return (
    100 *
    directionalAlignment(piece.bearingDeg, directionDeg, piece.openness) *
    windIntensity(speedKmh)
  );
}

function streetsWithWind(route, pieces, wind) {
  return routeStreets(route, pieces)
    .filter((street) => street.pieces.length)
    .map((street) => ({
      name: street.name,
      lengthM: street.lengthM,
      exposure: weightedMean(street.pieces, (piece) => pieceWindExposure(piece, wind))
    }));
}

/*
 * «Evitar el viento»: the streets of the fastest route the chosen one leaves out because the wind
 * blows harder there, and the streets it takes instead, more sheltered. Only streets walked at least
 * minStreetLengthM and with a clear difference count; without any, there is nothing verifiable to say.
 */
function explainWind(
  { fastest, selected, fastestPieces, selectedPieces, wind },
  config = EXPLANATION_CONFIG
) {
  if (!wind) return { status: 'unavailable', reason: 'no_wind_data' };
  if (windIntensity(wind.speedKmh) <= 0) return { status: 'unavailable', reason: 'calm' };
  const fastestExposure = fastest?.windExposure?.exposure;
  const selectedExposure = selected?.windExposure?.exposure;
  if (!Number.isFinite(fastestExposure) || !Number.isFinite(selectedExposure)) {
    return { status: 'unavailable', reason: 'no_wind_data' };
  }
  const fastestStreets = streetsWithWind(fastest, fastestPieces, wind);
  const selectedStreets = streetsWithWind(selected, selectedPieces, wind);
  const fastestNames = new Set(fastestStreets.map((street) => street.name));
  const selectedNames = new Set(selectedStreets.map((street) => street.name));
  const long = (street) => street.lengthM >= config.minStreetLengthM;
  const avoided = fastestStreets
    .filter((street) => long(street) && !selectedNames.has(street.name))
    .filter((street) => street.exposure >= selectedExposure + config.windMarginPoints)
    .sort((a, b) => b.exposure * b.lengthM - a.exposure * a.lengthM)
    .slice(0, config.maxStreets);
  const via = selectedStreets
    .filter((street) => long(street) && !fastestNames.has(street.name))
    .filter((street) => street.exposure <= fastestExposure - config.windMarginPoints)
    .sort((a, b) => b.lengthM - a.lengthM)
    .slice(0, config.maxStreets);
  if (!avoided.length && !via.length)
    return { status: 'unavailable', reason: 'no_relevant_streets' };
  const summary = (street) => ({ street: street.name, exposure: round(street.exposure) });
  return {
    status: 'available',
    fastestExposure: round(fastestExposure),
    selectedExposure: round(selectedExposure),
    avoided: avoided.map(summary),
    via: via.map(summary)
  };
}

/*
 * The shade of each named street, length-weighted over its steps whose shade could be measured
 * (stepShade: the shade percentage of each step, or null).
 */
function streetsWithShade(route, stepShade) {
  return routeStreets(route)
    .map((street) => {
      const measured = street.steps
        .map((step) => ({ lengthM: step.distance, shade: stepShade.get(step) }))
        .filter((item) => Number.isFinite(item.shade) && item.lengthM > 0);
      return {
        name: street.name,
        lengthM: street.lengthM,
        shadePercentage: measured.length ? weightedMean(measured, (item) => item.shade) : null
      };
    })
    .filter((street) => Number.isFinite(street.shadePercentage));
}

/*
 * «Sombra» or «Sol»: the streets of the chosen route where it is most noticeable (preferably the
 * ones the fastest route does not take) and, for contrast, the street of the fastest route it leaves
 * out that has the opposite.
 */
function explainSunShade(
  { kind, fastest, selected, fastestStepShade, selectedStepShade },
  config = EXPLANATION_CONFIG
) {
  if (!['shade', 'sun'].includes(kind)) return { status: 'unavailable', reason: 'not_requested' };
  const percentage = (street) =>
    kind === 'shade' ? street.shadePercentage : 100 - street.shadePercentage;
  const selectedStreets = streetsWithShade(selected, selectedStepShade);
  const fastestStreets = streetsWithShade(fastest, fastestStepShade);
  const fastestNames = new Set(routeStreets(fastest).map((street) => street.name));
  const selectedNames = new Set(routeStreets(selected).map((street) => street.name));
  const long = (street) => street.lengthM >= config.minStreetLengthM;
  const noticeable = selectedStreets.filter(
    (street) => long(street) && percentage(street) >= config.sunShadeMinPercentage
  );
  const own = noticeable.filter((street) => !fastestNames.has(street.name));
  const streets = (own.length ? own : noticeable)
    .sort((a, b) => b.lengthM - a.lengthM)
    .slice(0, config.maxStreets);
  if (!streets.length) return { status: 'unavailable', reason: 'no_relevant_streets' };
  const instead = fastestStreets
    .filter(
      (street) =>
        long(street) &&
        !selectedNames.has(street.name) &&
        percentage(street) <= config.sunShadeMaxOppositePercentage
    )
    .sort((a, b) => b.lengthM - a.lengthM)[0];
  const summary = (street) => ({ street: street.name, percentage: round(percentage(street)) });
  return {
    status: 'available',
    kind,
    streets: streets.map(summary),
    instead: instead ? summary(instead) : null
  };
}

/** «Por parques»: the named parks along the route (largest first) and how many green areas without a name. */
function explainParks(areas, config = EXPLANATION_CONFIG) {
  if (!Array.isArray(areas)) return { status: 'unavailable', reason: 'no_green_data' };
  const named = [
    ...new Map(
      areas
        .filter((area) => area.name)
        .sort((a, b) => b.areaM2 - a.areaM2)
        .map((area) => [area.name, area.name])
    ).values()
  ];
  const unnamedCount = areas.filter((area) => !area.name).length;
  if (!named.length && !unnamedCount) return { status: 'unavailable', reason: 'no_parks' };
  return {
    status: 'available',
    named: named.slice(0, config.maxParks),
    moreNamedCount: Math.max(0, named.length - config.maxParks),
    unnamedCount
  };
}

const nextMinutes = (current, atLeast = 0) =>
  EXTRA_MINUTES_OPTIONS.find((minutes) => minutes > current && minutes >= atLeast) ?? null;

/*
 * A concrete change to try when there is no better route: more minutes (the one that would let in
 * the shortest better route, or the next ones, with which ORS proposes longer alternatives), another
 * hour for shade or sun, or another preference.
 */
function suggestChange({ status, preferences, betterAlternativeExtraSeconds = null }) {
  const extraMinutes = preferences?.extraMinutes ?? 0;
  const asksSunShade = preferences?.sunShade && preferences.sunShade !== 'any';
  if (status === 'over_extra_time') {
    const needed = Number.isFinite(betterAlternativeExtraSeconds)
      ? Math.ceil(betterAlternativeExtraSeconds / 60)
      : 0;
    const minutes = nextMinutes(extraMinutes, needed);
    return minutes ? { kind: 'more_minutes', minutes } : { kind: 'too_long' };
  }
  if (status === 'no_better_alternative') {
    // With 10 and 15 minutes ORS is asked for longer alternatives (ADR-036).
    const minutes = nextMinutes(extraMinutes, 10);
    return minutes ? { kind: 'more_minutes', minutes } : { kind: 'other_preference' };
  }
  if (status === 'sun_below_horizon' || status === 'sun_too_low') {
    return asksSunShade ? { kind: 'other_time' } : null;
  }
  if (status === 'insufficient_exposure_data') {
    return asksSunShade ? { kind: 'without_sun_shade' } : { kind: 'other_preference' };
  }
  return null;
}

module.exports = {
  EXPLANATION_CONFIG,
  explainParks,
  explainSunShade,
  explainWind,
  pieceWindExposure,
  routeStreets,
  suggestChange
};
