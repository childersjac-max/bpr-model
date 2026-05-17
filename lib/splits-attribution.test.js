// Run: node lib/splits-attribution.test.js
const assert = require('assert');
const { analyzeSplitsAttribution, magBucket } = require('./splits-attribution');

function entry(overrides) {
  return {
    units: 1,
    pubOdds: -110,
    ev: 2.5,
    result: 'win',
    profitUnits: 0.91,
    splitsSnapshot: {
      available: true,
      magnitude: 14,
      agreesWithLock: true,
      market: 'Spread',
      sharpMoney: 72,
      sharpTickets: 58,
      volumeTier: 'high'
    },
    ...overrides
  };
}

const cohort = [
  entry({ result: 'win', profitUnits: 1 }),
  entry({ result: 'loss', profitUnits: -1, profitUnits: -1 }),
  entry({ result: 'win', splitsSnapshot: { available: true, magnitude: 6, agreesWithLock: true, market: 'ML' } }),
  entry({ result: 'loss', splitsSnapshot: { available: true, magnitude: 15, agreesWithLock: false, market: 'ML' } }),
  entry({ result: null, splitsSnapshot: { available: true, magnitude: 20, agreesWithLock: true } })
];

const report = analyzeSplitsAttribution(cohort, { minN: 2 });
assert.strictEqual(magBucket(14), 'strong');
assert.ok(report.cohort.graded_with_splits >= 3);
assert.ok(report.slices.agrees_magnitude_12_plus);
assert.ok(report.glossary.magnitude);
console.log('splits-attribution tests OK');
