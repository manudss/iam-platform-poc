import { ElementRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { Session } from '../session';
import { WorkflowEditPage } from './editor';
import { edgeLabelOf } from './editor';

// Actual editor state and graph operations, no replacement implementation or network credentials.
describe('direction C editor workbench', () => {
  let e: any;
  let update: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    update = vi.fn(async () => ({ status: 200, data: {} }));
    TestBed.configureTestingModule({ providers: [
      { provide: Session, useValue: { branch: signal('personal/alice'), adminToken: signal(''), api: { raw: update } } },
      { provide: Router, useValue: { url: '/workflows/edit/w1', navigateByUrl: vi.fn(async () => true) } },
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => 'w1' } } } },
      { provide: ElementRef, useValue: new ElementRef(document.createElement('div')) },
    ] });
    e = TestBed.runInInjectionContext(() => new WorkflowEditPage());
    e.id = 'w1'; e.name = 'Joiner'; e.active = true;
    for (const [id, type] of [['a', 'notify'], ['b', 'notify'], ['c', 'notify']]) {
      const st = { name: id, type, config: {} }; e.state.set(id, st);
      e.vfNodes.update((ns: any[]) => [...ns, e.makeNode(id, st, ns.length)]);
    }
    e.savedDefinition = e.definitionStamp();
  });
  it('only marks real graph or metadata changes dirty; undo restores saved state', () => {
    expect(e.dirty()).toBe(false);
    e.name = 'Renamed'; expect(e.dirty()).toBe(true);
    e.name = 'Joiner'; expect(e.dirty()).toBe(false);
    e.setErrorTarget('a', 'b'); expect(e.dirty()).toBe(true);
    e.undo(); expect(e.dirty()).toBe(false);
    e.active = false; expect(e.dirty()).toBe(true);
  });
  it('routes errors through existing error edges and preserves the main links', () => {
    e.vfEdges.set([e.makeEdge('a->b', 'a', 'b')]);
    e.setErrorTarget('a', 'c');
    expect(e.errorTarget('a')).toBe('c');
    expect(e.vfEdges().map((x: any) => edgeLabelOf(x))).toEqual([undefined, 'error']);
    e.setErrorTarget('a', 'b'); expect(e.vfEdges().length).toBe(2);
    e.setErrorTarget('a', ''); expect(e.vfEdges().length).toBe(1);
    expect(e.errorTargets('a').map((n: any) => n.id)).toEqual(['b', 'c']);
  });
  it('refuses unknown error targets without editing the graph', () => {
    e.setErrorTarget('a', 'missing'); e.setErrorTarget('a', 'a'); e.setErrorTarget('missing', 'b'); expect(e.vfEdges()).toEqual([]);
    expect(e.dirty()).toBe(false);
  });
  it('opens the trigger inspector without silently changing the trigger', () => {
    e.triggerEvent.set('user.created'); e.openTrigger();
    expect(e.mobilePanel()).toBe('settings'); expect(e.triggerSelected()).toBe(true);
    expect(e.triggerEvent()).toBe('user.created');
  });
  it('keeps edits made during an in-flight save dirty', async () => {
    let finish!: (v: unknown) => void;
    update.mockImplementationOnce(() => new Promise(r => finish = r));
    const saved = e.save(); e.name = 'Typed during request';
    finish({ status: 200, data: {} }); await saved;
    expect(e.dirty()).toBe(true);
    await e.save(); expect(e.dirty()).toBe(false);
  });
  it('groups only available blocks, no fake SQL/data/table watcher blocks', () => {
    e.blocks.set([
      { type: 'if', family: 'Core', label: 'If', description: '' },
      { type: 'jira-create-issue', family: 'Jira', label: 'Create issue', description: '' },
      { type: 'assign-role', family: 'Core', label: 'Assign role', description: '' },
    ]);
    expect(e.palette().map((g: any) => g.family)).toEqual(['Logic', 'Data (lyam)', 'Connectors']);
    expect(e.palette().flatMap((g: any) => g.blocks).length).toBe(3);
  });
  it('reports measured progress and duration, not an invented successful test', () => {
    expect(e.testProgress()).toBe(0); expect(e.testDuration()).toBe('');
    e.testView.set({ run: { started_at: '2026-11-11T07:00:00Z', finished_at: '2026-11-11T07:00:04.200Z' }, steps: [{ status: 'done' }, { status: 'running' }] });
    expect(e.testProgress()).toBe(50); expect(e.testDuration()).toBe('4.2 s');
  });
});
