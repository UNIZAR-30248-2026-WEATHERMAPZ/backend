const {
  answersOf,
  hasPreference,
  parsePreferences,
  weightsFromAnswers
} = require('../../domain/routes/routePreferences');
const { explainComparison } = require('./routeExplanationService');
const { calculateWeightedRouteComparison } = require('./weightedRouteService');

/**
 * The route of the user's answers (PBI-18, ADR-036): the answers become weights and the route is
 * calculated with the weighted comparison of PBI-6, which does not change. With every answer
 * indifferent the weights are 0 and only the fastest route is calculated (`fastest_only`).
 *
 * Since PBI-19 (ADR-038) it also says why, in streets, parks and minutes (`explanation`), reusing
 * what the comparison measured.
 */
async function calculatePreferredRoute(
  input,
  {
    weightedComparison = calculateWeightedRouteComparison,
    explain = explainComparison,
    ...dependencies
  } = {}
) {
  const preferences = parsePreferences(input?.preferences);
  const evidence = {};
  const comparison = await weightedComparison(
    {
      origin: input.origin,
      destination: input.destination,
      date: input.date,
      time: input.time,
      timeZone: input.timeZone,
      wind: input.wind,
      weights: weightsFromAnswers(preferences),
      extraMinutes: preferences.extraMinutes
    },
    { ...dependencies, evidence }
  );
  const explanation =
    comparison.status === 'fastest_only' ? null : await explain(comparison, preferences, evidence);
  return {
    ...comparison,
    preferences: { ...preferences, hasPreference: hasPreference(answersOf(preferences)) },
    explanation
  };
}

module.exports = { calculatePreferredRoute };
