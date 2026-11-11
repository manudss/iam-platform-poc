import {editedAction,managedProvider,simulatedAction} from './execution-policy';
describe('managed action confirmation',()=>{
 it('maps only the managed external providers',()=>{expect(managedProvider('jira-create-issue')).toBe('jira');expect(managedProvider('http-request')).toBe('http');expect(managedProvider('assign-role')).toBeNull();});
 it('resets Real on every action field or connection change without losing values',()=>{const c={connectionId:'a',executionMode:'real',realConfirmed:true,summary:'old'};expect(editedAction('jira-create-issue',c,'summary','new')).toEqual({...c,summary:'new',executionMode:'simulation',realConfirmed:false});expect(editedAction('http-request',c,'connectionId','b')['realConfirmed']).toBe(false);expect(c.realConfirmed).toBe(true);});
 it('does not change unrelated computed/data config',()=>{expect(editedAction('assign-role',{role:'a'},'role','b')).toEqual({role:'b'});expect(simulatedAction({executionMode:'real',realConfirmed:true})['realConfirmed']).toBe(false);});
});
