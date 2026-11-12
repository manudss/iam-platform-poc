import { Component, ElementRef, OnDestroy, OnInit, computed, effect, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { Connection, Edge, MiniMapComponent, Node, Vflow, VflowComponent } from 'ngx-vflow';
import { Session } from '../session';
import {
  RunView, StepCategory, StepType, STEP_TYPES, TRIGGER_NODE_ID, WfBlock, WfBlockField, WfEdge, WfEvent,
  WfNodeComponent, WfNodeData, WfTrigger, WfTriggerNodeComponent, WfTriggerNodeData,
  anchorViewport, categoryLabel, categoryOf, clientOf, rectsWithin, SAMPLE_WORKFLOWS,
} from './wf-model';
import { ValidationIssue, autoLayout, defaultLabel, edgeLabelChoices, outgoingLabels, validateGraph } from './graph-utils';
import { WbTabs, WbTabsBar } from './workbench-tabs';
import { managedProvider, editedAction, simulatedAction } from './execution-policy';
import { WorkflowConnection } from './wf-model';
import { filterPlaceholders, insertPlaceholder, phTokenAt } from './placeholder-pick';

import { branchStyle, workflowPorts, logicType } from './logic-ports';

interface NodeState { type: StepType; name: string; config: Record<string, unknown> }

/** Branch label carried on a vflow edge's data bag. */
export const edgeLabelOf = (e: Edge): string | undefined => (e.data?.() as Record<string, unknown> | undefined)?.['label'] as string | undefined;
interface SnapshotNode { id: string; type: StepType; name: string; config: Record<string, unknown>; x: number; y: number }
interface Snapshot { nodes: SnapshotNode[]; edges: WfEdge[] }

// ---- Workflow editor, design direction C "workbench": left rail palette (search + drag & drop), light
// canvas with minimap / zoom / insert-on-link, right config drawer (Settings / Input / Output), bottom
// status bar with live validation, and a test bar that runs the graph on a disposable branch. ----

@Component({ selector: 'app-workflow-edit', imports: [FormsModule, RouterLink, Vflow, MiniMapComponent, WbTabsBar], styleUrls: ['../pages.css', './editor-workbench.css'], styles: [
  '.wb-managed {border:1px solid var(--line);background:var(--panel);border-radius:var(--radius);padding:.8rem;margin:.8rem 0;} .wb-mode {display:flex;gap:.4rem;margin:.6rem 0;} .wb-mode .on {background:var(--accent-soft);color:var(--accent);border-color:var(--accent);} .wb-real-dialog {box-sizing:border-box;width:min(520px,calc(100% - 2rem));max-height:90dvh;overflow:auto;padding:1.4rem;border:1px solid var(--line);border-radius:var(--radius);background:var(--card);color:var(--ink);} .wb-real-dialog::backdrop {background:var(--scrim);} .wb-real-note {padding:.8rem;border:1px solid var(--warn-line);background:var(--warn-soft);color:var(--ink);border-radius:var(--radius);}',
  '.wb-active { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; font-weight: 600; } .wb-active.paused { color: var(--bad); }',
  '.ph-popup { position: fixed; z-index: 40; display: flex; flex-direction: column; background: var(--card); border: 1px solid var(--line); border-radius: .4rem; box-shadow: 0 6px 18px var(--shadow-color); overflow: hidden; }',
  '.ph-popup button { text-align: left; background: none; border: 0; border-radius: 0; padding: .3rem .6rem; min-height: 0; font-family: ui-monospace, monospace; font-size: .78rem; color: var(--ink); cursor: pointer; }',
  '.ph-popup button.on, .ph-popup button:hover { background: var(--accent-soft); color: var(--accent-dark); }',
  '.wb-tags { width: 180px; }',
  '.tpl-modal { position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center; background: var(--scrim); }',
  '.tpl-dialog { width: min(560px, 92vw); max-height: 86vh; overflow: auto; background: var(--card); border-radius: .8rem; padding: 1.1rem 1.3rem; box-shadow: 0 20px 60px var(--shadow-color); }',
  '.tpl-dialog h3 { margin-top: 0; }',
], template: `
@if (note()) { <p role="status" class="msg">{{note()}}</p> }
<div class="wb">
  <div class="wb-top">
    <a class="btn secondary" routerLink="/workflows" title="Back to the list">←</a>
    <input class="wb-name" name="wfName" [(ngModel)]="name" maxlength="80" placeholder="Workflow name" aria-label="Workflow name" />
    <span class="wb-branch" [title]="s.branch()">⑂ {{s.branch() || 'main'}}</span>
    <span class="spacer"></span>
    <label class="wb-active" [class.paused]="!active"><input type="checkbox" role="switch" name="wfActive" [(ngModel)]="active" /> Active</label>
    <button class="secondary wb-export" (click)="exportDef()">↓ Export</button>
    <button (click)="save()" [disabled]="busy() || errorCount() > 0">Save</button>
    <button class="wb-test-toggle" (click)="testOpen.set(!testOpen())" [attr.aria-expanded]="testOpen()">▶ Test run</button>
    <details class="wb-tools"><summary aria-label="More workflow actions">⋯</summary><div class="wb-tools-body">
      <label>Description<input class="wb-desc" name="wfDesc" [(ngModel)]="description" maxlength="500" /></label>
      <label>Tags<input class="wb-tags" name="wfTags" [(ngModel)]="tags" maxlength="200" placeholder="Tags (comma-separated)" aria-label="Tags, comma-separated" /></label>
    <button class="secondary" (click)="undo()" [disabled]="!undoStack.length" title="Undo (Ctrl+Z)">↺</button>
    <button class="secondary" (click)="redo()" [disabled]="!redoStack.length" title="Redo (Ctrl+Shift+Z)">↻</button>
    <button class="secondary" (click)="copySelection()" [disabled]="!selectedIds().length" title="Copy selection (Ctrl+C)">Copy</button>
    <button class="secondary" (click)="paste()" [disabled]="!clipboard.nodes.length" title="Paste (Ctrl+V)">Paste</button>
    <button class="secondary" (click)="doAutoLayout()" title="Re-arrange the graph left to right">Auto-layout</button>
    <button class="secondary" (click)="exportDef()" title="Download the definition as JSON">Export</button>
    <label class="btn secondary wb-import" title="Load a definition JSON into the canvas">Import<input type="file" accept="application/json" (change)="importDef($event)" hidden /></label>
    @if (id !== 'new') {<button class="secondary" (click)="duplicateWorkflow()" [disabled]="busy()">Duplicate</button>}
    <button class="secondary" (click)="openSaveTpl()" [disabled]="busy() || errorCount() > 0" [title]="errorCount() ? 'Fix the validation errors first' : 'Save the current canvas as a gallery template'">Save as template</button>
    </div></details>
  </div>
  <app-wb-tabs [dirtyId]="dirty() ? id : ''" />
  <div class="wb-mobile-tools"><button class="secondary" (click)="mobilePanel.set(mobilePanel() === 'blocks' ? 'canvas' : 'blocks')" [attr.aria-expanded]="mobilePanel() === 'blocks'">☰ Blocks</button><button class="secondary" (click)="openTrigger()">ϟ Trigger</button><button class="secondary" (click)="mobilePanel.set(mobilePanel() === 'settings' ? 'canvas' : 'settings')" [attr.aria-expanded]="mobilePanel() === 'settings'">⚙ Settings</button></div>
  <div class="wb-main" [attr.data-panel]="mobilePanel()">
    <aside class="wb-rail" aria-label="Block palette">
      <button class="secondary wb-panel-close" (click)="mobilePanel.set('canvas')">Close blocks</button>
      <input name="paletteSearch" [(ngModel)]="paletteQuery" placeholder="Search blocks…" aria-label="Search blocks" />
      <p class="hint wb-palette-hint">Click or drag to add. Use + on a link to insert.</p>
      <div class="wf-family">Triggers <span>2</span></div>
      <button class="secondary wf-pal wf-pal-trigger" (click)="openTrigger()"><span class="wb-pal-icon">◷</span><span><b>Schedule</b><small>cron · Europe/Paris</small></span><small class="wb-pal-category">TRIG</small></button>
      <button class="secondary wf-pal wf-pal-trigger" (click)="openTrigger()"><span class="wb-pal-icon">ϟ</span><span><b>App event / Webhook</b><small>Configure the start trigger</small></span><small class="wb-pal-category">TRIG</small></button>
      @for (g of palette(); track g.family) {<div class="wf-family">{{g.family}} <span>{{g.blocks.length}}</span></div>
        @for (t of g.blocks; track t.type) {<button class="secondary wf-pal" draggable="true" (dragstart)="onPaletteDrag($event, t.type)" (click)="addNode(t.type); mobilePanel.set('canvas')" [title]="t.description"><span class="wb-pal-icon" [attr.data-category]="categoryOf(t)">{{blockIcon(t.type)}}</span><span class="wb-pal-copy"><b>{{paletteLabel(t.label)}}</b><small>{{t.description}}</small></span><small class="wb-pal-category" [attr.data-category]="categoryOf(t)">{{categoryLabel(categoryOf(t))}}</small></button>}
      }
      <details class="wb-samples"><summary>Samples</summary>
      @for (sm of samples; track sm.name) {<button class="secondary wf-pal" (click)="loadSample(sm)">{{sm.name}}</button>}</details>
    </aside>

    <div class="wb-canvas" (dragover)="$event.preventDefault()" (drop)="onCanvasDrop($event)">
      <vflow [nodes]="allNodes()" [edges]="allEdges()" [view]="'auto'" [minZoom]="0.3" [maxZoom]="1.8" [background]="{ type: 'dots', gap: 22, size: 1.5, color: 'var(--line)', backgroundColor: 'var(--bg)' }"
             [keyboardShortcuts]="{ multiSelection: ['Shift', 'Control', 'Meta'] }" [selectionBox]="{ mode: 'partial' }"
             (connect)="onConnect($event)" (componentNodeEvent)="noop($event)">
        <ng-template edge let-ctx><svg:path class="wf-typed-link" [attr.d]="ctx.path()" fill="none" [attr.stroke]="branchStyle(edgeLabelOf(ctx.edge)).color" [attr.stroke-dasharray]="branchStyle(edgeLabelOf(ctx.edge)).dash" [attr.stroke-width]="ctx.selected() ? 4 : 2.5" [attr.marker-end]="ctx.markerEnd()" />
          <svg:path [attr.d]="ctx.path()" fill="none" stroke="transparent" stroke-width="20" style="cursor:pointer" (click)="activeEdge.set(ctx.edge.id)" />
        </ng-template>
        <ng-template edgeLabelHtml let-ctx>
          <div class="wb-edge" [class.editing]="activeEdge()===ctx.edge.id" (click)="$event.stopPropagation()" (mousedown)="$event.stopPropagation()">
            <button class="wb-link-chip" [class.main]="!edgeLabelOf(ctx.edge)" [style.color]="branchStyle(edgeLabelOf(ctx.edge)).color" [attr.aria-label]="'Edit '+branchStyle(edgeLabelOf(ctx.edge)).text+' link from '+ctx.edge.source+' to '+ctx.edge.target" (click)="activeEdge.set(activeEdge()===ctx.edge.id ? '' : ctx.edge.id)">{{edgeLabelOf(ctx.edge) ? branchStyle(edgeLabelOf(ctx.edge)).text : '⋯'}}</button>
          </div>
        </ng-template>
        <mini-map position="bottom-left" [maskColor]="'var(--panel)'" [strokeColor]="'var(--line)'" [scaleOnHover]="false" />
      </vflow>
      <select class="wb-step-jump" aria-label="Jump to step" (change)="jumpStep($any($event.target).value)"><option value="">Jump to step…</option>@for(n of stepOptions();track n.id){<option [value]="n.id">{{n.name}}</option>}</select>
      <button class="wb-trigger-edit secondary" (click)="openTrigger()" [attr.aria-expanded]="triggerSelected()">ϟ {{triggerEvent() ? triggerLabel() : 'Manual start'}} · Edit</button>
      <div class="wb-zoom"><span aria-label="Canvas zoom">{{zoomPercent()}}%</span>
        <button class="secondary" (click)="zoom(1.25)" title="Zoom in">+</button>
        <button class="secondary" (click)="zoom(0.8)" title="Zoom out">−</button>
        <button class="secondary" (click)="fitCanvas(false)" title="Fit the whole graph">Fit</button>
      </div>
      @if (testOpen()) {<section class="wb-test" aria-label="Test run">
        <div class="wb-test-head"><b>Test run</b><span class="spacer"></span><button class="secondary" (click)="testOpen.set(false)" aria-label="Close test run">×</button></div>
        <p class="hint">Business data uses a disposable branch. External connectors may make real calls: inspect their settings first.</p>
        @if (triggerEvent() && triggerEvent() !== '__cron') {<label>Event payload (JSON)<textarea class="wb-payload" name="testPayload" rows="2" [(ngModel)]="testPayload"></textarea></label>}
        <div class="wb-test-head"><button (click)="runTest()" [disabled]="testRunning()">{{testRunning() ? 'Running…' : 'Run test'}}</button>
        @if (testView(); as tv) {<span class="chip" [attr.data-status]="tv.run.status">{{tv.run.status}}</span><small>{{testDuration()}}</small><progress [value]="testProgress()" max="100" aria-label="Test steps complete"></progress><a [routerLink]="['/workflows/runs']" [queryParams]="{ run: tv.run.id }">Open run</a>}
        </div>@if (testError()) {<p class="req">{{testError()}}</p>}@if (testView()?.run?.error) {<p class="req">{{testView()!.run.error}}</p>}
      </section>}
      @if(editingEdge();as edge){<div class="wb-link-actions wb-connect">
              <label>Branch<select class="wb-edge-label" [attr.aria-label]="'Branch of link ' + edge.id" [ngModel]="edgeLabelOf(edge) ?? ''" (ngModelChange)="setEdgeLabel(edge.id, $event)">@for(c of labelChoices(edge);track c.value){<option [value]="c.value">{{c.text}}</option>}</select></label>
              <button class="secondary" (click)="openInsert(edge)">+ Add step</button><button class="secondary" (click)="removeLink(edge.id)">Delete link</button><button class="secondary" (click)="activeEdge.set('')">Close</button>

          </div>}
      @if(pendingPort();as port){<section class="wb-connect card" role="dialog" aria-label="Connect output">
        <b>Output {{branchStyle(port.branch).text}}</b>
        @for(e of portLinks();track e.id){<button class="secondary" (click)="activeEdge.set(e.id);pendingPort.set(null)">Edit link to {{state.get(e.target)?.name || e.target}}</button>}
<label>Target step<select aria-label="Target step" [(ngModel)]="connectTarget"><option value="">Choose a step</option>@for(n of connectTargets();track n.id){<option [value]="n.id">{{n.name}}</option>}</select></label><button (click)="connectPort()" [disabled]="!connectTarget">Connect</button><button class="secondary" (click)="pendingPort.set(null)">Cancel</button>
      </section>}
      @if (insertEdge(); as ie) {<div class="wb-insert card">
        <b>Insert a block on {{ie.source}} → {{ie.target}}</b>
        <input name="insertSearch" [(ngModel)]="insertQuery" placeholder="Search…" aria-label="Search blocks to insert" />
        <div class="wb-insert-list">
        @for (t of insertBlocks(); track t.type) {<button class="secondary" (click)="insertOnEdge(t.type)">{{t.label}} <small>{{categoryLabel(categoryOf(t))}}</small></button>}
        </div>
        <button class="secondary" (click)="insertEdge.set(null)">Cancel</button>
      </div>}
    </div>

    <aside class="wb-drawer" aria-label="Step inspector" (focusin)="phFocus($event)" (input)="phInput($event)" (keydown)="phKey($event)">
      <button class="secondary wb-panel-close" (click)="mobilePanel.set('canvas')">Back to canvas</button>
      @if (triggerSelected()) {<h3>Start trigger</h3><p class="hint">One start trigger per workflow. Configure when this graph starts.</p>      <div class="wb-trigger-fields">
      <label>Event<select name="wfTrigger" [ngModel]="triggerEvent()" (ngModelChange)="onTriggerChange($event)">
        <option value="">Manual start only</option>
        <option value="__cron">Scheduled (cron, Europe/Paris)</option>
        @for (ev of events(); track ev.type) {<option [value]="ev.type">{{ev.label}}</option>}
      </select></label>
      @if (triggerEvent() === '__cron') {<label>Schedule (5 fields, Europe/Paris)<input name="wfCron" [(ngModel)]="cronExpr" maxlength="40" placeholder="0 6 * * *" aria-label="Cron expression" /><span class="hint">minute hour day-of-month month day-of-week. The workflow starts at each matching minute while it is Active; missed times are not caught up.</span></label>}
      @if (triggerEvent() && triggerEvent() !== '__cron') {
        @for (k of payloadKeys(); track k) {@if (k !== '*') {<label>only if {{k}} =<input [attr.name]="'match-'+k" [ngModel]="match()[k] ?? ''" (ngModelChange)="setMatch(k, $event)" maxlength="40" placeholder="(any value)" /></label>}}
        @for (f of triggerFields(); track f.key) {
        @switch (f.type) {
        @case ('boolean') {<label><input type="checkbox" [attr.name]="'tc-'+f.key" [ngModel]="triggerCfg()[f.key] ?? f.default ?? false" (ngModelChange)="setTriggerCfg(f.key, $event)" /> {{f.label}}</label>}
        @case ('number') {<label>{{f.label}}<input type="number" [attr.name]="'tc-'+f.key" [ngModel]="triggerCfg()[f.key] ?? f.default" (ngModelChange)="setTriggerCfg(f.key, +$event)" /></label>}
        @case ('select') {<label>{{f.label}}<select [attr.name]="'tc-'+f.key" [ngModel]="triggerCfg()[f.key] ?? f.default ?? ''" (ngModelChange)="setTriggerCfg(f.key, $event)">@for (o of f.options ?? []; track o) {<option [value]="o">{{o}}</option>}</select></label>}
        @default {<label>{{f.label}} @if (f.required) {<b class="req">*</b>}<input [attr.name]="'tc-'+f.key" [ngModel]="triggerCfg()[f.key] ?? f.default ?? ''" (ngModelChange)="setTriggerCfg(f.key, $event)" maxlength="200" />@if (f.help) {<span class="hint">{{f.help}}</span>}</label>}
        }
        }
      }
      </div>
<button class="secondary" (click)="triggerSelected.set(false)">Done</button>
      } @else if (selectedIds().length > 1) {
        <h3>{{selectedIds().length}} steps selected</h3>
        <button class="secondary" (click)="copySelection()">Copy</button>
        <button class="secondary" (click)="deleteSelection()">Delete</button>
      } @else if (selectedNode(); as nid) {@if (state.get(nid); as st) {
        <div class="wb-inspector-head"><h3>{{st.name}}</h3><small>{{categoryLabel(actionCategory(st))}} · {{typeOf(st.type).label}}</small></div>
        <div class="wb-tabs">
          @for (tab of ['settings', 'input', 'output']; track tab) {<button class="wb-tab" [class.on]="drawerTab() === tab" (click)="drawerTab.set($any(tab))">{{tab === 'settings' ? 'Settings' : tab === 'input' ? 'Input' : 'Output'}}</button>}
        </div>
        @if (drawerTab() === 'settings') {
          <label>Step name<input name="stepName" [ngModel]="st.name" (ngModelChange)="rename(nid, $event)" maxlength="80" /></label>
          <details class="wb-block-help"><summary>About this block</summary><p class="hint">{{typeOf(st.type).label}} - {{typeOf(st.type).category === 'computed' ? 'COMPUTED: really runs and computes its output, but has no external effect.' : typeOf(st.type).category === 'real' ? 'REAL: data or external effect. Read the block description before running.' : 'SIMULATED: demonstrates the flow, no external effect.'}}</p>
          @if (blockOf(st.type)?.description) {<p class="hint">{{blockOf(st.type)!.description}}</p>}</details>
          @if (managed(st.type)) {
          <section class="wb-managed" aria-label="External action safety">
          <label>Connection<select name="managedConnection" [ngModel]="st.config['connectionId'] || ''" (ngModelChange)="setCfg(nid,'connectionId',$event)"><option value="">Select a connection</option>@for(c of connectionsFor(st.type);track c.id) {<option [value]="c.id">{{c.name}} · {{c.status}}</option>}</select></label>
          <p class="hint"><a routerLink="/workflows/connections">Manage in Connections</a> · no credential visible here.</p>
          <b>Execution mode</b><div class="wb-mode"><button class="secondary" [class.on]="st.config['executionMode'] !== 'real'" (click)="simulate(nid)">Simulation</button><button class="secondary" [class.on]="st.config['executionMode'] === 'real'" [disabled]="!realConnection(st)" (click)="requestReal(nid)">Real</button></div>
          <p class="hint">{{st.config['executionMode'] === 'real' ? 'Real enabled for future manual and scheduled runs. External effects are not reverted by discarding a Dolt branch.' : 'Simulation is the default. No remote call or external write. Computed steps still compute; lyam business writes stay on their own data branch.'}}</p>
          <b>Simulation preview</b><p class="hint">{{simulationPreview(st)}} No external action has been executed by this preview.</p>
          <p class="hint">Editor tests always simulate external actions. An uncertain creation stops for review; retry and error-route continuation are blocked.</p>
          </section>
          }
          @for (f of actionFields(st.type); track f.key) {
            @switch (f.type) {
            @case ('text') {<label>{{f.label}} @if (f.required) {<b class="req">*</b>}<textarea rows="3" [attr.name]="'g-'+f.key" [ngModel]="st.config[f.key] ?? f.default ?? ''" (ngModelChange)="setCfg(nid, f.key, $event)"></textarea>@if (f.help) {<span class="hint">{{f.help}}</span>}</label>}
            @case ('boolean') {<label><input type="checkbox" [attr.name]="'g-'+f.key" [ngModel]="st.config[f.key] ?? f.default ?? false" (ngModelChange)="setCfg(nid, f.key, $event)" /> {{f.label}}</label>}
            @case ('number') {<label>{{f.label}}<input type="number" [attr.name]="'g-'+f.key" [ngModel]="st.config[f.key] ?? f.default" (ngModelChange)="setCfg(nid, f.key, +$event)" />@if (f.help) {<span class="hint">{{f.help}}</span>}</label>}
            @case ('select') {<label>{{f.label}} @if (f.required) {<b class="req">*</b>}<select [attr.name]="'g-'+f.key" [ngModel]="st.config[f.key] ?? f.default ?? ''" (ngModelChange)="setCfg(nid, f.key, $event)">@for (o of f.options ?? []; track o) {<option [value]="o">{{o}}</option>}</select>@if (f.help) {<span class="hint">{{f.help}}</span>}</label>}
            @default {<label>{{f.label}} @if (f.required) {<b class="req">*</b>}<input [attr.name]="'g-'+f.key" [ngModel]="st.config[f.key] ?? f.default ?? ''" (ngModelChange)="setCfg(nid, f.key, $event)" maxlength="500" />@if (f.help) {<span class="hint">{{f.help}}</span>}</label>}
            }
          }
          @if (!(blockOf(st.type)?.fields?.length)) {
            @switch (st.type) {
            @case ('wait') {<label>Seconds (0-60)<input name="waitSecs" type="number" min="0" max="60" [ngModel]="st.config['seconds']" (ngModelChange)="setCfg(nid,'seconds',$event)" /></label>}
            @case ('notify') {<label>Recipient (label only)<input name="notifTo" [ngModel]="st.config['recipient']" (ngModelChange)="setCfg(nid,'recipient',$event)" maxlength="80" /></label><label>Message<input name="notifMsg" [ngModel]="st.config['message']" (ngModelChange)="setCfg(nid,'message',$event)" maxlength="200" /></label>}
            @case ('fail') {<label>Error message<input name="failMsg" [ngModel]="st.config['message']" (ngModelChange)="setCfg(nid,'message',$event)" maxlength="200" /></label>}
            @case ('assign-role') {<label>Identity<input name="arId" [ngModel]="st.config['identity']" (ngModelChange)="setCfg(nid,'identity',$event)" maxlength="32" /></label><label>Role<input name="arRole" [ngModel]="st.config['role']" (ngModelChange)="setCfg(nid,'role',$event)" maxlength="32" /></label>}
            @case ('revoke-role') {<label>Identity<input name="rrId" [ngModel]="st.config['identity']" (ngModelChange)="setCfg(nid,'identity',$event)" maxlength="32" /></label><label>Role<input name="rrRole" [ngModel]="st.config['role']" (ngModelChange)="setCfg(nid,'role',$event)" maxlength="32" /></label>}
            @case ('set-department') {<label>Identity<input name="sdId" [ngModel]="st.config['identity']" (ngModelChange)="setCfg(nid,'identity',$event)" maxlength="32" /></label><label>Department<input name="sdDept" [ngModel]="st.config['department']" (ngModelChange)="setCfg(nid,'department',$event)" maxlength="40" /></label>}
            @case ('set-profile-field') {<label>Identity<input name="spfId" [ngModel]="st.config['identity']" (ngModelChange)="setCfg(nid,'identity',$event)" maxlength="32" /></label><label>Profile field<input name="spfField" [ngModel]="st.config['field']" (ngModelChange)="setCfg(nid,'field',$event)" maxlength="80" placeholder="hr-attributes.employee_grade" /></label><label>Value<input name="spfValue" [ngModel]="st.config['value']" (ngModelChange)="setCfg(nid,'value',$event)" maxlength="200" /></label>}
            }
          }
          @if (placeholdersFor(nid).length) {
            <p class="hint">Insert a placeholder:</p>
            <div>@for (ph of placeholdersFor(nid); track ph) {<button class="ph-chip" (mousedown)="$event.preventDefault(); insertIntoField(ph)">{{ph}}</button>}</div>
          }
          <label>On error<select name="errorRoute" [ngModel]="errorTarget(nid)" (ngModelChange)="setErrorTarget(nid, $event)"><option value="">Stop the run</option>@for (target of errorTargets(nid); track target.id) {<option [value]="target.id">Route to {{target.name}}</option>}</select><span class="hint">Uses the existing on-error link. Validation checks the resulting graph.</span></label>
          @for (i of issuesFor(nid); track i.message) {<p class="wb-inline-issue" [class.err]="i.level === 'error'">{{i.message}}</p>}
          <div class="row"><button class="secondary" (click)="duplicateNode(nid)">Duplicate step</button> <button class="secondary" (click)="deleteNode(nid)">Delete step</button></div>
        }
        @if (drawerTab() === 'input') {
          <p class="hint">Placeholders available in this step's fields. Click one to insert it into the last field you edited (copied otherwise).</p>
          @for (ph of placeholdersFor(nid); track ph) {<button class="ph-chip" (click)="insertIntoField(ph)">{{ph}}</button>}
          @if (!placeholdersFor(nid).length) {<p class="hint">None yet: add a start trigger, or link an upstream step that has outputs.</p>}
          @if (testStepFor(nid); as ts) {<h4>Input of the last test run</h4><pre class="wf-log">{{json(ts.input)}}</pre>}
        }
        @if (drawerTab() === 'output') {
          @if ((blockOf(st.type)?.outputs?.length ?? 0) > 0) {
            <p class="hint">Declared outputs of this block:</p>
            @for (o of blockOf(st.type)!.outputs!; track o.key) {<div><code>{{o.key}}</code> <small>{{o.description}}</small></div>}
          } @else {<p class="hint">This block declares no output.</p>}
          @if (testStepFor(nid); as ts) {<h4>Output of the last test run</h4><pre class="wf-log">{{json(ts.output)}}</pre><h4>Log</h4><pre class="wf-log">@for (l of ts.log; track l) {{{l}}
}</pre>}
        }
      }} @else if (selectedEdge(); as eid) {
        <h3>Link</h3>
        <p class="hint">{{eid}}</p>
        <button class="secondary" (click)="deleteEdge(eid)">Delete link</button>
      } @else {<p class="hint">Select a step on the canvas to edit it. Shift-click or drag a box for multi-selection.</p>}
    </aside>
  </div>

  <div class="wb-status">
    <span class="wb-status-branch">⑂ {{s.branch() || 'main'}}</span>
    <span>{{state.size}} step(s), {{vfEdges().length}} link(s)</span>
    @if (errorCount()) {<span class="wb-err">{{errorCount()}} error(s)</span>}
    @if (warnCount()) {<span class="wb-warn">{{warnCount()}} warning(s)</span>}
    @if (!errorCount() && !warnCount()) {<span class="hint">Validation OK</span>}
    <span class="spacer"></span>
    <span class="hint wb-status-help">Business writes: run branch · external effects are not reverted by Dolt</span>
    <span>{{blocks().length}} blocks · {{events().length}} events</span><span class="wb-saved" [class.unsaved]="dirty()">{{busy() ? 'Saving…' : dirty() ? '● Unsaved' : '● Saved'}}</span>
  </div>
  @if (issues().length) {<div class="wb-issues">
    @for (i of issues(); track i.message) {<button class="wb-issue" [class.err]="i.level === 'error'" (click)="focusIssue(i)"><b>{{i.level === 'error' ? 'Error' : 'Warning'}}</b> {{i.message}}</button>}
  </div>}
  @if (phPopup(); as pp) {
    <div class="ph-popup" role="listbox" [style.top.px]="pp.top" [style.left.px]="pp.left" [style.minWidth.px]="pp.width">
      @for (sugg of pp.list; track sugg; let i = $index) {<button type="button" role="option" [attr.aria-selected]="i === pp.index" [class.on]="i === pp.index" (mousedown)="$event.preventDefault(); pickPlaceholder(sugg)">{{sugg}}</button>}
    </div>
  }
  @if (realRequest(); as request) {
    <dialog #realDialog class="wb-real-dialog" aria-labelledby="real-title" (cancel)="$event.preventDefault(); realRequest.set(null)" (keydown)="realDialogKey($event)">
    <h2 id="real-title">Enable Real execution?</h2><p>Future manual and scheduled runs of this action can call <b>{{request.connection.name}}</b> outside lyam.</p>
    <p class="wb-real-note">External effects are not isolated in a Dolt branch and cannot be undone by discarding it.</p>
    <p>Check the connection and action fields. Editor tests still simulate external calls.</p><p class="hint">If a creation response is uncertain, the run stops for review. Retry and error-route continuation are blocked to avoid duplicates.</p>
    <div class="row"><button autofocus class="secondary" (click)="realRequest.set(null)">Keep Simulation</button><button (click)="confirmReal()">Confirm Real</button></div><p class="hint">Changing connection or action fields resets confirmation to Simulation.</p>
    </dialog>
  }
  @if (saveTplOpen()) {
    <div class="tpl-modal" (click)="saveTplOpen.set(false)">
      <div class="tpl-dialog" (click)="$event.stopPropagation()" role="dialog" aria-modal="true" aria-label="Save as template">
        <h3>Save as a template</h3>
        <p class="hint">Saves the CURRENT canvas (unsaved changes included) into the templates gallery, shared with every demo account. Instantiating a template creates a paused workflow.</p>
        <label>Template name<input name="tplName" [(ngModel)]="tplName" maxlength="80" /></label>
        <label>Description<input name="tplDesc" [(ngModel)]="tplDesc" maxlength="500" /></label>
        <label>Category<input name="tplCat" [(ngModel)]="tplCat" maxlength="60" placeholder="My templates" /></label>
        <div class="row"><span class="spacer"></span><button class="secondary" (click)="saveTplOpen.set(false)">Cancel</button><button (click)="saveTpl()" [disabled]="busy() || !tplName.trim()">Save the template</button></div>
      </div>
    </div>
  }
</div>
` })
export class WorkflowEditPage implements OnInit, OnDestroy {
  protected readonly s = inject(Session);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly tabs = inject(WbTabs);
  protected id = 'new';
  protected name = ''; protected description = ''; protected tags = '';
  protected active = true;
  protected note = signal(''); protected busy = signal(false);
  protected readonly samples = SAMPLE_WORKFLOWS;
  protected events = signal<WfEvent[]>([]);
  protected blocks = signal<WfBlock[]>([]);
  protected connections = signal<WorkflowConnection[]>([]);
  protected managed = managedProvider;
  protected actionCategory(st:NodeState):StepCategory { return managedProvider(st.type) ? st.config['executionMode']==='real' ? 'real' : 'simulated' : this.typeOf(st.type).category; }
  private refreshNode(id:string) {const n=this.vfNodes().find(n=>n.id===id);if(n)this.tintNode(n);}
  protected realRequest = signal<{id: string; connection: WorkflowConnection; configStamp: string} | null>(null);
  private readonly realDialog = viewChild<ElementRef<HTMLDialogElement>>('realDialog');
  private readonly realDialogEffect = effect(() => { const d=this.realDialog()?.nativeElement; if(d && !d.open)d.showModal(); });
  private connectionEpoch=0;
  private readonly connectionRefresh = effect(() => { this.s.branchEpoch(); const epoch=++this.connectionEpoch;this.connections.set([]); this.realRequest.set(null); void clientOf(this.s).connections().then(r=>{if(epoch===this.connectionEpoch)this.connections.set(r.connections);}).catch(()=>{if(epoch===this.connectionEpoch)this.connections.set([]);}); });
  protected connectionsFor(type:string) { return this.connections().filter(c=>c.provider===managedProvider(type)); }
  protected actionFields(type:string) { return (this.blockOf(type)?.fields ?? []).filter(f=>!managedProvider(type) || !['dryRun','source'].includes(f.key)); }
  protected realConnection(st:NodeState) { return this.connectionsFor(st.type).find(c=>c.id===st.config['connectionId'] && (c.secretConfigured || c.provider==='http')); }
  protected simulate(id:string) { const st=this.state.get(id); if(!st)return; st.config=simulatedAction(st.config);this.refreshNode(id);this.stateVersion.update(v=>v+1); }
  protected realDialogKey(event:KeyboardEvent) {event.stopPropagation();if(event.key!=='Tab')return;const d=this.realDialog()?.nativeElement,buttons=d?.querySelectorAll('button');if(!d||!buttons?.length)return;const first=buttons[0],last=buttons[buttons.length-1];if(event.shiftKey&&d.ownerDocument.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&d.ownerDocument.activeElement===last){event.preventDefault();first.focus();}}
  protected requestReal(id:string) { const st=this.state.get(id);if(!st)return;const connection=this.realConnection(st);if(!connection)return;this.simulate(id);this.realRequest.set({id,connection,configStamp:JSON.stringify(st.config)}); }
  protected confirmReal() { const r=this.realRequest();if(!r)return;const st=this.state.get(r.id);const c=st?this.realConnection(st):null;if(st && c?.id===r.connection.id && c.revision===r.connection.revision && JSON.stringify(st.config)===r.configStamp){st.config={...st.config,executionMode:'real',realConfirmed:true};this.refreshNode(r.id);this.stateVersion.update(v=>v+1);}this.realRequest.set(null); }
  protected simulationPreview(st:NodeState) { return st.type==='jira-create-issue' ? 'Would create one Jira issue in '+String(st.config['project'] || 'the selected project')+'.' : st.type==='http-request' ? 'Would send '+String(st.config['method'] || 'GET')+' to '+String(st.config['url'] || 'the configured URL')+'.' : st.type==='google-sheets-add-row' ? 'Would append one Google Sheets row.' : st.type==='google-sheets-update-row' ? 'Would update one Google Sheets row.' : 'Would run '+this.paletteLabel(this.typeOf(st.type).label)+'.'; }
  protected paletteQuery = '';
  protected insertQuery = '';
  protected insertEdge = signal<Edge | null>(null);
  protected triggerEvent = signal('');
  protected cronExpr = '';
  protected match = signal<Record<string, string>>({});
  protected triggerCfg = signal<Record<string, unknown>>({});
  protected drawerTab = signal<'settings' | 'input' | 'output'>('settings');
  protected readonly categoryLabel = categoryLabel;
  protected readonly categoryOf = categoryOf;
  protected activeEdge=signal('');
  protected editingEdge(){return this.vfEdges().find(e=>e.id===this.activeEdge());}
  protected portLinks(){const p=this.pendingPort();return p?this.vfEdges().filter(e=>e.source===p.source&&edgeLabelOf(e)===p.branch):[];}
  protected pendingPort=signal<{source:string;branch?:string}|null>(null);
  protected connectTarget='';
  protected stepOptions(){this.stateVersion();return [...this.state].map(([id,s])=>({id,name:s.name}));}
  protected jumpStep(id:string){const node=this.vfNodes().find(n=>n.id===id),v=this.vflow();if(!node||!v)return;const p=node.point();v.viewportTo({x:30-p.x*.9,y:70-p.y*.9,zoom:.9});this.mobilePanel.set('canvas');}

  protected connectTargets(){const source=this.pendingPort()?.source;return [...this.state].filter(([id])=>id!==source).map(([id,s])=>({id,name:s.name}));}
  protected connectPort(){const p=this.pendingPort();if(p&&this.connectTarget)this.onConnect({source:p.source,target:this.connectTarget,sourceHandle:`out:${p.branch??''}`});this.pendingPort.set(null);}
  private portAction(nodeId:string,direction:string,portId:string){if(direction==='input'){if(portId.startsWith('in:'))this.activeEdge.set(portId.slice(3));}else{this.connectTarget='';this.pendingPort.set({source:nodeId,branch:portId.slice(4)||undefined});}}

  protected readonly branchStyle=branchStyle;
  protected removeLink(id:string){this.pushHistory();this.vfEdges.update(es=>es.filter(e=>e.id!==id));this.activeEdge.set('');this.stateVersion.update(v=>v+1);}
  protected readonly edgeLabelOf = edgeLabelOf;
  protected readonly json = (v: unknown) => JSON.stringify(v ?? null, null, 2);
  protected onTriggerChange(v: string) { this.triggerEvent.set(v); this.match.set({}); this.triggerCfg.set({}); }
  protected payloadKeys() { return this.events().find((e) => e.type === this.triggerEvent())?.payload ?? []; }
  protected triggerFields(): WfBlockField[] { return this.events().find((e) => e.type === this.triggerEvent())?.configFields ?? []; }
  protected setTriggerCfg(k: string, v: unknown) { this.triggerCfg.update((c) => ({ ...c, [k]: v })); }
  protected setMatch(k: string, v: string) { this.match.update((m) => { const n = { ...m }; if (v) n[k] = v; else delete n[k]; return n; }); }
  private triggerPayload(): WfTrigger | null {
    const event = this.triggerEvent();
    if (event === '__cron') return this.cronExpr.trim() ? { cron: this.cronExpr.trim() } : null;
    if (!event) return null;
    const cfg = Object.fromEntries(Object.entries(this.triggerCfg()).filter(([, v]) => v !== '' && v !== undefined));
    return { event, ...(Object.keys(this.match()).length ? { match: this.match() } : {}), ...(Object.keys(cfg).length ? { config: cfg } : {}) };
  }
  /** The editor palette: the API block catalogue grouped by family (Core first), built-ins last-resort fallback. */
  protected palette(): { family: string; blocks: WfBlock[] }[] {
    const src: WfBlock[] = this.blocks().length ? this.blocks() : STEP_TYPES.map((t) => ({ type: t.type, family: 'Core', label: t.label, simulated: t.simulated, description: t.hint, provider: null, providerActive: true }));
    const byFamily = new Map<string, WfBlock[]>();
    for (const b of src.filter((b) => `${b.label} ${b.family} ${b.type} ${b.description}`.toLowerCase().includes(this.paletteQuery.trim().toLowerCase()))) { const family = /^(if|switch|loop|merge)$/.test(b.type) ? 'Logic' : /^(assign-role|revoke-role|set-department|set-profile-field|lyam-create-user)$/.test(b.type) ? 'Data (lyam)' : /^(jira|http|google)/.test(b.type) ? 'Connectors' : b.family === 'Core' ? 'Utilities' : b.family; const g = byFamily.get(family) ?? []; g.push(b); byFamily.set(family, g); }
    const order = ['Logic', 'Data (lyam)', 'Connectors', 'Text', 'Utilities'];
    return [...byFamily.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([family, blocks]) => ({ family, blocks }));
  }
  protected blockOf(t: string): WfBlock | undefined { return this.blocks().find((b) => b.type === t); }
  /** Blocks offered by the insert-on-link picker (logic blocks excluded: they need branch labels, add them from the palette). */
  protected insertBlocks(): WfBlock[] {
    const q = this.insertQuery.trim().toLowerCase();
    return (this.blocks().length ? this.blocks() : []).filter((b) => !outgoingLabels(b.type, {}).length && (!q || `${b.label} ${b.type}`.toLowerCase().includes(q)));
  }

  protected vfNodes = signal<Node[]>([]);
  protected vfEdges = signal<Edge[]>([]);
  private readonly vflow = viewChild(VflowComponent);
  private readonly host = inject(ElementRef<HTMLElement>);

  // ---- Live validation (status bar + issue list). Errors block Save. ----
  protected issues = computed<ValidationIssue[]>(() => {
    this.vfNodes(); this.vfEdges(); this.blocks(); this.events(); this.triggerEvent(); this.stateVersion();
    return validateGraph(
      [...this.state.entries()].map(([id, st]) => ({ id, type: st.type, name: st.name, config: st.config })),
      this.vfEdges().map((e) => ({ from: e.source, to: e.target, ...(edgeLabelOf(e) ? { label: edgeLabelOf(e)! } : {}) })),
      this.blocks(), this.events(), this.triggerEvent(),
    );
  });
  protected errorCount = computed(() => this.issues().filter((i) => i.level === 'error').length);
  protected warnCount = computed(() => this.issues().filter((i) => i.level === 'warning').length);
  private stateVersion = signal(0); // bumped on config/name edits so the validation recomputes
  protected focusIssue(i: ValidationIssue) {
    if (!i.nodeId) return;
    for (const n of this.vfNodes()) n.selected?.set(n.id === i.nodeId);
    const v = this.vflow(); const node = this.vfNodes().find((n) => n.id === i.nodeId);
    if (v && node) { const p = node.point(); v.viewportTo({ zoom: Math.max(v.viewport().zoom, 0.9), x: 320 - p.x, y: 180 - p.y }); }
  }

  // ---- Undo / redo: snapshots of nodes (with positions) and links, taken before each mutation. ----
  protected undoStack: Snapshot[] = [];
  protected redoStack: Snapshot[] = [];
  private snapshot(): Snapshot {
    return {
      nodes: this.vfNodes().map((n) => { const st = this.state.get(n.id)!; return { id: n.id, type: st.type, name: st.name, config: structuredClone(st.config), x: n.point().x, y: n.point().y }; }),
      edges: this.vfEdges().map((e) => ({ from: e.source, to: e.target, ...(edgeLabelOf(e) ? { label: edgeLabelOf(e)! } : {}) })),
    };
  }
  private pushHistory() { this.undoStack.push(this.snapshot()); if (this.undoStack.length > 60) this.undoStack.shift(); this.redoStack = []; }
  protected undo() { const s = this.undoStack.pop(); if (!s) return; this.redoStack.push(this.snapshot()); this.restore(s); }
  protected redo() { const s = this.redoStack.pop(); if (!s) return; this.undoStack.push(this.snapshot()); this.restore(s); }
  private restore(s: Snapshot) {
    this.state.clear();
    const nodes: Node[] = [];
    for (const n of s.nodes) { const st = { type: n.type, name: n.name, config: structuredClone(n.config) }; this.state.set(n.id, st); nodes.push(this.makeNode(n.id, st, 0, { x: n.x, y: n.y })); }
    this.vfNodes.set(nodes);
    this.vfEdges.set(s.edges.map((e) => this.makeEdge(`${e.from}->${e.to}${e.label ? `#${e.label}` : ''}`, e.from, e.to, undefined, e.label)));
    this.stateVersion.update((v) => v + 1);
  }

  // ---- Clipboard: copy/paste of the selected nodes and the links between them. ----
  protected clipboard: { nodes: SnapshotNode[]; edges: WfEdge[] } = { nodes: [], edges: [] };
  protected copySelection() {
    const ids = new Set(this.selectedIds());
    if (!ids.size) return;
    this.clipboard = {
      nodes: this.vfNodes().filter((n) => ids.has(n.id)).map((n) => { const st = this.state.get(n.id)!; return { id: n.id, type: st.type, name: st.name, config: structuredClone(st.config), x: n.point().x, y: n.point().y }; }),
      edges: this.vfEdges().filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => ({ from: e.source, to: e.target, ...(edgeLabelOf(e) ? { label: edgeLabelOf(e)! } : {}) })),
    };
    this.note.set(`${ids.size} step(s) copied.`);
  }
  protected paste() {
    if (!this.clipboard.nodes.length) return;
    this.pushHistory();
    const remap = new Map<string, string>();
    for (const n of this.clipboard.nodes) { let id: string; do { id = `step-${++this.seq}`; } while (this.state.has(id)); remap.set(n.id, id); }
    for (const n of this.clipboard.nodes) {
      const id = remap.get(n.id)!;
      const st: NodeState = { type: n.type, name: `${n.name.slice(0, 70)} (copy)`, config: structuredClone(n.config) };
      this.state.set(id, st);
      this.vfNodes.update((ns) => [...ns, this.makeNode(id, st, 0, { x: n.x + 40, y: n.y + 40 })]);
    }
    for (const e of this.clipboard.edges) {
      const from = remap.get(e.from)!, to = remap.get(e.to)!;
      this.vfEdges.update((es) => [...es, this.makeEdge(`${from}->${to}${e.label ? `#${e.label}` : ''}`, from, to, undefined, e.label)]);
    }
    for (const n of this.vfNodes()) n.selected?.set(remap.has(n.id) ? true : false);
    this.stateVersion.update((v) => v + 1);
  }
  protected deleteSelection() {
    const ids = new Set(this.selectedIds());
    if (!ids.size) return;
    this.pushHistory();
    for (const id of ids) this.state.delete(id);
    this.vfNodes.set(this.vfNodes().filter((n) => !ids.has(n.id)));
    this.vfEdges.set(this.vfEdges().filter((e) => !ids.has(e.source) && !ids.has(e.target)));
    this.stateVersion.update((v) => v + 1);
  }

  private fitCanvas(readable = true) {
    // Deterministic initial framing (no blind fixed timeouts): wait until the canvas is initialized and
    // every node is really measured in the DOM, fit the whole graph, then verify the visible result.
    this.frameWhenReady(1, 0, readable);
  }
  private nodeRects(): DOMRect[] {
    return [...this.host.nativeElement.querySelectorAll('.wf-node')].map((el) => el.getBoundingClientRect());
  }
  private frameWhenReady(attempt: number, waitedFrames: number, readable = true) {
    const v = this.vflow();
    const canvas = this.host.nativeElement.querySelector('vflow');
    if (!v || !canvas) return; // the page was left before the framing finished
    const rects = this.nodeRects();
    const ready = v.initialized() && canvas.clientWidth > 0 && rects.length === this.allNodes().length && rects.every((r) => r.width > 0 && r.height > 0);
    if (!ready) {
      if (waitedFrames < 600) requestAnimationFrame(() => requestAnimationFrame(() => this.frameWhenReady(attempt, waitedFrames + 1, readable)));
      else v.fitView({ padding: 0.14, duration: 120 }); // last-resort best effort, same as the old behavior
      return;
    }
    v.fitView({ padding: 0.14, duration: 120 });
    this.verifyFraming(attempt, performance.now(), readable);
  }
  private verifyFraming(attempt: number, fitAt: number, readable = true) {
    const v = this.vflow();
    const canvas = this.host.nativeElement.querySelector('vflow');
    if (!v || !canvas) return;
    if (performance.now() - fitAt < 200) { requestAnimationFrame(() => this.verifyFraming(attempt, fitAt, readable)); return; } // let the fit animation finish and the DOM catch up
    if (!rectsWithin(this.nodeRects(), canvas.getBoundingClientRect())) {
      // The fit ran on stale sizes: retry from the readiness gate, bounded, until the framing is right.
      if (attempt < 12) requestAnimationFrame(() => requestAnimationFrame(() => this.frameWhenReady(attempt + 1, 0, readable)));
      return;
    }
    // Fit everything first so the shape of the graph is visible; if the fit had to shrink the nodes
    // below comfortable reading size, zoom back toward 1:1 anchored on the leftmost node (the user pans).
    const canvasWidth = canvas.clientWidth;
    const anchor = readable && canvasWidth < 500 && v.viewport().zoom < 0.85 ? anchorViewport(this.allNodes(), 0.85) : null;
    if (anchor) v.viewportTo({ ...anchor, zoom: 0.85 });
  }
  protected state = new Map<string, NodeState>();
  /** Selection is tracked by the library on each entity's own `selected` signal. */
  protected selectedIds = computed(() => this.vfNodes().filter((n) => n.selected?.()).map((n) => n.id));
  protected selectedNode = computed(() => { const ids = this.selectedIds(); return ids.length === 1 ? ids[0] : null; });
  protected selectedEdge = computed(() => (this.selectedNode() ? null : this.vfEdges().find((e) => e.selected?.())?.id ?? null));
  private seq = 0;
  protected readonly mobilePanel = signal<'canvas' | 'blocks' | 'settings'>('canvas');
  protected readonly triggerSelected = signal(false);
  private savedDefinition = '';
  protected dirty() { return this.id === 'new' || (!this.savedDefinition || this.definitionStamp() !== this.savedDefinition); }
  private definitionStamp() { return JSON.stringify({ name: this.name, description: this.description, tags: this.tagList(), active: this.active, trigger: this.triggerPayload(), graph: this.graph() }); }
  protected openTrigger() { this.triggerSelected.set(true); this.mobilePanel.set('settings'); }
  protected zoomPercent() { return Math.round((this.vflow()?.viewport().zoom ?? 1) * 100); }
  protected paletteLabel(label: string) { return label.replace(/\s*\([^)]*\)/g, '').trim(); }
  protected blockIcon(t: string) { return /jira/.test(t) ? 'J' : /google|sheet/.test(t) ? '▦' : /http/.test(t) ? '↗' : /if|switch/.test(t) ? '⑂' : /loop/.test(t) ? '↻' : /user|role/.test(t) ? '♙' : /text/.test(t) ? 'Aa' : '◇'; }
  protected issuesFor(id: string) { return this.issues().filter(i => i.nodeId === id); }
  protected errorTarget(id: string) { return this.vfEdges().find(e => e.source === id && edgeLabelOf(e) === 'error')?.target ?? ''; }
  protected errorTargets(id: string) { return [...this.state.entries()].filter(([key]) => key !== id).map(([key, st]) => ({ id: key, name: st.name })); }
  protected setErrorTarget(id: string, target: string) {
    if (!this.state.has(id) || target === id || (target && !this.state.has(target)) || this.errorTarget(id) === target) return;
    this.pushHistory();
    this.vfEdges.update(edges => [...edges.filter(e => !(e.source === id && edgeLabelOf(e) === 'error')), ...(target ? [this.makeEdge(`${id}->${target}#error`, id, target, undefined, 'error')] : [])]);
  }
  protected testProgress() { const steps = this.testView()?.steps ?? []; return steps.length ? Math.round(100 * steps.filter(s => ['done', 'failed', 'skipped', 'canceled'].includes(s.status)).length / steps.length) : 0; }
  protected testDuration() { const r = this.testView()?.run; if (!r?.started_at || !r.finished_at) return ''; const ms = Date.parse(r.finished_at) - Date.parse(r.started_at); return Number.isFinite(ms) ? `${Math.max(0, ms / 1000).toFixed(1)} s` : ''; }
  private readonly selectionPanel = effect(() => { if (this.selectedNode()) { this.triggerSelected.set(false); this.mobilePanel.set('settings'); } });

  ngOnInit() {
    this.id = this.route.snapshot.paramMap.get('id') ?? 'new';
    void clientOf(this.s).events().then((r) => this.events.set(r.events)).catch(() => this.events.set([]));
    void clientOf(this.s).blocks().then((r) => this.blocks.set(r.blocks)).catch(() => this.blocks.set([]));
    if (this.id !== 'new') void this.load();
    else this.tabs.open('workflow', 'new', 'New workflow');
    this.keyHandler = (ev: KeyboardEvent) => this.onKey(ev);
    window.addEventListener('keydown', this.keyHandler);
  }
  ngOnDestroy() { window.removeEventListener('keydown', this.keyHandler); clearInterval(this.testTimer); }
  private keyHandler!: (ev: KeyboardEvent) => void;
  private onKey(ev: KeyboardEvent) {
    if(ev.key==='Escape'){this.activeEdge.set('');this.pendingPort.set(null);}
    const tag = (ev.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return; // typing in a field
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && ev.key.toLowerCase() === 'z' && !ev.shiftKey) { ev.preventDefault(); this.undo(); }
    else if (mod && (ev.key.toLowerCase() === 'y' || (ev.key.toLowerCase() === 'z' && ev.shiftKey))) { ev.preventDefault(); this.redo(); }
    else if (mod && ev.key.toLowerCase() === 'c') { ev.preventDefault(); this.copySelection(); }
    else if (mod && ev.key.toLowerCase() === 'v') { ev.preventDefault(); this.paste(); }
    else if ((ev.key === 'Delete' || ev.key === 'Backspace') && this.selectedIds().length) { ev.preventDefault(); this.deleteSelection(); }
  }

  protected typeOf(t: StepType): { type: string; label: string; simulated: boolean; category: StepCategory; hint: string } {
    const b = this.blockOf(t);
    if (b) return { type: b.type, label: b.label, simulated: b.simulated, category: categoryOf(b), hint: b.description };
    return STEP_TYPES.find((x) => x.type === t) ?? { type: t, label: t, simulated: true, category: 'simulated', hint: '' };
  }

  // ---- Trigger as the first canvas node: a computed visual node (never in the saved graph) linked to every
  // root step, so a workflow that starts on an event reads left-to-right: TRIGGER -> steps. ----
  protected triggerLabel = computed(() => {
    const t = this.triggerEvent();
    if (!t) return '';
    if (t === '__cron') return `cron: ${this.cronExpr.trim() || '…'} (Europe/Paris)`;
    return this.events().find((e) => e.type === t)?.label ?? t;
  });
  private triggerNode = computed<Node | null>(() => {
    const label = this.triggerLabel();
    if (!label) return null;
    return {
      id: TRIGGER_NODE_ID, type: WfTriggerNodeComponent,
      data: signal<WfTriggerNodeData>({ name: label }),
      point: signal({ x: 20, y: 60 }),
      selected: signal(false),
    } as Node;
  });
  protected allNodes = computed(() => { const t = this.triggerNode(); return t ? [t, ...this.vfNodes()] : this.vfNodes(); });
  /** Visual links from the trigger node to every root step (no incoming link). Never saved in the graph. */
  protected triggerEdges = computed<Edge[]>(() => {
    if (!this.triggerNode()) return [];
    const incoming = new Set(this.vfEdges().map((e) => e.target));
    return this.vfNodes().filter((n) => !incoming.has(n.id)).map((n) => this.makeEdge(`${TRIGGER_NODE_ID}->${n.id}`, TRIGGER_NODE_ID, n.id, 'var(--warn-line)'));
  });
  protected allEdges = computed(() => {
    this.stateVersion();
    return [...this.triggerEdges(), ...this.vfEdges()].map(e=>{const label=edgeLabelOf(e);return {...e,sourceHandle:e.source===TRIGGER_NODE_ID?undefined:`out:${label??''}`,targetHandle:e.source!==TRIGGER_NODE_ID&&logicType(this.state.get(e.target)?.type??'')?`in:${e.id}`:'in'};});
  });
  private readonly refreshPorts=effect(()=>{this.stateVersion();this.vfEdges().forEach(e=>e.data?.());this.testView();this.blocks();for(const n of this.vfNodes())this.tintNode(n);});

  private makeNode(id: string, st: NodeState, i: number, at?: { x: number; y: number }): Node {
    return {
      id, type: WfNodeComponent,
      data: signal<WfNodeData>({ name: st.name, category: logicType(st.type)?'computed':this.actionCategory(st), icon: this.blockIcon(st.type), runStatus: this.testStatusOf(id) }),
      point: signal(at ?? { x: 320 + (i % 3) * 260, y: 40 + Math.floor(i / 3) * 130 }),
      selected: signal(false),
    } as Node;
  }
  private makeEdge(id: string, source: string, target: string, color?: string, label?: string): Edge {
    const branch=branchStyle(label).color;
    return {
      id, source, target, type:'template', selected: signal(false),
      data: signal<Record<string, unknown>>(label ? { label } : {}),
      edgeLabels: signal(label || source !== TRIGGER_NODE_ID ? { center: { type: 'html-template', data: { edgeId: id } } } : {}),
      markers: signal({ end: { type: 'arrow-closed', width: 16, height: 16, color: color ?? branch ?? 'var(--muted)' } }),
    } as Edge;
  }

  protected addNode(type: StepType, at?: { x: number; y: number }) {
    this.pushHistory();
    const id = this.newNodeId();
    const st: NodeState = { type, name: this.typeOf(type).label, config: this.defaultConfig(type) };
    this.state.set(id, st);
    for (const n of this.vfNodes()) n.selected?.set(false);
    const node = this.makeNode(id, st, this.vfNodes().length, at);
    node.selected?.set(true);
    this.vfNodes.update((ns) => [...ns, node]);
    this.stateVersion.update((v) => v + 1);
  }
  private newNodeId(): string { let id: string; do { id = `step-${++this.seq}`; } while (this.state.has(id)); return id; }
  private defaultConfig(type: StepType): Record<string, unknown> {
    const defaults: Record<string, Record<string, unknown>> = {
      wait: { seconds: 2 }, notify: { recipient: '', message: '' }, fail: { message: 'step configured to fail' },
      'assign-role': { identity: 'demo-bob', role: 'accountant' }, 'revoke-role': { identity: 'demo-bob', role: 'payment-creator' }, 'set-department': { identity: 'demo-bob', department: '' }, 'set-profile-field': { identity: 'demo-bob', field: 'hr-attributes.employee_grade', value: '' },
      if: { left: '{{event.subject}}', op: 'equals', right: '' }, switch: { value: '{{event.subject}}', cases: '' }, loop: { items: '', maxItems: 10 }, merge: {},
    };
    const blk = this.blockOf(type);
    const fieldDefaults = Object.fromEntries((blk?.fields ?? []).filter((f) => f.default !== undefined).map((f) => [f.key, f.default as unknown]));
    return { ...fieldDefaults, ...defaults[type], ...(managedProvider(type) ? {executionMode:'simulation',realConfirmed:false,connectionId:'',...(type.startsWith('google-sheets-')?{source:'google'}:{})} : {}) };
  }

  // ---- Drag & drop from the palette ----
  protected onPaletteDrag(ev: DragEvent, type: StepType) { ev.dataTransfer?.setData('text/wf-block', type); }
  protected onCanvasDrop(ev: DragEvent) {
    const type = ev.dataTransfer?.getData('text/wf-block');
    if (!type) return;
    ev.preventDefault();
    const v = this.vflow();
    const canvas = this.host.nativeElement.querySelector('vflow');
    if (!v || !canvas) { this.addNode(type); return; }
    const rect = canvas.getBoundingClientRect();
    const vp = v.viewport();
    this.addNode(type, { x: (ev.clientX - rect.left - vp.x) / vp.zoom - 95, y: (ev.clientY - rect.top - vp.y) / vp.zoom - 32 });
  }

  // ---- Links: branch labels for logic steps, insert-on-link. ----
  protected labelChoices(edge: Edge): { value: string; text: string }[] {
    const st = this.state.get(edge.source);
    if (!st) return [];
    return edgeLabelChoices(st.type, st.config);
  }
  protected setEdgeLabel(edgeId: string, label: string) {
    const e = this.vfEdges().find((x) => x.id === edgeId);
    if (!e) return;
    if(this.vfEdges().some(other=>other.id!==edgeId&&other.source===e.source&&other.target===e.target&&edgeLabelOf(other)===(label||undefined))){this.note.set('This branch already connects these steps.');return;}
    this.pushHistory();
    e.data?.set(label ? { label } : {});
    e.markers?.set({end:{type:'arrow-closed',width:16,height:16,color:branchStyle(label).color}});
    this.stateVersion.update((v) => v + 1);
  }
  protected openInsert(edge: Edge) { if (edge.source === TRIGGER_NODE_ID) return; this.insertQuery = ''; this.insertEdge.set(edge); }
  protected insertOnEdge(type: StepType) {
    const edge = this.insertEdge();
    if (!edge) return;
    this.pushHistory();
    const id = this.newNodeId();
    const st: NodeState = { type, name: this.typeOf(type).label, config: this.defaultConfig(type) };
    this.state.set(id, st);
    // Place the new block halfway between its neighbors when their positions are known.
    const a = this.vfNodes().find((n) => n.id === edge.source)?.point() ?? { x: 100, y: 100 };
    const b = this.vfNodes().find((n) => n.id === edge.target)?.point() ?? { x: a.x + 260, y: a.y };
    this.vfNodes.update((ns) => [...ns, this.makeNode(id, st, 0, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })]);
    const label = edgeLabelOf(edge);
    this.vfEdges.set(this.vfEdges().filter((e) => e.id !== edge.id));
    this.vfEdges.update((es) => [...es,
      this.makeEdge(`${edge.source}->${id}${label ? `#${label}` : ''}`, edge.source, id, undefined, label),
      this.makeEdge(`${id}->${edge.target}`, id, edge.target),
    ]);
    this.insertEdge.set(null);
    this.stateVersion.update((v) => v + 1);
  }

  protected rename(id: string, v: string) {
    const st = this.state.get(id)!; st.name = v;
    const n = this.vfNodes().find((x) => x.id === id);
    if (n) this.tintNode(n);
    this.stateVersion.update((v) => v + 1);
  }
  protected setCfg(id: string, k: string, v: unknown) { const st=this.state.get(id)!; st.config=editedAction(st.type,st.config,k,k === 'seconds' || k === 'maxItems' ? Number(v) : v);this.realRequest.set(null);this.refreshNode(id); this.stateVersion.update((x) => x + 1); }
  protected noop(_e: unknown) {}
  protected onConnect(c: Connection) {
    if (!c.source || !c.target) return;
    if (c.source === TRIGGER_NODE_ID || c.target === TRIGGER_NODE_ID) return; // trigger links are drawn automatically to the root steps
    const st = this.state.get(c.source);
    const used = this.vfEdges().filter((e) => e.source === c.source).map((e) => edgeLabelOf(e));
    const selected=c.sourceHandle?.startsWith('out:')?c.sourceHandle.slice(4):undefined;
    const label = selected!==undefined ? selected||undefined : st ? defaultLabel(st.type, st.config, used) : undefined;
    if(this.vfEdges().some(e=>e.source===c.source&&e.target===c.target&&edgeLabelOf(e)===label))return;
    const baseId = `${c.source}->${c.target}${label ? `#${label}` : ''}`;
    let id=baseId,suffix=1;while(this.vfEdges().some(e=>e.id===id))id=`${baseId}:${suffix++}`;
    this.pushHistory();
    this.vfEdges.update((es) => [...es, this.makeEdge(id, c.source!, c.target!, undefined, label)]);
    this.stateVersion.update((v) => v + 1);
  }
  protected duplicateNode(id: string) {
    const source = this.state.get(id); if (!source) return;
    this.pushHistory();
    const copyId = this.newNodeId();
    const copy = { ...source, name: `${source.name.slice(0, 70)} (copy)`, config: structuredClone(source.config) };
    this.state.set(copyId, copy);
    for (const n of this.vfNodes()) n.selected?.set(false);
    const n = this.makeNode(copyId, copy, this.vfNodes().length); n.selected?.set(true);
    this.vfNodes.update((ns) => [...ns, n]);
    this.note.set('Step duplicated without links. Connect it where needed.');
    this.stateVersion.update((v) => v + 1);
  }
  protected deleteNode(id: string) {
    this.pushHistory();
    this.state.delete(id);
    this.vfNodes.set(this.vfNodes().filter((n) => n.id !== id));
    this.vfEdges.set(this.vfEdges().filter((e) => e.source !== id && e.target !== id));
    this.stateVersion.update((v) => v + 1);
  }
  protected deleteEdge(id: string) {
    this.pushHistory();
    this.vfEdges.set(this.vfEdges().filter((e) => e.id !== id));
    this.stateVersion.update((v) => v + 1);
  }
  protected doAutoLayout() {
    this.pushHistory();this.arrangeNodes();this.fitCanvas();
  }
  private arrangeNodes() {
    const pos = autoLayout(
      [...this.state.entries()].map(([id, st]) => ({ id, type: st.type, name: st.name, config: st.config })),
      this.vfEdges().map((e) => ({ from: e.source, to: e.target })),
    );
    if(typeof window!=='undefined'&&window.innerWidth<700){let y=220;for(const n of this.vfNodes()){const st=this.state.get(n.id)!;const ports=workflowPorts(n.id,st.type,outgoingLabels(st.type,st.config),this.vfEdges().map(e=>({id:e.id,source:e.source,target:e.target,label:edgeLabelOf(e)})),{});n.point.set({x:40,y});y+=160+Math.max(ports.inputs.length,ports.outputs.length)*52;}return;}
    const layerY=new Map<number,number>();
    for (const n of this.vfNodes()) { const p=pos.get(n.id);if(!p)continue;const y=layerY.get(p.x)??40;const st=this.state.get(n.id)!;const ports=workflowPorts(n.id,st.type,outgoingLabels(st.type,st.config),this.vfEdges().map(e=>({id:e.id,source:e.source,target:e.target,label:edgeLabelOf(e)})),{});n.point.set({x:320+p.x*1.45,y});layerY.set(p.x,y+140+Math.max(ports.inputs.length,ports.outputs.length)*36); }
  }
  protected zoom(factor: number) { const v = this.vflow(); if (v) v.zoomTo(Math.min(1.8, Math.max(0.3, v.viewport().zoom * factor))); }

  /** Upstream steps of a node (transitive over the drawn links): their outputs are usable as placeholders. */
  protected ancestorsOfNode(id: string): string[] {
    const rev = new Map<string, string[]>();
    for (const e of this.vfEdges()) { const g = rev.get(e.target) ?? []; g.push(e.source); rev.set(e.target, g); }
    const out: string[] = []; const seen = new Set([id]); const queue = [id];
    while (queue.length) { const c = queue.shift()!; for (const p of rev.get(c) ?? []) if (!seen.has(p)) { seen.add(p); out.push(p); queue.push(p); } }
    return out;
  }
  protected placeholdersFor(nid: string): string[] {
    const ev = this.events().find((e) => e.type === this.triggerEvent());
    const out: string[] = (ev?.payload ?? []).filter((k) => k !== '*').map((k) => `{{event.${k}}}`);
    if (ev?.payload?.includes('*')) out.push('{{event.<any key of the row/call>}}');
    for (const aid of this.ancestorsOfNode(nid)) {
      const st = this.state.get(aid); if (!st) continue;
      for (const o of this.blockOf(st.type)?.outputs ?? []) out.push(`{{steps.${aid}.${o.key}}}`);
    }
    return out;
  }
  protected copyPlaceholder(ph: string) { void navigator.clipboard?.writeText(ph).then(() => this.note.set(`${ph} copied - paste it in a field.`)).catch(() => this.note.set(ph)); }

  // ---- Placeholder picker: autocomplete while typing `{{` in a step field of the drawer; the chips of the
  // Settings/Input tabs insert into the last edited field (fallback: copy). ----
  private phTarget: HTMLInputElement | HTMLTextAreaElement | null = null;
  protected phPopup = signal<{ list: string[]; index: number; top: number; left: number; width: number } | null>(null);

  /** Text fields a placeholder is valid in: the step config fields (generic g-* and the per-type ones), not the step name. */
  private static phField(el: EventTarget | null): (HTMLInputElement | HTMLTextAreaElement) | null {
    const okType = el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !['checkbox', 'radio', 'number', 'file', 'range', 'button', 'submit', 'hidden'].includes(el.type));
    if (!okType) return null;
    const f = el as HTMLInputElement | HTMLTextAreaElement;
    const okName = f.name.startsWith('g-') || ['notifTo', 'notifMsg', 'failMsg', 'arId', 'arRole', 'rrId', 'rrRole', 'sdId', 'sdDept', 'spfId', 'spfField', 'spfValue'].includes(f.name);
    return okName ? f : null;
  }
  private static caretOf(f: HTMLInputElement | HTMLTextAreaElement): number { try { return f.selectionStart ?? f.value.length; } catch { return f.value.length; } }

  protected phFocus(ev: FocusEvent) {
    const f = WorkflowEditPage.phField(ev.target);
    if (f) this.phTarget = f;
    this.phPopup.set(null);
  }

  protected phInput(ev: Event) {
    const f = WorkflowEditPage.phField(ev.target);
    if (!f) return;
    this.phTarget = f;
    const nid = this.selectedNode();
    const token = phTokenAt(f.value, WorkflowEditPage.caretOf(f));
    const list = token && nid ? filterPlaceholders(this.placeholdersFor(nid), token.text) : [];
    if (!token || !list.length) { this.phPopup.set(null); return; }
    const r = f.getBoundingClientRect();
    this.phPopup.set({ list, index: 0, top: r.bottom + 4, left: r.left, width: r.width });
  }

  protected phKey(ev: KeyboardEvent) {
    const pp = this.phPopup();
    if (!pp) return;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); const d = ev.key === 'ArrowDown' ? 1 : -1; this.phPopup.set({ ...pp, index: (pp.index + d + pp.list.length) % pp.list.length }); }
    else if (ev.key === 'Enter' || ev.key === 'Tab') { ev.preventDefault(); this.pickPlaceholder(pp.list[pp.index]); }
    else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); this.phPopup.set(null); }
  }

  /** Writes the picked placeholder into the target field and re-fires input so ngModel picks it up. */
  protected pickPlaceholder(ph: string) {
    const f = this.phTarget;
    if (!f) { this.phPopup.set(null); return; }
    const caret = WorkflowEditPage.caretOf(f);
    const token = phTokenAt(f.value, caret);
    const r = token ? insertPlaceholder(f.value, caret, token.start, ph) : insertPlaceholder(f.value, caret, caret, ph);
    f.value = r.value;
    f.dispatchEvent(new Event('input', { bubbles: true }));
    try { f.focus(); f.setSelectionRange(r.caret, r.caret); } catch { /* number-like fields */ }
    this.phPopup.set(null);
  }

  /** A placeholder chip inserts into the last drawer field edited; without one it falls back to copy. */
  protected insertIntoField(ph: string) {
    const f = this.phTarget;
    if (!f || !f.isConnected) { this.copyPlaceholder(ph); return; }
    const caret = WorkflowEditPage.caretOf(f);
    const r = insertPlaceholder(f.value, caret, caret, ph);
    f.value = r.value;
    f.dispatchEvent(new Event('input', { bubbles: true }));
    try { f.focus(); f.setSelectionRange(r.caret, r.caret); } catch { /* ok */ }
    this.note.set(`${ph} inserted.`);
  }

  protected loadSample(sm: (typeof this.samples)[number]) {
    this.pushHistory();
    this.name = sm.name.replace('Sample: ', 'Demo: ');
    this.description = sm.description;
    this.triggerEvent.set(sm.trigger?.event ?? ''); this.match.set({ ...(sm.trigger?.match ?? {}) }); this.triggerCfg.set({ ...(sm.trigger?.config ?? {}) });
    this.state.clear();
    const nodes: Node[] = [];
    sm.nodes.forEach((n, i) => { const st = { type: n.type, name: n.name, config: { ...n.config } }; this.state.set(n.id, st); nodes.push(this.makeNode(n.id, st, i)); });
    this.vfNodes.set(nodes);
    this.vfEdges.set(sm.edges.map((e) => this.makeEdge(`${e.from}->${e.to}${e.label ? `#${e.label}` : ''}`, e.from, e.to, undefined, e.label)));
    this.stateVersion.update((v) => v + 1);
    this.fitCanvas();
  }

  private async load() {
    try {
      const { definition } = await clientOf(this.s).get(this.id);
      this.name = definition.name; this.description = definition.description;
      this.tags = ((definition as { tags?: string[] }).tags ?? []).join(', ');
      this.active = definition.active !== false;
      this.tabs.open('workflow', this.id, this.name || this.id);
      this.triggerEvent.set(definition.trigger?.cron ? '__cron' : (definition.trigger?.event ?? ''));
      this.cronExpr = definition.trigger?.cron ?? '';
      this.match.set({ ...(definition.trigger?.match ?? {}) }); this.triggerCfg.set({ ...(definition.trigger?.config ?? {}) });
      this.state.clear();
      const nodes: Node[] = [];
      definition.graph.nodes.forEach((n, i) => { const st = { type: n.type, name: n.name, config: { ...n.config } }; this.state.set(n.id, st); nodes.push(this.makeNode(n.id, st, i)); this.seq = Math.max(this.seq, Number(n.id.replace(/\D/g, '')) || 0); });
      this.vfNodes.set(nodes);
      this.vfEdges.set(definition.graph.edges.map((e) => this.makeEdge(`${e.from}->${e.to}${e.label ? `#${e.label}` : ''}`, e.from, e.to, undefined, e.label)));
      this.stateVersion.update((v) => v + 1);
      this.arrangeNodes();
      this.savedDefinition = this.definitionStamp();
      this.fitCanvas();
    } catch (e) { this.note.set((e as Error).message); }
  }

  /** Tags as the API expects them: lowercase, comma/space separated, deduped (validation server-side). */
  private tagList(): string[] {
    const out: string[] = [];
    for (const t of this.tags.split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))
      if (!out.includes(t)) out.push(t);
    return out;
  }

  private graph() {
    return {
      nodes: [...this.state.entries()].map(([id, st]) => ({ id, type: st.type, name: st.name, config: st.config })),
      edges: this.vfEdges().map((e) => ({ from: e.source, to: e.target, ...(edgeLabelOf(e) ? { label: edgeLabelOf(e)! } : {}) })),
    };
  }

  // ---- Save as template: the CURRENT canvas (unsaved changes included) into the shared gallery. ----
  protected saveTplOpen = signal(false);
  protected tplName = ''; protected tplDesc = ''; protected tplCat = '';
  protected openSaveTpl() { this.tplName = this.name; this.tplDesc = this.description; this.tplCat = 'My templates'; this.saveTplOpen.set(true); }
  protected async saveTpl() {
    this.busy.set(true);
    try {
      await clientOf(this.s).saveTemplate({ name: this.tplName.trim() || this.name, description: this.tplDesc.trim() || this.description, category: this.tplCat.trim(), graph: this.graph(), trigger: this.triggerPayload() });
      this.note.set('Template saved: find it in the Templates gallery.');
      this.saveTplOpen.set(false);
    } catch (e) { this.note.set((e as Error).message); } finally { this.busy.set(false); }
  }
  protected async save() {
    this.busy.set(true);
    try {
      const c = clientOf(this.s);
      const trigger = this.triggerPayload();
      const savingStamp = this.definitionStamp();
      if (this.id === 'new') {
        const r = await c.create(this.name, this.description, this.graph(), trigger, this.active, this.tagList());
        this.tabs.replace({ kind: 'workflow', id: 'new', label: 'New workflow' }, { kind: 'workflow', id: r.definition.id, label: this.name || r.definition.id });
        this.id = r.definition.id;
        this.note.set('Workflow saved.'); void this.router.navigateByUrl(`/workflows/edit/${r.definition.id}`);
      }
      else { await c.update(this.id, this.name, this.description, this.graph(), trigger, this.active, this.tagList()); this.tabs.rename('workflow', this.id, this.name || this.id); this.note.set('Workflow saved.'); }
      this.savedDefinition = savingStamp;
    } catch (e) { this.note.set((e as Error).message); } finally { this.busy.set(false); }
  }

  // ---- Duplicate / export / import ----
  protected async duplicateWorkflow() {
    this.busy.set(true);
    try { const r = await clientOf(this.s).duplicate(this.id); void this.router.navigateByUrl(`/workflows/edit/${r.definition.id}`); }
    catch (e) { this.note.set((e as Error).message); this.busy.set(false); }
  }
  protected exportDef() {
    const def = JSON.stringify({ name: this.name, description: this.description, trigger: this.triggerPayload(), graph: this.graph() }, null, 2);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([def], { type: 'application/json' }));
    a.download = `${(this.name || 'workflow').replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  protected importDef(ev: Event) {
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (!file) return;
    void file.text().then((text) => {
      try {
        const d = JSON.parse(text) as { name?: string; description?: string; trigger?: WfTrigger; graph?: { nodes?: { id: string; type: string; name: string; config: Record<string, unknown> }[]; edges?: WfEdge[] } };
        if (!d.graph?.nodes) throw new Error('No graph.nodes in this file.');
        this.pushHistory();
        this.id = 'new';
        this.name = d.name ?? 'Imported workflow'; this.description = d.description ?? '';
        this.triggerEvent.set(d.trigger?.event ?? ''); this.match.set({ ...(d.trigger?.match ?? {}) }); this.triggerCfg.set({ ...(d.trigger?.config ?? {}) });
        this.state.clear();
        const nodes: Node[] = [];
        d.graph.nodes.forEach((n, i) => { const st = { type: n.type, name: n.name, config: { ...n.config } }; this.state.set(n.id, st); nodes.push(this.makeNode(n.id, st, i)); this.seq = Math.max(this.seq, Number(n.id.replace(/\D/g, '')) || 0); });
        this.vfNodes.set(nodes);
        this.vfEdges.set((d.graph.edges ?? []).map((e) => this.makeEdge(`${e.from}->${e.to}${e.label ? `#${e.label}` : ''}`, e.from, e.to, undefined, e.label)));
        this.stateVersion.update((v) => v + 1);
        this.note.set('Definition imported - Save creates it as a new workflow.');
        this.fitCanvas();
      } catch (e) { this.note.set(`Import failed: ${(e as Error).message}`); }
    });
    (ev.target as HTMLInputElement).value = '';
  }

  // ---- Test run from the editor: POST /workflows/test-run on the current canvas, poll, tint the nodes. ----
  protected testOpen = signal(false);
  protected testPayload = '{}';
  protected testRunning = signal(false);
  protected testView = signal<RunView | null>(null);
  protected testError = signal('');
  private testTimer?: ReturnType<typeof setInterval>;
  protected testStatusOf(nodeId: string): string | null { return this.testView()?.steps.find((s) => s.node_id === nodeId)?.status ?? null; }
  protected testStepFor(nodeId: string) { return this.testView()?.steps.find((s) => s.node_id === nodeId) ?? null; }
  private refreshTestTints() {
    for (const n of this.vfNodes()) this.tintNode(n);
  }
  private tintNode(n: Node) {
    if (n.type !== WfNodeComponent) return;
    const st = this.state.get(n.id); if (!st) return;
    const edges=this.vfEdges().map(e=>({id:e.id,source:e.source,target:e.target,label:edgeLabelOf(e)}));
    const names=Object.fromEntries([...this.state].map(([id,s])=>[id,s.name]));
    const ports=workflowPorts(n.id,st.type,outgoingLabels(st.type,st.config),edges,names);
    (n.data as { set(v: WfNodeData): void } | undefined)?.set({ logic:logicType(st.type),onPort:(direction,portId)=>this.portAction(n.id,direction,portId),...ports,name: st.name, category: logicType(st.type)?'computed':this.actionCategory(st), icon: this.blockIcon(st.type), runStatus: this.testStatusOf(n.id) });

  }
  protected async runTest() {
    let payload: Record<string, unknown> = {};
    try { payload = this.testPayload.trim() ? JSON.parse(this.testPayload) : {}; } catch { this.testError.set('The payload is not valid JSON.'); return; }
    this.testError.set(''); this.testRunning.set(true);
    try {
      const v = await clientOf(this.s).testRun(this.graph(), this.triggerPayload(), payload);
      this.testView.set(v); this.refreshTestTints();
      clearInterval(this.testTimer);
      this.testTimer = setInterval(() => void this.pollTest(v.run.id), 700);
    } catch (e) { this.testError.set((e as Error).message); this.testRunning.set(false); }
  }
  private async pollTest(id: string) {
    try {
      const v = await clientOf(this.s).run(id);
      this.testView.set(v); this.refreshTestTints();
      if (v.run.status !== 'running' && v.run.status !== 'queued') { clearInterval(this.testTimer); this.testRunning.set(false); }
    } catch { clearInterval(this.testTimer); this.testRunning.set(false); }
  }
}
