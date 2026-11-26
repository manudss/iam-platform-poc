#!/usr/bin/env python3
"""Prepare only a reviewed copy env. Not a claim all stored secrets are sanitized."""
import hashlib,json,re
# No wildcards. New outbound credentials/settings require review, not inference.
REMOVED={'RESEND_API_KEY','SMTP_PASSWORD','SMTP_USER','SMTP_HOST','SMTP_URL','OPENAI_API_KEY','ANTHROPIC_API_KEY','GITHUB_TOKEN'}
FORCED={'IAM_WORKFLOW_REAL_CONNECTIONS':'0'}
INFRA={'IAM_PG_URL','IAM_BAO_ADDR','IAM_BAO_TOKEN','IAM_PUBLIC_ORIGIN'}
def values(raw):
 out={}
 for line in raw.decode().splitlines():
  if not line or line.startswith('#'):continue
  if '=' not in line:raise ValueError('copy source requires literal env format')
  k,v=line.split('=',1)
  if not re.fullmatch('[A-Z][A-Z0-9_]*',k) or k in out:raise ValueError('copy env key invalid or duplicate')
  out[k]=v
 return out

def prepare(raw,infra):
 if set(infra)!=INFRA or any(not isinstance(v,str) or not v or '\n' in v for v in infra.values()):raise ValueError('four exact synthetic copy infrastructure overrides required')
 before=values(raw);after={k:v for k,v in before.items() if k not in REMOVED}
 after.update(FORCED);after.update(infra)
 if 'IAM_AUTOMATION_HOLD' in after:raise ValueError('normal copy requires HOLD absent')
 changed=sorted(k for k in before.keys()|after.keys() if before.get(k)!=after.get(k))
 if set(changed)-(REMOVED|set(FORCED)|INFRA):raise ValueError('unreviewed copy env delta')
 result=''.join(k+'='+v+'\n' for k,v in sorted(after.items())).encode()
 return result,{'kind':'isolated-copy-env-delta','source_sha256':hashlib.sha256(raw).hexdigest(),'copy_sha256':hashlib.sha256(result).hexdigest(),'changed_keys':changed,'stored_data_credentials_sanitized':False}
