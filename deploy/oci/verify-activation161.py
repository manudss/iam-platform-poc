#!/usr/bin/env python3
"""Offline, digest-specific transformation check. No SQL, network or deployment effects.
Requires separately reviewed, pinned projection evidence from the operator.
"""
import importlib.util,json,hashlib,os,sys,copy
from pathlib import Path
spec=importlib.util.spec_from_file_location('qualification',Path(__file__).with_name('qualification.py'));q=importlib.util.module_from_spec(spec);spec.loader.exec_module(q)
IMAGE='ghcr.io/manudss/iam-platform-poc@sha256:455e2556b74fb2abc9e55f0868144ecc1daa3d9a4743c36ffce400845544a273'
ADDED={'actor_id':'text','actor_kind':'text','applied_at':'timestamp with time zone'}
def digest(raw):return hashlib.sha256(raw).hexdigest()
def counts(value):
 if not isinstance(value,dict) or any(not isinstance(k,str) or len(k)!=64 or any(c not in '0123456789abcdef' for c in k) or type(n)is not int or n<1 for k,n in value.items()):raise ValueError('invalid hash multiset')
 return value
def verify(before,after,proof,pin,before_hash,after_hash,proof_hash):
 if pin.get('format')!=1 or pin.get('image')!=IMAGE or after.get('image')!=IMAGE:raise ValueError('uncovered target image')
 if any(pin.get(k)!=v for k,v in {'before_sha256':before_hash,'after_sha256':after_hash,'projection_sha256':proof_hash}.items()):raise ValueError('missing or mismatched reviewed evidence pins')
 if not all(isinstance(x,str) and len(x)==64 for x in [before_hash,after_hash,proof_hash]):raise ValueError('invalid evidence pins')
 if pin.get('policyHash')!=before.get('policyHash') or before.get('policyHash')!=after.get('policyHash'):raise ValueError('policy changed')
 if proof.get('format')!=1 or proof.get('image')!=IMAGE or proof.get('before_sha256')!=before_hash or proof.get('after_sha256')!=after_hash or proof.get('removed_columns')!=list(ADDED):raise ValueError('projection evidence binding mismatch')
 # Require exact observed schema delta. Preserve every metadata field of all old columns.
 b=before['postgres']['schema'];a=after['postgres']['schema'];old=b['columns'];new=a['columns'];extra=[];remaining=[]
 for col in new:
  if col.get('table_schema')=='public' and col.get('table_name')=='activations' and col.get('column_name') in ADDED:extra.append(col)
  else:remaining.append(col)
 if remaining!=old or len(extra)!=3 or {c['column_name'] for c in extra}!=set(ADDED):raise ValueError('schema delta not exact')
 template=next((c for c in old if c.get('table_schema')=='public' and c.get('table_name')=='activations' and c.get('column_name')=='error'),None)
 if template is None:raise ValueError('before nullable text template absent')
 maximum=max(c['ordinal_position'] for c in old if c.get('table_schema')=='public' and c.get('table_name')=='activations')
 for i,(name,typ)in enumerate(ADDED.items(),1):
  col=next(c for c in extra if c['column_name']==name);expected=copy.deepcopy(template)
  expected.update(column_name=name,ordinal_position=maximum+i,data_type=typ,udt_name='timestamptz' if name=='applied_at' else 'text')
  if name=='applied_at':expected.update(datetime_precision=6)
  if col!=expected or col.get('is_nullable')!='YES' or col.get('column_default')is not None:raise ValueError('unexpected new column metadata')
 normalized_schema=copy.deepcopy(a);normalized_schema['columns']=remaining
 if normalized_schema!=b:raise ValueError('other schema sections changed')
 legacy=counts(proof.get('legacy_projection'));prior=counts(before['postgres']['rows']['public.activations']);current=counts(after['postgres']['rows']['public.activations'])
 if legacy!=prior or proof.get('whole_rows')!=current:raise ValueError('old values or captured after rows differ')
 n=sum(current.values())
 if proof.get('row_count')!=n or sum(legacy.values())!=n or type(proof.get('nonnull_new_columns'))is not int or proof['nonnull_new_columns']!=0:raise ValueError('new values or row multiplicities differ')
 # Reuse normal preservation checks with ONLY the proven activation transformation normalized.
 normalized=copy.deepcopy(after);normalized['postgres']['schema']=copy.deepcopy(b);normalized['postgres']['rows']['public.activations']=legacy
 if q.compare(before,normalized,{'appendOnlyTables':pin.get('appendOnlyTables',[])}):raise ValueError('non-target preservation failed')
 if pin.get('appendOnlyTables')!=proof.get('appendOnlyTables'):raise ValueError('preservation policy evidence mismatch')
 return True
def load(path):
 raw=Path(path).read_bytes();return json.loads(raw),digest(raw)
def main():
 if len(sys.argv)!=3:raise ValueError('before and after required')
 # Pin path is explicit operator configuration, never inferred from an untrusted candidate.
 pin_path=os.environ.get('LYAM_ACTIVATION161_REVIEWED_PIN')
 if not pin_path:raise ValueError('reviewed pin required')
 pin,_=load(pin_path);policy,policy_hash=load(pin['policy_file'])
 if policy_hash!=pin.get('policyHash') or policy.get('appendOnlyTables')!=pin.get('appendOnlyTables'):raise ValueError('pinned original policy mismatch')
 proof,ph=load(pin['projection_file']);before,bh=load(sys.argv[1]);after,ah=load(sys.argv[2]);verify(before,after,proof,pin,bh,ah,ph)
 print('Exact activation161 transformation and non-target preservation verified; no deployment or opening authorized.')
if __name__=='__main__':
 try:main()
 except Exception:print('Activation161 transformation unverified. Keep maintenance armed.',file=sys.stderr);sys.exit(1)
