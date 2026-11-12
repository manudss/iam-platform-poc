import {branchStyle,workflowPorts} from './logic-ports';
describe('logic port presentation',()=>{
 it('keeps N cases and N separately named merge inputs',()=>{
 const edges=Array.from({length:12},(_,i)=>({id:`e${i}`,source:`s${i}`,target:'merge',label:`case${i}`}));
 const names=Object.fromEntries(edges.map((e,i)=>[e.source,`Team ${i}`]));
 const merge=workflowPorts('merge','merge',[],edges,names);
 expect(merge.inputs.length).toBe(12);expect(new Set(merge.inputs.map(p=>p.id)).size).toBe(12);expect(merge.inputs[10].label).toContain('Team 10');expect(merge.inputs[10].label).toContain('case10');
 const sw=workflowPorts('switch','switch',['HR','IT','default'],[],{});expect(sw.outputs.map(p=>p.id)).toEqual(['out:HR','out:IT','out:default']);
 });
 it('preserves each branch semantic including unconfigured historical labels',()=>{
 expect(workflowPorts('if','if',['true','false'],[{id:'old',source:'if',target:'b',label:'legacy'}],{}).outputs.map(p=>p.branch)).toEqual(['true','false','legacy']);
 expect(workflowPorts('loop','loop',['each','done'],[],{}).outputs.map(p=>p.branch)).toEqual(['each','done']);
 expect(branchStyle('false').kind).not.toBe(branchStyle('error').kind);expect(branchStyle('false').dash).toBeTruthy();expect(branchStyle('true').text).toContain('True');
 });
 it('keeps existing parallel links from one source as distinct inputs',()=>{
 const ports=workflowPorts('merge','merge',[],[{id:'a',source:'s',target:'merge',label:'true'},{id:'b',source:'s',target:'merge',label:'false'}],{s:'Condition'});
 expect(ports.inputs.map(p=>p.id)).toEqual(['in:a','in:b']);expect(ports.inputs.map(p=>p.branch)).toEqual(['true','false']);expect(ports.inputs[0].label).not.toBe(ports.inputs[1].label);
 });
 it('offers a normal input/output for empty roots without persisting any handle IDs',()=>{
 const p=workflowPorts('m','merge',[],[],{});expect(p.inputs[0].id).toBe('in');expect(p.outputs[0].id).toBe('out:');expect(branchStyle().text).toBe('Main flow');
 });
});
