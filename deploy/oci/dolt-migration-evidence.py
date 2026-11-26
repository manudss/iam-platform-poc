#!/usr/bin/env python3
"""Pure envelope adapter for migration0003 evidence, never restoration admission.
Reads already captured source/current tables-v3 files. No Docker, DB or writes
outside its private temporary verifier inputs. File hashes do not prove provenance.
"""
import hashlib,importlib.util,json,os,re,tempfile
from pathlib import Path

def refs(rows):
 if not isinstance(rows,list) or not rows:raise ValueError('nonempty exact ref inventory required')
 out={}
 for row in rows:
  if not isinstance(row,dict) or set(row)!={'database','branch','head','root'} or any(not isinstance(v,str) or not v for v in row.values()):raise ValueError('exact ref inventory schema required')
  key=(row['database'],row['branch'])
  if key in out:raise ValueError('duplicate ref inventory')
  out[key]=row
 return out

def adapt(envelope,running,anchor):
 if not isinstance(envelope,dict) or set(envelope)!={'format','kind','running','dolt'} or envelope['format']!=1 or envelope['kind']!='dolt-only-tables-v3' or envelope['running'] is not running:raise ValueError('exact Dolt-only envelope and mode required')
 rows=envelope['dolt']
 if not isinstance(rows,list) or not rows:raise ValueError('nonempty tables-v3 required')
 observed=refs([{k:row[k] for k in ('database','branch','head','root')} for row in rows])
 if observed!=refs(anchor):raise ValueError('captured refs differ from operator anchor')
 return {'dolt':rows}

def evaluate(before,after,before_refs,after_refs,verifier):
 b=adapt(before,False,before_refs);a=adapt(after,True,after_refs)
 with tempfile.TemporaryDirectory(prefix='lyam-migration-evidence-') as d:
  os.chmod(d,0o700);paths=[]
  for name,value in [('before',b),('after',a)]:
   p=Path(d)/(name+'.json');fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
   with os.fdopen(fd,'w') as f:json.dump(value,f,sort_keys=True)
   paths.append(p)
  verifier(*paths,'dolt')
 return {'format':1,'kind':'source-copy-migration0003-evidence','migration0003_shape_consistent_with_operator_anchor_refs_only':True,'restoration_admissible':False,'effect_authority':False,'source_provenance':'candidate-2.6.1-restored-active-copy-pre-migration-operator-capture-not-independent','historical_bus_gap_closed':False,'source_stopped_exit137_app_consistency_not_proved':True,'ref_count':len(b['dolt'])}

def read(binding):
 if not isinstance(binding,dict) or set(binding)!={'path','sha256'} or not re.fullmatch('[a-f0-9]{64}',binding['sha256']):raise ValueError('exact file binding required')
 p=Path(binding['path'])
 if not p.is_absolute() or '..' in p.parts:raise ValueError('absolute evidence path required')
 for ancestor in [p,*p.parents]:
  s=ancestor.lstat()
  if ancestor.is_symlink() or s.st_uid or s.st_gid or s.st_mode&0o022:raise ValueError('protected root evidence ancestry required')
 if not p.is_file() or p.stat().st_nlink!=1 or p.stat().st_size>64*1024*1024:raise ValueError('bounded unique evidence file required')
 raw=p.read_bytes()
 if hashlib.sha256(raw).hexdigest()!=binding['sha256']:raise ValueError('evidence changed')
 return p,raw

def main():
 import argparse
 p=argparse.ArgumentParser();p.add_argument('--spec',required=True);p.add_argument('--spec-sha256',required=True);p.add_argument('--controller-sha256',required=True);a=p.parse_args()
 read({'path':str(Path(__file__).absolute()),'sha256':a.controller_sha256})
 _,raw=read({'path':a.spec,'sha256':a.spec_sha256});s=json.loads(raw)
 if set(s)!={'format','kind','before','after','before_refs','after_refs','verifier'} or s['format']!=1 or s['kind']!='reviewed-migration0003-evidence':raise ValueError('exact adapter spec required')
 verifier,raw=read(s['verifier'])
 if verifier!=Path(__file__).with_name('qualification-dolt-piece-storage-verifier.py').absolute():raise ValueError('fixed verifier required')
 spec=importlib.util.spec_from_file_location('migration0003_fixed',verifier);v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
 values={k:json.loads(read(s[k])[1]) for k in ('before','after','before_refs','after_refs')}
 result=evaluate(**values,verifier=v.verify);result['evidence_hashes']={k:s[k]['sha256'] for k in values};print(json.dumps(result,sort_keys=True))
if __name__=='__main__':
 try:main()
 except Exception:
  print('MIGRATION_EVIDENCE_REFUSED: keep original evidence, no admission',file=__import__('sys').stderr);raise SystemExit(1)
