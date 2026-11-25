"""Bounded diagnostic projection of PRIVATE updater log. Never exports text or arbitrary values."""
import re,json
MARKERS={
 'closed recovery exact image/migration/ledger preflight failed':'preflight-refused',
 'pre-update preservation capture failed':'preservation-before-refused',
 'pre-update hook failed':'pre-update-hook-refused',
 'pre-opening qualification failed':'qualification-before-open-refused',
 'post-update qualification failed':'qualification-after-refused',
 'closed post-backup exact image/ledger/companion preflight failed':'postbackup-preflight-refused',
 'closed backup archive readback failed':'backup-readback-refused',
 'closed PostgreSQL dump readback failed':'postgres-readback-refused',
 'cannot write fresh closed receipt':'receipt-write-refused',
 'cannot write exact qualification evidence index':'evidence-index-refused',
 'the new image never became healthy within':'candidate-health-timeout',
 'the new container could not be created':'candidate-create-refused',
 'OpenBao did not become ready/unsealed':'bao-readiness-refused',
 'preservation changed':'preservation-diff',
 'another update is running':'lock-busy',
 'inherited lock fd':'inherited-fd-refused',
 'inherited update lock':'inherited-lock-refused',
 'adopted receipt':'adopted-receipt-refused',
 'front gate to adopt':'gate-adoption-refused',
 'OPS barrier changed':'ops-gate-drift',
 'a maintenance gate this run does NOT own':'foreign-gate',
 'closed helper integrity failed':'helper-integrity-refused',
 'closed code changed':'code-integrity-drift',
 'data backup failed':'data-backup-refused',
 'pg backup failed':'pg-backup-refused',
 'bao backup failed':'bao-backup-refused',
}
KINDS={'ValueError','RuntimeError','TimeoutExpired','FileNotFoundError','PermissionError','KeyError','TypeError','JSONDecodeError','Other'}
def project(log):
 codes=re.findall(r'closed step did not return CLOSED_QUALIFIED \(rc (-?[0-9]{1,3})\); no retry, no rollback',log)
 rc=int(codes[-1]) if codes and -255<=int(codes[-1])<=255 else None
 result={'updaterExit':rc,'categories':sorted({v for k,v in MARKERS.items() if k in log}) or ['unclassified']}
 diag=[]
 for raw in re.findall(r'^QUALIFICATION_DIAG_V1 (\{[^\n]{1,600}\})$',log,re.M):
  try:
   v=json.loads(raw)
   if set(v)=={'exceptionType','sourceLines'} and v['exceptionType'] in KINDS and type(v['sourceLines']) is list and len(v['sourceLines'])<=8 and all(type(n) is int and 0<n<1000000 for n in v['sourceLines']):diag.append(v)
  except (ValueError,TypeError):pass
 if diag:result['qualificationDiagnostics']=diag[-4:]
 allowed={'policy-load','tls-barriers','evidence-setup','runtime-identity','runtime-stability','auth-load','smoke','capture','ledger-load','credentials','postgres','policy-consistency','evidence-write','held-activations','preservation-compare','transformation-verifier'}
 stages=re.findall(r'^QUALIFICATION_DIAG_V1:([a-z-]{1,40})(?:/[^\r\n]*)?$',log,re.M)
 if stages and stages[-1] in allowed:result['qualificationStage']=stages[-1]
 return result
