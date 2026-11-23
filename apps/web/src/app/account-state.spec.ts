import { activeBlocks, accountState, matchesAccount } from './account-state';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Session } from './session';
import { UsersPage } from './users';
import { UserAccountBlocks } from './user-account-blocks';
const status = { published: true, loginEnabled: true, hasCredential: true, blocks: [{kind:'suspended',hold:true,until:1},{kind:'locked',until:200}] };
describe('directory live account state', () => {
  it('does not hide coexistence and excludes expired locks, except held ones', () => {
    expect(activeBlocks(status.blocks,200).map(b=>b.kind)).toEqual(['suspended']);
    expect(matchesAccount(status,'blocked','locked',199)).toBe(true);
    expect(matchesAccount(status,'blocked','locked',200)).toBe(false);
    expect(matchesAccount(status,'blocked','suspended',200)).toBe(true);
    expect(matchesAccount(status,'clear','',200)).toBe(false);
  });
  it('never calls missing/unpublished or restricted sign-in accounts enabled', () => {
    expect(accountState(undefined,0)).toBe('State unavailable');
    expect(matchesAccount(undefined,'clear','',0)).toBe(false);
    expect(matchesAccount({...status,published:false},'clear','',0)).toBe(false);
    expect(accountState({...status,blocks:[],loginEnabled:false},0)).toBe('Sign-in disabled');
    expect(accountState({...status,blocks:[],hasCredential:false},0)).toBe('No credential');
    expect(accountState({...status,blocks:[]},0)).toBe('Not blocked');
  });
});
describe('embedded live security controls',()=>{
  const block={id:'b-1',kind:'suspended',message:'Fictional review',origin:'workflow',setBy:'run-1',setAt:1,hold:true,reference:'BLK-B1'};
  let page:UserAccountBlocks, calls:any[],testBranch:ReturnType<typeof signal<string>>, pending:((r:any)=>void)[];
  beforeEach(()=>{
    calls=[];pending=[];testBranch=signal('');
    TestBed.configureTestingModule({providers:[{provide:Session,useValue:{testBranch,adminToken:()=>'',api:{identity:'admin',raw:async(method:string,path:string,body:any)=>{
      calls.push({method,path,body});
      if(method==='GET') return {status:200,data:{kinds:['suspended','locked'],labels:{suspended:'Suspended'},messageMax:300,accounts:[{subject:'fictional-user',blocks:[block]}]}};
      return {status:200,data:{}};
    }}}}]});
    page=TestBed.runInInjectionContext(()=>new UserAccountBlocks());page.userId='fictional-user';
  });
  afterEach(()=>page.ngOnDestroy());
  it('does not write until confirmation, binds the target without typed ID, and lifts only the selected block',async()=>{
    await page.load();page.message='Review needed';page.confirmBlock();expect(calls.filter(c=>c.method!=='GET')).toHaveLength(0);
    await page.execute();expect(calls.find(c=>c.method==='POST')).toEqual({method:'POST',path:'/accounts/fictional-user/blocks',body:{kind:'suspended',message:'Review needed',hold:false}});
    page.confirmLift(block);await page.execute();expect(calls.find(c=>c.method==='DELETE').path).toBe('/accounts/fictional-user/blocks/b-1');
  });
  it('refuses self block, branch-test changes and a confirmation for a different user',async()=>{
    await page.load();page.message='Review';page.confirmBlock();page.userId='other-user';await page.execute();
    page.userId='admin';page.confirmation.set(null);page.confirmBlock();expect(page.confirmation()).toBeNull();
    page.userId='fictional-user';testBranch.set('test');page.confirmBlock();page.confirmLift(block);await page.execute();expect(calls.filter(c=>c.method!=='GET')).toHaveLength(0);
  });
  it('rejects stale loads after changing the target and fails closed after an uncertain write',async()=>{
    const s=TestBed.inject(Session);s.api.raw=(()=>new Promise(resolve=>pending.push(resolve))) as any;
    const first=page.load();page.userId='other-user';const second=page.load();pending[0]({status:200,data:{accounts:[{subject:'fictional-user',blocks:[block]}],kinds:[]}});await first;expect(page.ready()).toBe(false);
    pending[1]({status:403,data:{}});await second;expect(page.ready()).toBe(false);
    page.userId='fictional-user';s.api.raw=(async()=>({status:200,data:{accounts:[],kinds:['suspended']}})) as any;await page.load();page.message='Review';page.confirmBlock();
    s.api.raw=(async()=>{throw new Error('Network interrupted')}) as any;await page.execute();expect(page.ready()).toBe(false);expect(page.error()).toContain('no automatic retry');expect(page.confirmation()).toBeNull();
  });
});

describe('directory account status request isolation',()=>{
  it('ignores superseded and wrong-branch state, and unknown state does not pass clear filter',async()=>{
    const branch=signal('work-a'), pending:((r:any)=>void)[]=[];
    TestBed.configureTestingModule({providers:[{provide:Session,useValue:{branch,adminToken:()=>'',api:{raw:()=>new Promise(resolve=>pending.push(resolve))}}}]});
    const page=TestBed.runInInjectionContext(()=>new UsersPage()) as any;
    const first=page.loadAccountStates(),second=page.loadAccountStates();
    pending[0]({status:200,data:{asOf:100,accounts:{old:status}}});await first;expect(page.accountStates().asOf).toBe(0);
    branch.set('work-b');pending[1]({status:200,data:{asOf:200,accounts:{wrong:status}}});await second;expect(page.accountStates().asOf).toBe(0);
    expect(page.liveState('wrong')).toBe('State unavailable');page.ngOnDestroy();
  });
});
