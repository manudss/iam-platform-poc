// Spike: prove @cedar-policy/cedar-wasm covers the future browser editor needs
// (parse, schema parse, schema validation with located errors, formatting).
// Run: npm i @cedar-policy/cedar-wasm && node wasm-editor-check.mjs
import * as w from '@cedar-policy/cedar-wasm';
import fs from 'node:fs';
const demo = fs.readFileSync(new URL('./fixtures/demo-main.cedar', import.meta.url), 'utf8');
const schema = fs.readFileSync(new URL('./fixtures/schema.cedarschema', import.meta.url), 'utf8');
console.log('cedar version:', w.getCedarVersion());
console.log('checkParsePolicySet:', JSON.stringify(w.checkParsePolicySet({ staticPolicies: demo })));
console.log('checkParseSchema:', JSON.stringify(w.checkParseSchema(schema)));
const ok = w.validate({ schema, policies: { staticPolicies: demo } });
console.log('validate ok:', JSON.stringify(ok));
const bad = demo.replace('contains("payment-approver")', 'contains(context.missing)');
const ko = w.validate({ schema, policies: { staticPolicies: bad } });
console.log('validate errors on typo:', JSON.stringify(ko.validationErrors?.[0] ?? ko).slice(0, 300));
const f = w.formatPolicies({ policyText: demo, lineWidth: 100, indentWidth: 2 });
console.log('format:', f.type === 'success' ? `success (${f.formatted_policy.length} chars)` : JSON.stringify(f));
