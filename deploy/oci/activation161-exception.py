"""Explicit closed-qualification exception. No queue, gate, policy or updater effects."""
import json,hashlib,copy,importlib.util,os
from pathlib import Path
IMAGE='ghcr.io/manudss/iam-platform-poc@sha256:455e2556b74fb2abc9e55f0868144ecc1daa3d9a4743c36ffce400845544a273'
HERE=Path(__file__).resolve().parent
NAMES=['actor_id','actor_kind','applied_at']
CODE=['qualification.py','qualification-container.mjs','activation161-exception.py','activation161-capture.sql','activation161-column-metadata.json']
def sha(raw):return hashlib.sha256(raw).hexdigest()
def read(path):
 raw=Path(path).read_bytes();return json.loads(raw),sha(raw)
def pins(manifest,original):
 if read(original)[1]!=manifest['before_sha256'] or read(manifest['policy_file'])[1]!=manifest['policy_sha256']:raise ValueError('original evidence or policy changed')
 if set(manifest['code_sha256'])!=set(CODE):raise ValueError('complete code pins required')
 for name in CODE:
  if sha((HERE/name).read_bytes())!=manifest['code_sha256'][name]:raise ValueError('code changed')
 incident,ih=read(manifest['incident_file'])
 if ih!=manifest['incident_sha256'] or incident!=manifest['original_incident']:raise ValueError('incident changed')
 if incident.get('pending',{}).get('digest')!=IMAGE.split('@')[1] or incident.get('failed',{}).get('sha')!=incident.get('pending',{}).get('sha'):raise ValueError('wrong incident target')
 if incident.get('failed',{}).get('digest',incident['pending']['digest'])!=incident['pending']['digest'] or incident['pending'].get('parent')!=incident.get('history',[{}])[-1].get('sha'):raise ValueError('inconsistent failed pending parent/digest')
 if incident['pending']['sha']!=manifest['source_sha']:raise ValueError('wrong source')
 return True
class ExceptionRun:
 def __init__(self,path,expected_sha,before,policy_path,image,phase,output):
  self.manifest_path=Path(path);self.manifest,self.manifest_sha=read(path);m=self.manifest;self.before=Path(before);self.output=Path(output)
  if phase!='after' or image!=IMAGE or m.get('format')!=1 or m.get('kind')!='reviewed-activation161-closed' or self.manifest_sha!=expected_sha or m.get('image')!=IMAGE:raise ValueError('explicit exact exception manifest required')
  if not isinstance(m.get('authorization_ref'),str) or not m['authorization_ref'].strip() or not isinstance(m.get('evidence_refs'),list) or not m['evidence_refs'] or any(not isinstance(x,str)or not x.strip() for x in m['evidence_refs']) or Path(policy_path)!=Path(m['policy_file']):raise ValueError('reviewed authority/policy binding required')
  # An exclusive consumed agreement prevents automatic retries even after a failed attempt.
  pins(m,self.before)
  if self.output.exists():raise ValueError('fresh private exception directory required')
  self.output.mkdir(mode=0o700)
  claim=Path(m['one_shot_claim'])
  if not claim.is_absolute():raise ValueError('absolute one-shot claim required')
  fd=os.open(claim,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
  with os.fdopen(fd,'w')as f:f.write(self.manifest_sha+'\n');f.flush();os.fsync(f.fileno())
  self.policy,_=read(policy_path);self.capture_value=None
 def recheck(self):
  if read(self.manifest_path)[1]!=self.manifest_sha:raise ValueError('manifest changed')
  return pins(self.manifest,self.before)
 def capture(self,runner):
  # One psql session/TX for schema, all tables, sequences and activation hash pairs.
  p=self.policy
  raw=runner(['docker','exec','-i',p['pgContainer'],'psql','-X','-A','-t','-q','-v','ON_ERROR_STOP=1','-U',p['pgUser'],'-d',p['pgDatabase']],input=(HERE/'activation161-capture.sql').read_text())
  c=json.loads(raw)
  if c.get('format')!=1 or c.get('transaction',{}).get('read_only')is not True or c['transaction'].get('isolation')!='repeatable read' or not c['transaction'].get('snapshot'):raise ValueError('required snapshot transaction absent')
  self.capture_value=copy.deepcopy(c);return c['postgres']
 def verify(self,before,after,compare):
  self.recheck();c=self.capture_value
  if not c or c['postgres']!=after['postgres'] or before.get('policyHash')!=self.manifest['policy_sha256'] or after.get('policyHash')!=before['policyHash'] or after.get('image')!=IMAGE:raise ValueError('capture/after/original binding mismatch')
  old=before['postgres']['schema'];new=after['postgres']['schema'];expected=json.loads((HERE/'activation161-column-metadata.json').read_text())
  oldcols=old['columns'];remaining=[];added=[]
  for col in new['columns']:
   (added if col.get('table_schema')=='public' and col.get('table_name')=='activations' and col.get('column_name')in NAMES else remaining).append(col)
  if remaining!=oldcols or len(added)!=3:raise ValueError('nonexact column delta')
  legacycols=[x for x in oldcols if x['table_schema']=='public' and x['table_name']=='activations']
  maxord=max(x['ordinal_position']for x in legacycols);catalogs={x['table_catalog']for x in legacycols}
  for i,e in enumerate(expected,1):
   actual=next((x for x in added if x['column_name']==e['column_name']),None)
   if not actual or actual['ordinal_position']!=maxord+i or actual['table_catalog']not in catalogs:raise ValueError('new column position/catalog mismatch')
   actual={k:v for k,v in actual.items()if k not in ['table_catalog','ordinal_position']}
   if actual!=e:raise ValueError('new column metadata mismatch')
  schema=copy.deepcopy(new);schema['columns']=remaining
  if schema!=old:raise ValueError('other schema change')
  projection=c['projection'];whole={};legacy={}
  for pair in projection['pairs']:
   n=pair['multiplicity']
   if type(n)is not int or n<1 or any(not isinstance(pair[k],str)or len(pair[k])!=64 for k in ['whole','legacy']):raise ValueError('invalid paired multiset')
   for key,target in [('whole',whole),('legacy',legacy)]:target[pair[key]]=target.get(pair[key],0)+n
  if whole!=after['postgres']['rows']['public.activations'] or legacy!=before['postgres']['rows']['public.activations'] or sum(whole.values())!=projection['row_count'] or type(projection['nonnull_new_columns'])is not int or projection['nonnull_new_columns']!=0:raise ValueError('legacy values/multiplicities/new values differ')
  normalized=copy.deepcopy(after);normalized['postgres']['schema']=copy.deepcopy(old);normalized['postgres']['rows']['public.activations']=legacy
  if compare(before,normalized,self.policy):raise ValueError('non-target preservation failed')
  self.recheck()
  return True
 def save(self,writer,before,after,smoke,compare):
  self.verify(before,after,compare)
  # Every file belongs to this run; hashes bind capture and after without preinventing either.
  for name,value in [('after.json',after),('smoke.json',smoke),('capture.json',self.capture_value)]:writer(self.output/name,value)
  self.recheck()
  hashes={name:sha((self.output/name).read_bytes())for name in ['after.json','smoke.json','capture.json']}
  writer(self.output/'closed-exception-result.json',{'format':'activation161-closed-exception-v1','type':'closed-qualification-only','result':'verified-with-reviewed-exception-no-opening','image':IMAGE,'before_sha256':self.manifest['before_sha256'],'policy_sha256':self.manifest['policy_sha256'],'exception_manifest_sha256':self.manifest_sha,'files':hashes,'queue_compatible':False})
