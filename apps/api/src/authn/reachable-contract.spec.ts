import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SEED_CONFIG, analyzeChain } from './config.js';
import { AuthnService } from './flow.service.js';
// Same variants and same expected tables as apps/web/src/app/reachable-fixture.ts (the client tooltip and the disabled levels use the same rule as Apply).
const EXPECTED: Record<string, Record<string, boolean>> = {"seed": {"1": true, "2": true, "3": true, "4": true, "5": true, "6": true, "7": true, "8": true, "9": true, "10": false}, "highChainsDisabled": {"1": true, "2": true, "3": true, "4": true, "5": true, "6": true, "7": true, "8": false, "9": false, "10": false}, "allChainsDisabled": {"1": false, "2": false, "3": false, "4": false, "5": false, "6": false, "7": false, "8": false, "9": false, "10": false}};
const variants = (): Record<string, typeof SEED_CONFIG> => {
  const seed = JSON.parse(JSON.stringify(SEED_CONFIG)), hi = JSON.parse(JSON.stringify(SEED_CONFIG)), off = JSON.parse(JSON.stringify(SEED_CONFIG));
  for (const c of hi.chains) { const a = analyzeChain(hi, c); if (!a.simulatedSteps.length && a.effectiveLevel >= 8) c.enabled = false; }
  for (const c of off.chains) c.enabled = false;
  return { seed, highChainsDisabled: hi, allChainsDisabled: off };
};
describe('reachable (shared contract with the web client)', () => {
  it('a chain whose own enabled flag is off never counts, a simulated one never counts', () => {
    for (const [name, cfg] of Object.entries(variants())) {
      const got = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => [String(n), AuthnService.reachable(cfg, n)]));
      assert.deepEqual(got, EXPECTED[name], name);
    }
  });
});
