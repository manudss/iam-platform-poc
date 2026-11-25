#!/usr/bin/env python3
"""Aggregate independent synthetic chain fixtures, never a production qualification."""
import argparse,hashlib,json,os,re
from pathlib import Path
EXPECTED={'clean':{'one-clean','three-clean'},'interruptions':{'three-kill-closed-step-0-running','three-kill-closed-step-1-qualified','three-kill-opening'},'orphan':{'one-orphan-updater'}}
def verify(root,context,jobs_result):
 errors=[];seen=set()
 if jobs_result!='success':errors.append('matrix-not-success')
 if not re.fullmatch('[0-9a-f]{40}',context.get('sourceSHA','')) or any(not context.get(k,'').isdigit() for k in ('runID','attempt')):errors.append('invalid-expected-context')
 for shard,names in EXPECTED.items():
  folder=Path(root)/('held-update-proof-'+shard)
  try:
   receipt=json.loads((folder/'delivery-receipt.json').read_text());evidence=json.loads((folder/'execution-evidence.json').read_text());progress=json.loads((folder/'held-progress.json').read_text())
   if evidence.get('heldUpdate',{}).get('qualificationContext')!=context:raise ValueError('context-mismatch')
   if receipt.get('evidence',{}).get('execution-evidence.json')!=hashlib.sha256((folder/'execution-evidence.json').read_bytes()).hexdigest():raise ValueError('evidence-hash-mismatch')
   if receipt.get('sha')!=evidence.get('sha') or receipt.get('digest')!=evidence.get('digest'):raise ValueError('fixture-binding-mismatch')
   if receipt.get('passed') is not True or evidence.get('passed') is not True:raise ValueError('fixture-not-passed')
   if receipt.get('scenario')!='held-update' or receipt.get('checks',{}).get('heldUpdateChain') is not True:raise ValueError('receipt-check-missing')
   if evidence.get('heldUpdate',{}).get('scenarioSelection')!=shard:raise ValueError('selection-mismatch')
   scenarios=evidence['heldUpdate']['scenarios']
   if set(scenarios)!=names:raise ValueError('scenario-set-mismatch')
   if seen&set(scenarios):raise ValueError('duplicate-scenario')
   seen.update(scenarios)
   if progress.get('stage')!='all-scenarios-complete' or progress.get('scenario') not in names:raise ValueError('terminal-progress-missing')
   if not receipt.get('cleanup',{}).get('containersAbsent') or not receipt.get('cleanup',{}).get('networkAbsent'):raise ValueError('cleanup-incomplete')
   if shard=='orphan' and not any(x.get('stage')=='after-child-wait' and x.get('childState')=='absent' for x in progress.get('timeline',[])):raise ValueError('orphan-child-wait-unproved')
  except (OSError,ValueError,KeyError,TypeError):errors.append(shard+'-evidence-invalid')
 return {'format':1,'passed':not errors,'errors':errors,'expectedScenarios':sorted(set.union(*EXPECTED.values())),'observedScenarios':sorted(seen),'limitations':['Independent synthetic fixtures, not a sequential shared-state replay','Not production qualification','1200 seconds per fixture unchanged']}
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('root');p.add_argument('--out',required=True);a=p.parse_args();v=verify(a.root,{'sourceSHA':os.environ.get('HELD_EXPECTED_SOURCE_SHA',''),'runID':os.environ.get('HELD_EXPECTED_RUN_ID',''),'attempt':os.environ.get('HELD_EXPECTED_ATTEMPT','')},os.environ.get('HELD_JOBS_RESULT',''));Path(a.out).write_text(json.dumps(v,indent=2));raise SystemExit(0 if v['passed'] else 1)
