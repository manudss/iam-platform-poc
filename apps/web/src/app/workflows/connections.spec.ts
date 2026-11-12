import {probeFor,visibleConnections} from './connections';
import {WorkflowConnection} from './wf-model';
const c: WorkflowConnection = {id:'jira-1',name:'Support',provider:'jira',config:{},revision:'r1',secretConfigured:true,status:'Needs test'};
describe('managed connection list',()=>{
 it('searches provider and name without altering the source',()=>{expect(visibleConnections([c],' JIRA ')).toEqual([c]);expect(visibleConnections([c],'support')).toEqual([c]);expect(visibleConnections([c],'Google')).toEqual([]);});
 it('shows only a probe of the current revision',()=>{const p={id:c.id,revision:'r1',status:'Verified',checkedAt:'now',readOnly:true};expect(probeFor(c,{[c.id]:p})).toEqual(p);expect(probeFor({...c,revision:'r2'},{[c.id]:p})).toBeNull();});
});
