#!/usr/bin/env python3
"""Read-only schema-specific restoration evidence diagnostic. Never admits release.
No invented historical baseline, no bus catch-up claim. Operator stages a spec
binding exact files already captured independently. No app/system mutations.
"""
import argparse,hashlib,json,os,re,stat,sys
from pathlib import Path
STAGE='init'
def stage(value):
 global STAGE
 STAGE=value

def read(binding):
 if not isinstance(binding,dict) or set(binding)!={'path','sha256'} or not re.fullmatch('[a-f0-9]{64}',binding['sha256']):raise ValueError('exact file binding required')
 p=Path(binding['path'])
 if not p.is_absolute() or '..' in p.parts:raise ValueError('absolute evidence required')
 for q in [p,*p.parents]:
  s=q.lstat()
  if q.is_symlink() or s.st_uid or s.st_gid or s.st_mode&0o022:raise ValueError('protected evidence required')
 if not p.is_file() or p.stat().st_nlink!=1 or p.stat().st_size>64*1024*1024:raise ValueError('bounded unique file required')
 raw=p.read_bytes()
 if hashlib.sha256(raw).hexdigest()!=binding['sha256']:raise ValueError('evidence changed')
 return json.loads(raw)

def evaluate(v):
 required={'pg_restoration','bao_restoration','dolt_before','dolt_after','postrotation_stores','postrotation_bao_same_serializer','bus_before','bus_after','rotation_smoke','closed_launch'}
 if set(v)!=required:raise ValueError('complete exact restoration evidence categories required')
 blockers=[];results={}
 stage('cold-pg');pg=v['pg_restoration']
 if set(pg)!={'before','after'} or pg['before']!=pg['after']:raise ValueError('cold PostgreSQL restoration differs')
 requiredpg={'rows','schema','sequences','sequenceDefinitions'}
 if set(pg['before'])!=requiredpg:raise ValueError('PostgreSQL capture schema unknown')
 stage('cold-bao');bao=v['bao_restoration']
 if set(bao)!={'before','after'} or bao['before']!=bao['after'] or not bao['before']:raise ValueError('Bao cold restoration differs or empty')
 if v['postrotation_bao_same_serializer']!=bao['after']:raise ValueError('Bao postrotation differs under original serializer')
 results['bao_same_serializer_exact']=True;results['pg_cold_exact']=True
 def dolt(rows):
  if not isinstance(rows,list) or len(rows)!=8 or any(set(x)!={'database','branch','head','root'} for x in rows):raise ValueError('exact known Dolt eight-ref schema required')
  keys=[(x['database'],x['branch']) for x in rows]
  if len(set(keys))!=len(keys):raise ValueError('Dolt duplicate ref')
  return {k:x for k,x in zip(keys,rows)}
 stage('dolt-refs');before,after=dolt(v['dolt_before']),dolt(v['dolt_after'])
 if set(before)!=set(after):raise ValueError('Dolt ref coverage changed')
 changes=[k for k in before if before[k]!=after[k]]
 if changes!=[('iam_meta','main')] or before[('iam_meta','main')]['head']!=after[('iam_meta','main')]['head']:raise ValueError('Dolt restoration change not sole metadata working root')
 blockers.append('metadata-working-root-migration-requires-direct-reviewed-verifier')
 stage('postrotation-stores');post=v['postrotation_stores']
 if set(post)!={'bao','dolt','postgres'} or dolt(post['dolt'])!=after:raise ValueError('postrotation Dolt differs or schema unknown')
 # The Node Bao capture is deliberately NOT compared with Python serialization.
 results['dolt_business_refs_exact']=7;results['dolt_postrotation_exact']=True
 a,b=pg['after'],post['postgres']
 if set(b)!=requiredpg or a['schema']!=b['schema'] or a['sequenceDefinitions']!=b['sequenceDefinitions'] or set(a['rows'])!=set(b['rows']) or set(a['sequences'])!=set(b['sequences']):raise ValueError('postrotation PG schema or objects differ')
 for table,rows in a['rows'].items():
  current=b['rows'][table]
  if table=='public.decision_audit':
   if any(type(n) is not int or n<1 for n in [*rows.values(),*current.values()]) or any(current.get(h,0)<n for h,n in rows.items()):raise ValueError('old audit multiset not preserved')
  elif rows!=current:raise ValueError('non-audit PG rows changed')
 audit_added=sum(b['rows'].get('public.decision_audit',{}).values())-sum(a['rows'].get('public.decision_audit',{}).values())
 for name,seq in a['sequences'].items():
  now=b['sequences'][name]
  if name=='public.decision_audit_id_seq':
   if set(seq)!=set(now) or set(seq)!={'last_value','is_called'} or type(seq['last_value']) is not int or type(now['last_value']) is not int or now['last_value']<seq['last_value'] or seq['is_called'] and not now['is_called']:raise ValueError('audit sequence rewind')
  elif seq!=now:raise ValueError('non-audit sequence changed')
 seqname='public.decision_audit_id_seq'
 if seqname not in a['sequences'] or seqname not in b['sequences']:raise ValueError('audit sequence absent')
 delta=b['sequences'][seqname]['last_value']-a['sequences'][seqname]['last_value']
 if not 0<=audit_added<=10000 or not audit_added<=delta<=10000:raise ValueError('audit sequence delta incoherent or beyond bound')
 results.update(audit_added_rows=audit_added,audit_sequence_delta=delta,audit_sequence_unused_delta=delta-audit_added)
 blockers.append('audit-additions-need-explanation-and-fresh-epoch')
 def bus(rows,prior):
  if not isinstance(rows,list) or len(rows)!=3:raise ValueError('exact three-stream bus coverage required')
  out={}
  for row in rows:
   if set(row)!={'name','messages','consumers'} or row['name'] in out or type(row['messages']) is not int:raise ValueError('bus stream schema differs')
   consumers={}
   for c in row['consumers']:
    expected={'name','pending','ack','redelivered'} if prior else {'name','pending','ack'}
    if set(c)!=expected or c['name'] in consumers or c['pending']!=0 or c['ack']!=0:raise ValueError('bus consumer unresolved or schema unknown')
    consumers[c['name']]=c
   out[row['name']]={'messages':row['messages'],'consumers':consumers}
  return out
 stage('bus-coverage');bb,ba=bus(v['bus_before'],True),bus(v['bus_after'],False)
 if set(bb)!=set(ba):raise ValueError('bus stream coverage changed')
 deltas={}
 for name in bb:
  if set(bb[name]['consumers'])!=set(ba[name]['consumers']):raise ValueError('bus consumer coverage changed')
  delta=ba[name]['messages']-bb[name]['messages']
  if delta<0:raise ValueError('bus message count decreased')
  deltas[name]=delta
 results['bus_message_deltas']=deltas
 blockers+=['bus-after-redelivered-not-captured','bus-message-additions-unattributed','bus-counts-not-payload-or-cursor-preservation','bus-no-external-catchup-proof']
 stage('unverified-prior-flags');smoke=v['rotation_smoke']
 if not isinstance(smoke.get('journal'),dict) or smoke.get('held') is not True or smoke.get('workflowPreserved') is not True or not smoke.get('ledger'):raise ValueError('existing rotation smoke incomplete')
 launch=v['closed_launch']
 if launch.get('launchedHeldCandidate') is not True or launch.get('ipv6DisabledProved') is not True:raise ValueError('existing held launch observation incomplete')
 results['prior_rotation_smoke']='flags-only-not-executed-or-verified-by-this-diagnostic'
 results['prior_closed_launch']='flags-only-not-executed-or-verified-by-this-diagnostic'
 blockers+=['current-fixed-closed-postcheck-not-yet-executed-by-controller','fresh-same-epoch-smoke-TLS-not-yet-executed','historical-TLS-baseline-absent-retain-in-audit']
 return {'format':1,'kind':'restored-evidence-diagnostic','admissible':False,'effect_authority':False,'original_anchor':'operator-file-hash-currently-observed-not-independent-provenance','checks':results,'blockers':blockers}

def main():
 p=argparse.ArgumentParser();p.add_argument('--spec',required=True);a=p.parse_args()
 # Spec itself gets no automatic provenance: it only routes protected hash reads.
 spec_path=Path(a.spec);spec=read({'path':str(spec_path),'sha256':hashlib.sha256(spec_path.read_bytes()).hexdigest()})
 values={}
 for key,binding in spec.items():
  if key not in {'pg_restoration','bao_restoration','dolt_before','dolt_after','postrotation_stores','postrotation_bao_same_serializer','bus_before','bus_after','rotation_smoke','closed_launch'}:raise ValueError('unknown category')
  stage('read-'+key.replace('_','-'));values[key]=read(binding)
 result=evaluate(values);print(json.dumps(result,sort_keys=True));return 2
if __name__=='__main__':
 try:sys.exit(main())
 except Exception:
  print('RESTORED_EVIDENCE_REFUSED '+STAGE,file=sys.stderr);sys.exit(1)
