export interface WorkflowPort { id:string; label:string; branch?:string; kind:string }
export const logicType=(type:string)=>['if','switch','loop','merge'].includes(type);
export function branchStyle(label?:string):{text:string;kind:string;color:string;dash:string|null} {
 if(!label)return {text:'Main flow',kind:'main',color:'var(--muted)',dash:null};
 if(label==='true')return {text:'✓ True',kind:'true',color:'var(--ok)',dash:null};
 if(label==='false')return {text:'◇ False',kind:'false',color:'var(--accent)',dash:'7 5'};
 if(label==='each')return {text:'↻ Each',kind:'each',color:'var(--warn-line)',dash:null};
 if(label==='done')return {text:'→ Done',kind:'done',color:'var(--accent)',dash:'10 4'};
 if(label==='default')return {text:'◇ Default',kind:'default',color:'var(--muted)',dash:'3 5'};
 if(label==='error')return {text:'! On error',kind:'error',color:'var(--bad)',dash:'2 5'};
 return {text:`Case: ${label}`,kind:'case',color:'var(--accent)',dash:null};
}
export function workflowPorts(id:string,type:string,labels:string[],edges:{id:string;source:string;target:string;label?:string}[],names:Record<string,string>):{inputs:WorkflowPort[];outputs:WorkflowPort[]} {
 const incoming=edges.filter(e=>e.target===id);
 const inputs:WorkflowPort[]=logicType(type)&&incoming.length?incoming.map(e=>({id:`in:${e.id}`,label:(names[e.source]??e.source)+(e.label?' · '+branchStyle(e.label).text:''),kind:branchStyle(e.label).kind,branch:e.label})):[{id:'in',label:'Input',kind:'main'}];
 const raw=Array.from(new Set([...labels,...edges.filter(e=>e.source===id).map(e=>e.label??'')]));
 if(!raw.length)raw.push('');
 const outputs=raw.map(l=>({id:`out:${l}`,label:branchStyle(l).text,kind:branchStyle(l).kind,branch:l||undefined}));
 return {inputs,outputs};
}
