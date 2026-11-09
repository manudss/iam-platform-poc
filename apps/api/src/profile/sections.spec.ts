import 'reflect-metadata';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { loadPluginModule } from '../plugins/v1/loader.js';
const rules = loadPluginModule('directory', 'fields.mjs') as {
  validateProfileConfig: (v: unknown, cat: unknown[]) => { sections?: string[] };
  parseProfileConfig: (v: unknown) => { sections?: string[] };
  effectiveSchema: (cat: unknown[], cfg: unknown, ctx: string) => { key: string }[];
};
it('preserves empty sections and their explicit order across config validation and parsing', () => {
  const cfg = rules.validateProfileConfig({ fields: {}, sections: ['Identity', 'Empty', 'HR'] }, []);
  assert.deepEqual(rules.parseProfileConfig(JSON.parse(JSON.stringify(cfg))).sections, ['Identity', 'Empty', 'HR']);
});
it('refuses duplicate, blank, unnormalized, overlong and malformed section lists', () => {
  for (const sections of [['HR', 'hr'], [''], [' HR'], ['A  B'], ['a'.repeat(81)], [4], {}, Array(81).fill('x')])
    assert.throws(() => rules.validateProfileConfig({ fields: {}, sections }, []), /section/);
});
it('orders fields by explicit section order without relaxing core or authority field rules', () => {
  const cat = [
    { fullKey: 'p.first', plugin: 'p', label: 'First', type: 'string', klass: 'profile', section: 'Identity', order: 1 },
    { fullKey: 'p.second', plugin: 'p', label: 'Second', type: 'string', klass: 'profile', section: 'HR', order: 9 },
  ];
  const cfg = { fields: { 'p.first': { selfView: true }, 'p.second': { selfView: true } }, sections: ['HR', 'Empty', 'Identity'] };
  assert.deepEqual(rules.effectiveSchema(cat, cfg, 'self').map(f => f.key), ['p.second', 'p.first']);
  assert.deepEqual(rules.parseProfileConfig({ fields: {} }).sections, undefined, 'old configurations remain valid');
});
