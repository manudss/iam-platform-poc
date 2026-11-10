// Workflows feature: implementation split into ./workflows/* (model, graph helpers, editor, executions,
// list). This barrel keeps every existing import ('./workflows') working unchanged.
export * from './workflows/wf-model';
export * from './workflows/graph-utils';
export * from './workflows/workbench-tabs';
export * from './workflows/placeholder-pick';
export * from './workflows/editor';
export * from './workflows/executions';
export * from './workflows/list';
