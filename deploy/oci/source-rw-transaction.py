#!/usr/bin/env python3
"""Draft source-RW transaction core, no CLI and no Docker implementation.
A reviewed fixed adapter owns all live checks. This module never authorizes use.
Old containers remain stopped. Archives, not old container IDs, are the data baseline.
"""
import hashlib,json,re

def digest(value):
 return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()

def validate(plan):
 required={'format','kind','engagement','baseline','target','old','new','stores','env','policy','runtime','code','updater'}
 if set(plan)!=required or plan['format']!=1 or plan['kind']!='source-rw-normal-transaction':raise ValueError('exact source-RW plan required')
 if not re.fullmatch(r'[a-zA-Z0-9-]{8,48}',plan['engagement']):raise ValueError('bounded fresh engagement required')
 if set(plan['target'])!={'sha','digest'} or not re.fullmatch('[a-f0-9]{40}',plan['target']['sha']) or not re.fullmatch('sha256:[a-f0-9]{64}',plan['target']['digest']):raise ValueError('immutable target required')
 for group in ('baseline','env','policy','runtime'):
  b=plan[group]
  if set(b)!={'path','sha256'} or not b['path'].startswith('/') or '..' in b['path'].split('/') or not re.fullmatch('[a-f0-9]{64}',b['sha256']):raise ValueError('exact protected binding required')
 if set(plan['old'])!={'app','pg','bao'} or set(plan['new'])!={'app','pg','bao'} or set(plan['stores'])!={'dolt','pg','bao'}:raise ValueError('three stores and writers required')
 ids=[];names=[]
 for generation in ('old','new'):
  for role in ('app','pg','bao'):
   b=plan[generation][role]
   if set(b)!={'name','id','image_id'} or not re.fullmatch('[a-f0-9]{64}',b['id']) or not re.fullmatch('sha256:[a-f0-9]{64}',b['image_id']) or not re.fullmatch('[a-zA-Z0-9_.-]{1,64}',b['name']):raise ValueError('exact full writer identity required')
   ids.append(b['id']);names.append(b['name'])
 if len(set(ids))!=6 or len(set(names))!=6:raise ValueError('fresh names and full IDs required')
 if plan['updater'].get('container')!=plan['new']['app']['name'] or plan['updater'].get('runtime')!=plan['runtime'] or plan['updater'].get('target')!=plan['target']:raise ValueError('updater target must match transaction')
 if not plan['code'] or any(not re.fullmatch('[a-f0-9]{64}',v) for v in plan['code'].values()):raise ValueError('pinned code required')
 for p in plan['stores'].values():
  if not isinstance(p,str) or not p.startswith('/') or '..' in p.split('/'):raise ValueError('exact source directories required')
 if len(set(plan['stores'].values()))!=3:raise ValueError('distinct source stores required')
 return digest(plan)

def commit(plan,adapter,journal):
 """All new containers already wait behind FIFO, app ID exists before permit.
 adapter.inspect_prepared must verify mount/namespace/resource/FIFO/network/env
 facts live, including no source access before each guarded entrypoint. journal
 provides exclusive-new fsynced create and fsynced append; failed writes abort.
 Any ambiguous or partially released attempt is operator-owned, never retried.
 """
 sha=validate(plan)
 # Live checks must precede any durable source effect commitment.
 adapter.locks();adapter.closed();adapter.bindings(plan)
 adapter.inspect_prepared(plan)
 adapter.single_writer(plan)
 journal.create({'kind':'source-rw-prepared','plan':plan,'plan_sha256':sha,'source_effects_committed':False})
 def verify():
  if validate(plan)!=sha:raise ValueError('source-RW plan mutated')
  adapter.locks();adapter.closed();adapter.bindings(plan)
 try:
  verify();adapter.inspect_prepared(plan);adapter.single_writer(plan)
  # This is the effect commit, BEFORE the first companion permit, not app start.
  journal.append({'phase':'source-effects-committed','plan_sha256':sha,'source_effects_committed':True})
  for role in ('pg','bao'):
   verify();adapter.check_permit(plan,role)
   journal.append({'phase':'permit-intent','role':role,'id':plan['new'][role]['id'],'plan_sha256':sha})
   adapter.permit(plan,role)
   journal.append({'phase':'permit-returned','role':role,'id':plan['new'][role]['id'],'plan_sha256':sha})
  adapter.companions_ready(plan)
  verify();adapter.check_permit(plan,'app')
  journal.append({'phase':'permit-intent','role':'app','id':plan['new']['app']['id'],'plan_sha256':sha})
  adapter.permit(plan,'app')
  journal.append({'phase':'permit-returned','role':'app','id':plan['new']['app']['id'],'plan_sha256':sha})
  # Does not open gates, finalize pause, write queue history, or claim health.
  return {'plan_sha256':sha,'source_effects_committed':True,'app_permit_returned':True,'requires_normal_qualification':True}
 except BaseException:
  # No restart, restore, compensation or duplicate permit. Even closure may fail.
  adapter.close_on_failure()
  raise
