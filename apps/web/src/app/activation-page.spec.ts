import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ActivationPage } from './activation-page';
import { Session } from './session';
import { ActivationRecord } from './api';

const rows: ActivationRecord[] = [
  { seq:1,commit:'aaaaaaaa',state:'applied' },
  { seq:2,commit:'bbbbbbbb',state:'failed',recordedAt:'2026-11-23T14:00:00Z',actor:{kind:'user',id:'alice'},error:'Core refused activation' }
];
function setup(status: object = {status:'confirmed',core:{seq:1,commit:'aaaaaaaa'},main:'bbbbbbbb',matchesMain:false,checkedAt:'2026-11-23T15:00:00Z'}) {
  const api={activationJournal:vi.fn(async()=>rows),activationStatus:vi.fn(async()=>status),raw:vi.fn(async()=>({status:200,data:{message:'Reviewed changes',author:'commit-author',date:'2026-11-22T12:00:00Z'}}))};
  TestBed.configureTestingModule({providers:[{provide:Session,useValue:{api,adminToken:signal('')}}]});
  const f=TestBed.createComponent(ActivationPage); f.detectChanges();
  return {f,api};
}
describe('Activation read-only audit page',()=>{
  it('shows newest first, truthful current version, unknown old metadata and no activation button',async()=>{
    const {f,api}=setup();await vi.waitFor(()=>expect(f.componentInstance.loading()).toBe(false));f.detectChanges();f.detectChanges();
    const text=f.nativeElement.textContent;
    expect(text).toContain('Main differs from the active version');
    expect(text).toContain('Recorded date unavailable');expect(text).toContain('Unavailable · not recorded');
    const entries=f.nativeElement.querySelectorAll('.entry');
    expect(entries[0].textContent).toContain('#2');expect(entries[1].textContent).toContain('Current live version');
    expect(entries[0].textContent).not.toContain('Current live version');
    expect([...f.nativeElement.querySelectorAll('button')].map((b:any)=>b.textContent.trim())).toEqual(['Refresh']);
    expect(api.raw).not.toHaveBeenCalled();
  });
  it('filters history and labels failed entries',async()=>{
    const {f}=setup();await vi.waitFor(()=>expect(f.componentInstance.loading()).toBe(false));f.detectChanges();f.componentInstance.filter.set('failed');f.detectChanges();
    expect(f.nativeElement.querySelectorAll('.entry').length).toBe(1);expect(f.nativeElement.textContent).toContain('Core refused activation');
  });
  it('does not use the latest applied record as a substitute for unavailable live state',async()=>{
    const {f}=setup({status:'unavailable',core:null,main:'bbbbbbbb',checkedAt:'2026-11-23T15:00:00Z'});await vi.waitFor(()=>expect(f.componentInstance.loading()).toBe(false));f.detectChanges();f.detectChanges();
    expect(f.nativeElement.textContent).toContain('Live state unavailable');expect(f.nativeElement.textContent).not.toContain('Current live version');
  });
  it('keeps live state when history cannot be read',async()=>{
    const {f,api}=setup();await vi.waitFor(()=>expect(f.componentInstance.loading()).toBe(false));f.detectChanges();api.activationJournal.mockRejectedValueOnce(new Error('offline'));
    await f.componentInstance.load();f.detectChanges();expect(f.nativeElement.textContent).toContain('history could not be read');expect(f.nativeElement.textContent).toContain('Confirmed live');
  });
  it('loads only read APIs on demand and never fabricates a first interval',async()=>{
    const {f,api}=setup();await vi.waitFor(()=>expect(f.componentInstance.loading()).toBe(false));f.detectChanges();
    await f.componentInstance.openDetails(rows[0],{target:{open:true}} as unknown as Event);f.detectChanges();
    expect(api.raw).toHaveBeenCalledWith('GET','/versioning/commits/aaaaaaaa',undefined,{'x-api-admin-token':''});
    expect(f.nativeElement.textContent).toContain('initial change interval cannot be reconstructed');
    expect(f.nativeElement.textContent).toContain('not who activated it');
  });
});
