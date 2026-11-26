import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import nock from 'nock';
import { externalBlock, validateGraph } from './model.js';
import { loadPluginModule } from '../plugins/v1/loader.js';
import { OFFICIAL_TEMPLATES } from './templates-catalog.js';

// French preparation based on the demo plan. Runtime substitutions and wording adaptations still need rendered-message review before sending.
// Nothing here sends or creates anything: validation only.
const tpl = (id: string) => OFFICIAL_TEMPLATES.find((t) => t.id === id)!;
const node = (t: string, id: string) => (tpl(t).nodes as any[]).find((n) => n.id === id);

describe('badge templates: validated texts and ticket label', () => {
  it('both templates are valid graphs', () => {
    for (const id of ['badge-request-from-sheet', 'badge-done-temporary-password']) validateGraph({ nodes: tpl(id).nodes, edges: tpl(id).edges } as any);
  });
  it('phase 1 ticket: validated title and description, label the phase 2 trigger filters on', () => {
    const t = node('badge-request-from-sheet', 'ticket').config;
    assert.equal(t.summary, '[Badge] Préparer le badge de {{event.prenom}} {{event.nom}}');
    assert.ok(t.description.startsWith('Demande automatique de la démo Lyam. Personne : {{event.prenom}} {{event.nom}}'));
    assert.ok(t.description.endsWith('Aucun mot de passe dans ce ticket.'));
    assert.equal(t.issueTypeId, '10003', 'Task in this demo KAN project, read from its creation metadata, not a universal Jira id');
    assert.equal(t.labels, 'badge-demo');
    assert.equal(tpl('badge-done-temporary-password').trigger!.config!.label, t.labels, 'phase 2 only sees tickets carrying the label phase 1 sets');
    assert.deepEqual(externalBlock('jira-create-issue')!.validate({ ...t, dryRun: true }).labels, ['badge-demo']);
  });
  it('passes the labels array to the installed Activepieces action (no network)', async () => {
    const adapter = loadPluginModule('workflow-connectors', 'adapter.mjs') as any;
    const action = adapter.pieceAction('@activepieces/piece-jira-cloud', 'create_issue');
    const old = action.run; let captured: any;
    action.run = async (ctx: any) => { captured = ctx.propsValue; return { key: 'KAN-99' }; };
    const projectLookup = nock('https://example.atlassian.net').get('/rest/api/3/project/KAN').reply(200, {id:'10000',key:'KAN'});
    try {
      const j = externalBlock('jira-create-issue')!;
      const config = j.validate({ project: 'KAN', issueTypeId: '10001', summary: 'Badge fictif', labels: 'badge-demo', dryRun: false });
      await j.run({ config, settings: { jiraInstanceUrl: 'https://example.atlassian.net', jiraEmail: 'fiction@example.test', jiraApiToken: 'fictitious-test-value' }, dryRun: false, log() {} } as any);
      assert.deepEqual(captured.issueFields.labels, ['badge-demo']);
      assert.equal(captured.projectId, '10000');
      assert.equal(projectLookup.isDone(), true);
    } finally { action.run = old; }
  });
  it('labels: optional, bounded, no space', () => {
    const j = externalBlock('jira-create-issue')!; const base = { project: 'KAN', issueTypeId: '10001', summary: 's' };
    assert.deepEqual(j.validate(base).labels, []);
    assert.deepEqual(j.validate({ ...base, labels: 'a, b ,a' }).labels, ['a', 'b']);
    assert.throws(() => j.validate({ ...base, labels: 'two words' }), /labels/);
    assert.throws(() => j.validate({ ...base, labels: Array.from({ length: 11 }, (_, i) => `l${i}`).join(',') }), /labels/);
  });
  it('preflights required headers and uses stable keys instead of trigger row numbers', () => {
    const pre = node('badge-request-from-sheet', 'preflight').config;
    assert.equal(pre.requiredColumns, 'email,ticket,badge,cree');
    for (const id of ['trace', 'mark']) { const c = node('badge-request-from-sheet', id).config; assert.equal(c.keyColumn, 'email'); assert.equal(c.rowNumber, undefined); }
    const final = node('badge-done-temporary-password', 'mark').config; assert.equal(final.keyColumn, '{{steps.resolve.keyColumn}}'); assert.equal(final.rowNumber, undefined);
    const find = node('badge-done-temporary-password', 'find').config;
    assert.ok(find.requiredColumns.split(',').includes(final.column), 'phase 2 output header is checked before gen/set/mail');
    assert.equal(find.columnName, final.keyColumn); assert.equal(find.searchValue, final.keyValue);
    for (const id of ['trace', 'mark']) assert.ok(pre.requiredColumns.split(',').includes(node('badge-request-from-sheet', id).config.column), 'phase 1 preflight and configured writes stay in sync');
    const edges = tpl('badge-request-from-sheet').edges as any[]; assert.ok(edges.some(e => e.from === 'preflight' && e.to === 'join'));
  });
  it('phase 1 writes the ticket key to a configurable column, before cree=ok', () => {
    const tr = node('badge-request-from-sheet', 'trace');
    assert.equal(tr.config.column, 'ticket'); assert.equal(tr.config.value, '{{steps.ticket.key}}');
    const edges = tpl('badge-request-from-sheet').edges as any[];
    assert.ok(edges.some((e) => e.from === 'link' && e.to === 'trace') && edges.some((e) => e.from === 'trace' && e.to === 'mark'));
  });
  it('phase 2 mail: validated subject and text, secret and expiry as markers only', () => {
    const m = node('badge-done-temporary-password', 'mail').config;
    assert.equal(m.subject, 'Votre accès Lyam est prêt');
    for (const part of ['votre badge est prêt et votre compte Lyam est activé', 'Identifiant : {{steps.resolve.account}}', 'Mot de passe temporaire : [[password]]', 'vous devrez en choisir un nouveau à la première connexion', 'Adresse : https://lyam.dss.name', 'Message de démonstration, compte fictif.']) assert.ok(m.text.includes(part), part);
    assert.ok(m.text.includes('[[hours]] heures') && m.text.includes('[[expiry]]'), 'the shown expiry is the recorded one, not a fixed 24');
    assert.equal(m.to, '{{steps.resolve.email}}', 'recipient comes from the linked account, never typed in the template');
    assert.equal(node('badge-done-temporary-password', 'mark').config.column, 'badge', 'column name stays configurable');
  });
});
