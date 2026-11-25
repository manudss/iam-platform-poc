#!/usr/bin/env python3
"""Append-only reconciliation of a resolved held journal with a restored held image.
Never starts/stops containers or opens gates. Caller holds journal and updater locks.
A manifest is not authority. A closed runtime is never called UI-open.
"""
import copy, datetime, hashlib
from pathlib import Path


def reconcile(q,path,manifest,repository,container,pause,verify=None,observe=None,qualify=None,controller=None):
 state=q.load(path)
 q.checked_manifest(state,manifest,'reviewed-restored-held')
 if state.get('format')!=3 or state.get('resume_required') is not True or any(state.get(k) for k in ('pending','failed','opening_intent','release_intent')):raise ValueError('resolved held format3 fence required')
 if state.get('recovery_fence')!=state['history'][-1]['sha'] or state['history'][-1].get('automation_held') is not True:raise ValueError('held historical fence required')
 pause=Path(pause)
 if pause.is_symlink() or not pause.is_file():raise ValueError('retained exact pause required')
 pause_raw=pause.read_bytes();state_raw=path.read_bytes()
 chain=manifest.get('chain');target=manifest.get('target',{})
 if set(target)!={'sha','digest'} or not q.SHA.fullmatch(target['sha']) or not q.DIGEST.fullmatch(target['digest']):raise ValueError('exact restored target required')
 if not isinstance(chain,list) or not 1<=len(chain)<=256:raise ValueError('bounded source ancestry required')
 parent=state['history'][-1]['sha'];seen={x['sha'] for x in state['history']}
 for i,e in enumerate(chain):
  if set(e)!={'sha','parent','outcome'} or not q.SHA.fullmatch(e['sha']) or e['sha'] in seen or e['parent']!=parent or e['outcome']!=('restored-automation-held' if i==len(chain)-1 else 'restored-over-not-delivered'):raise ValueError('unique explicit restored source chain required')
  seen.add(e['sha']);parent=e['sha']
 if parent!=target['sha']:raise ValueError('source chain target differs')
 (verify or q.verify_source_chain)(repository,state['history'][-1]['sha'],chain)
 # Existing receipt verifier checks exact digest, TLS/policy, preserved stores and
 # linked before/after/smoke hashes. No candidate digest substitution is permitted.
 (qualify or q.verify_qualification_receipt)(manifest.get('qualification_receipt'),target)
 c=controller or q.opening_controller(manifest)
 env,fields=c.verify(manifest,container,target,public=503)
 if env.get('IAM_AUTOMATION_HOLD')!='1' or env.get('LYAM_PAUSE_FILE','/opt/lyam/UPDATE_PAUSED')!=str(pause):raise ValueError('persistent held/pause binding differs')
 first=(observe or q.observe_running)(container,target)
 # Direct verifier includes exact closed runtime, both TLS503 gates, preservation
 # baseline and held health proof. Execute twice to detect changing inputs.
 c.verify(manifest,container,target,public=503)
 second=(observe or q.observe_running)(container,target)
 if not first.get('container_id'):raise ValueError('immutable container identity required')
 if first!=second or any(second.get(k)!=target[k] for k in ('sha','digest')) or second.get('running') is not True:raise ValueError('restored runtime observation changed')
 if q.load(path)!=state or path.read_bytes()!=state_raw or pause.is_symlink() or pause.read_bytes()!=pause_raw:raise ValueError('journal or pause changed during reconciliation')
 at=datetime.datetime.now(datetime.timezone.utc).isoformat()
 prior=q.fingerprint(state)
 audit={'kind':'reviewed-restored-held','at':at,'prior_fingerprint':prior,'prior_journal_sha256':hashlib.sha256(state_raw).hexdigest(),'previous_fence':state['recovery_fence'],'chain':copy.deepcopy(chain),'target':copy.deepcopy(target),'observed_running':second,'qualification_receipt':copy.deepcopy(manifest['qualification_receipt']),'closed_receipt':copy.deepcopy(manifest['opening']['closed_receipt']),'pause_sha256':hashlib.sha256(pause_raw).hexdigest(),'manifest_claims':{'authorization_ref':manifest['authorization_ref'],'evidence_refs':manifest['evidence_refs'],'verified_authority':False}}
 # Intermediates are retained in the audit only. history records observed deployed
 # targets, so marking an unrun intermediate as delivered would be false.
 state['history'].append({**target,'at':at,'mode':'restored-automation-held','automation_held':True})
 state['recoveries'].append(audit);state.update(format=5,recovery_fence=target['sha'],resume_required=True)
 q.atomic(path,state)
 return state
