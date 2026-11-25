#!/usr/bin/env python3
"""Pure original-to-current preservation bridge. No I/O, grants or execution.
Hash-bound actual files are admission controller responsibility. Unknown schema or
unaccounted policy drift refuses. This module cannot make adoption executable.
"""
import hashlib,json,re
STORE_KEYS={'dolt','bao','credentials','postgres','migrationLedger'}
POLICY_LOCATION_KEYS={'network','pgContainer','baoAddress','baoTokenFile','authFile'}

def digest(raw):return hashlib.sha256(raw).hexdigest()
def policy_bridge(old,new,relocations):
 if set(old)!=set(new):raise ValueError('policy key coverage changed')
 if not isinstance(relocations,dict) or not set(relocations)<=POLICY_LOCATION_KEYS:raise ValueError('only explicit location policy changes supported')
 for k in old:
  if k in relocations:
   binding=relocations[k]
   if not isinstance(binding,dict) or set(binding)!={'before','after'} or binding['before']!=old[k] or binding['after']!=new[k]:raise ValueError('policy relocation binding differs')
  elif old[k]!=new[k]:raise ValueError('nonlocation policy change refused')
 # Origin set is deliberately unchanged, including legacy compatibility SNI.
 if old.get('origins')!=new.get('origins') or not old.get('origins'):raise ValueError('origin coverage changed')
 if old.get('requireAutomationHold') is not True or new.get('requireAutomationHold') is not True:raise ValueError('held policies required')
 if old.get('appendOnlyTables')!=['public.activations','public.decision_audit'] and old.get('appendOnlyTables')!=['public.decision_audit','public.activations']:raise ValueError('exact known append coverage required')
 return {k:relocations[k] for k in sorted(relocations)}

def bridge(original_raw,current_raw,old_policy_raw,new_policy_raw,relocations):
 original=json.loads(original_raw);current=json.loads(current_raw);old=json.loads(old_policy_raw);new=json.loads(new_policy_raw)
 changes=policy_bridge(old,new,relocations)
 if original.get('policyHash')!=digest(old_policy_raw) or current.get('policyHash')!=digest(new_policy_raw):raise ValueError('snapshot policy hash differs')
 if current.get('kind')!='held-running-baseline' or current.get('epoch')!='postrotation-current' or current.get('originalPreservationReplaced') is not False:raise ValueError('explicit current baseline required')
 # Unknown future capture categories must be accounted for explicitly.
 common=STORE_KEYS|{'image','policyHash','transportCoverage'}
 if set(original)!=common or set(current)!=(common|{'kind','epoch','originalPreservationReplaced'}):raise ValueError('snapshot category schema changed')
 if original['image']!=current['image'] or original['transportCoverage']!=current['transportCoverage'] or original['transportCoverage']!='TLS_EXPECTED_ORIGINS':raise ValueError('image or transport coverage changed')
 for key in ('dolt','bao','credentials','migrationLedger'):
  if original[key]!=current[key]:raise ValueError('exact preserved category changed: '+key)
 a,b=original['postgres'],current['postgres']
 if set(a)!=set(b) or set(a)!={'rows','schema','sequences','sequenceDefinitions'}:raise ValueError('postgres coverage schema differs')
 if a['schema']!=b['schema'] or a['sequenceDefinitions']!=b['sequenceDefinitions'] or set(a['rows'])!=set(b['rows']) or set(a['sequences'])!=set(b['sequences']):raise ValueError('postgres object coverage changed')
 for table,rows in a['rows'].items():
  now=b['rows'][table]
  if table=='public.decision_audit':
   if not isinstance(rows,dict) or not isinstance(now,dict) or any(type(n) is not int or n<1 for n in [*rows.values(),*now.values()]):raise ValueError('audit multiset invalid')
   if any(now.get(h,0)<n for h,n in rows.items()):raise ValueError('original audit row lost')
  elif rows!=now:raise ValueError('non-audit rows changed')
 for name,seq in a['sequences'].items():
  now=b['sequences'][name]
  if name=='public.decision_audit_id_seq':
   if set(seq)!=set(now) or set(seq)!={'last_value','is_called'} or type(seq['last_value']) is not int or type(now['last_value']) is not int or now['last_value']<seq['last_value'] or type(seq['is_called']) is not bool or type(now['is_called']) is not bool or seq['is_called'] and not now['is_called']:raise ValueError('audit sequence rewind or invalid')
  elif seq!=now:raise ValueError('non-audit sequence changed')
 return {'format':1,'kind':'original-current-preservation-bridge','original_sha256':digest(original_raw),'current_sha256':digest(current_raw),'old_policy_sha256':digest(old_policy_raw),'new_policy_sha256':digest(new_policy_raw),'policy_relocations':changes,'origin_coverage':'unchanged-including-legacy-SNI','allowed_store_change':'decision-audit-append-and-sequence-only','effect_authority':False}
