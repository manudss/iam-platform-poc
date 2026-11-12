import {AfterViewInit, Component, ElementRef, HostListener, OnDestroy, effect, input, output, signal, viewChild} from '@angular/core';
/** Fits whole chips and reserves room for the overflow count. */
export function fittingTags(widths:number[], available:number, overflowWidth:(count:number)=>number, gap=6):number {
  if(!widths.length)return 0;
  if(widths.reduce((s,w)=>s+w,0)+gap*(widths.length-1)<=available)return widths.length;
  let used=0,count=0;
  for(let i=0;i<widths.length;i++){
    const next=used+(i?gap:0)+widths[i];
    if(next+gap+overflowWidth(widths.length-i-1)>available)break;
    used=next;count++;
  }
  return count;
}
@Component({selector:'app-workflow-card-tags',template:`
<div class="tag-row" #row>
 @for(t of tags().slice(0,visible());track t){<button class="tag" [class.on]="selected()===t" (click)="choose.emit(t)" [title]="'Filter by #' + t">#{{t}}</button>}
 @if(visible()<tags().length){<span class="more" (mouseenter)="enter()" (mouseleave)="exit()" (focusout)="leave($event)"><button class="tag" [attr.aria-expanded]="open()" [attr.aria-label]="'Show ' + (tags().length-visible()) + ' more tags'" (focus)="open.set(true)" (click)="open.set(true)" (keydown.escape)="open.set(false)">+{{tags().length-visible()}}</button>
 @if(open()){<span class="tip" role="group" aria-label="More workflow tags">@for(t of tags().slice(visible());track t){<button class="tag" [class.on]="selected()===t" (click)="choose.emit(t);open.set(false)">#{{t}}</button>}</span>}</span>}
</div>
<div class="measure" aria-hidden="true" #measure>@for(t of tags();track t){<span class="tag">#{{t}}</span>}<span class="tag count">+{{tags().length}}</span></div>
`,styles:[`
:host{display:block;position:relative;min-width:0;width:100%;}
.tag-row{display:flex;align-items:center;gap:6px;flex-wrap:nowrap;min-width:0;height:28px;}
.tag{display:inline-flex;align-items:center;flex:0 0 auto;width:auto;max-width:100%;min-height:24px;margin:0;padding:2px 9px;border:1px solid transparent;border-radius:999px;background:var(--chip-bg);color:var(--muted);font:inherit;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer;}
.tag:hover,.tag:focus-visible{background:var(--accent);color:var(--accent-ink);border-color:var(--accent);}
.tag.on{border-color:var(--accent);color:var(--accent);background:var(--accent-soft);}
.more{flex:0 0 auto;display:flex;align-items:center;height:100%;}
.tip{position:absolute;top:100%;left:0;z-index:25;display:flex;flex-wrap:wrap;gap:6px;min-width:180px;width:max-content;max-width:min(280px,75vw);padding:10px;background:var(--card);border:1px solid var(--line);border-radius:var(--radius);box-shadow:0 6px 24px var(--shadow-color);max-height:240px;overflow-y:auto;}
.tip .tag{white-space:normal;overflow-wrap:anywhere;}
.measure{position:absolute;visibility:hidden;pointer-events:none;display:flex;width:max-content;gap:6px;height:0;overflow:hidden;}
` ]})
export class WorkflowCardTags implements AfterViewInit,OnDestroy {
 readonly tags=input<string[]>([]);readonly selected=input('');readonly choose=output<string>();
 protected visible=signal(0);protected open=signal(false);
 private closeTimer?:ReturnType<typeof setTimeout>;
 protected enter(){clearTimeout(this.closeTimer);this.open.set(true);}
 protected exit(){this.closeTimer=setTimeout(()=>this.open.set(false),150);}
 private row=viewChild<ElementRef<HTMLElement>>('row');private measure=viewChild<ElementRef<HTMLElement>>('measure');private observer?:ResizeObserver;
 constructor(private host:ElementRef<HTMLElement>){effect(()=>{this.tags();this.open.set(false);queueMicrotask(()=>this.fit());});}
 ngAfterViewInit(){this.observer=new ResizeObserver(()=>this.fit());this.observer.observe(this.row()!.nativeElement);this.fit();}
 @HostListener('document:click',['$event']) outside(event:MouseEvent){if(!this.host.nativeElement.contains(event.target as Node))this.open.set(false);}
 @HostListener('keydown.escape') escape(){this.open.set(false);}
 ngOnDestroy(){clearTimeout(this.closeTimer);this.observer?.disconnect();}
 protected leave(event:FocusEvent){if(!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node))this.open.set(false);}
 private fit(){const row=this.row()?.nativeElement,rack=this.measure()?.nativeElement;if(!row||!rack)return;const children=Array.from(rack.children) as HTMLElement[];const count=children.pop();if(!count)return;const widths=children.map(e=>e.getBoundingClientRect().width);this.visible.set(fittingTags(widths,row.clientWidth,()=>count.getBoundingClientRect().width));}
}
