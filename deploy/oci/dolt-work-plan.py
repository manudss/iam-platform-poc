#!/usr/bin/env python3
"""Separate reviewed normalization/planning, never invokes Docker or Dolt."""
import argparse,hashlib,importlib.util,json,os,re
from pathlib import Path
ROOT=Path('/root/dolt-evidence-57c4a92e03bd816f')
STAGE_SHA='cd90b34f8d91a36167a7030327ea90e5fcfabf8fa3b381916dd4bc226fb2176c'
INVENTORY_SHA='4b74201b457382bf381d4414613d725d76d5bf5888bed53a27b2802008ec5db5'
def module(path,name):
 spec=importlib.util.spec_from_file_location(name,path);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
def execute_preparation(reader,stager):
 _,raw=reader.read_binding({'path':str(ROOT/'stage.json'),'sha256':STAGE_SHA});stage=json.loads(raw)
 if stage['source_inventory_sha256']!=INVENTORY_SHA or stage['incoming_inventory_sha256']!=INVENTORY_SHA or not stage['source_unchanged'] or not stage['source_incoming_bytes_equal']:raise ValueError('stage identity differs')
 before=stager.inventory(ROOT/'incoming')
 if stager.fingerprint(before)!=INVENTORY_SHA:raise ValueError('staged incoming changed')
 reader.prepare_work_copy(ROOT/'incoming',ROOT/'work')
 if stager.inventory(ROOT/'incoming')!=before:raise ValueError('incoming changed during preparation')
 h,total,count=reader.digest_tree(ROOT/'work')
 return {'kind':'cold-dolt-work-prepared-no-sql','work_dir':str(ROOT/'work'),'tree_sha256':h,'source_bytes':total,'source_files':count,'incoming_unchanged':True,'preparation_sha256':hashlib.sha256((ROOT/'preparation.json').read_bytes()).hexdigest(),'docker_executed':False,'restoration_admissible':False}

def main():
 p=argparse.ArgumentParser();p.add_argument('--controller-sha256',required=True);p.add_argument('--reader-sha256',required=True);p.add_argument('--stage-controller-sha256',required=True);p.add_argument('--execute-reviewed-work-preparation',action='store_true');a=p.parse_args()
 base=Path(__file__).absolute().parent;reader_path=base/'dolt-copy-capture.py'
 for path in [Path(__file__).absolute(),reader_path,base/'dolt-source-stage.py']:
  for parent in [path,*path.parents]:
   st=parent.lstat()
   if parent.is_symlink() or st.st_uid or st.st_gid or st.st_mode&0o022:raise ValueError('protected reviewed code required')
 if hashlib.sha256(Path(__file__).read_bytes()).hexdigest()!=a.controller_sha256 or hashlib.sha256(reader_path.read_bytes()).hexdigest()!=a.reader_sha256 or hashlib.sha256((base/'dolt-source-stage.py').read_bytes()).hexdigest()!=a.stage_controller_sha256:raise ValueError('reviewed code hashes differ')
 if not a.execute_reviewed_work_preparation:raise ValueError('explicit work preparation required')
 for path in [ROOT,*ROOT.parents]:
  st=path.lstat()
  if path.is_symlink() or st.st_uid or st.st_gid or st.st_mode&0o022:raise ValueError('protected work ancestry required')
 reader=module(reader_path,'copy_reader');stager=module(base/'dolt-source-stage.py','stage_reader')
 print(json.dumps(execute_preparation(reader,stager)))
if __name__=='__main__':
 try:main()
 except Exception:
  print('DOLT_WORK_PREPARATION_REFUSED: keep incoming and partial work private; no retry',file=__import__('sys').stderr);raise SystemExit(1)
