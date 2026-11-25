#!/usr/bin/env python3
"""Public-log boundary: fixed keys/enums/numbers only; raw stderr is never printed."""
import json,re,sys
from pathlib import Path
mode,out,err,rc=sys.argv[1:];rc=int(rc)
raw=Path(out).read_bytes();errors=Path(err).read_bytes()
print('transport.ssh_exit='+str(rc));print('transport.stdout_bytes='+str(len(raw)));print('transport.stderr_bytes='+str(len(errors)))
text=raw[:65536].decode(errors='replace');lines=text.splitlines();seen=set()
for line in lines:
 if re.fullmatch(r'transport\.(remote_enter|sudo_enter|host_enter)=true|transport\.(sudo_exit|payload_exit)=[0-9]{1,3}',line):print(line);seen.add(line)
error_tags=[]
for pat,tag in [(b'Permission denied','ssh_permission_denied'),(b'Host key verification failed','ssh_host_key_failed'),(b'Connection timed out','ssh_timeout'),(b'password is required','sudo_password_required'),(b'not allowed to execute','sudo_not_allowed'),(b'must have a tty','sudo_tty_required'),(b'command not found','command_not_found')]:
 if pat.lower() in errors.lower():error_tags.append(tag)
print('transport.error_category='+(','.join(error_tags) if error_tags else ('unclassified' if errors else 'none')))
complete=False;rejected=0
if mode=='host':
 # Exact bounded public diagnostic schema. Never accept arbitrary key/value text.
 patterns=[r'diag\.(version|problem_lines)=[0-9]{1,6}',r'diag\.complete=(true|false)',r'host\.utc=[0-9TZ:.-]{20,32}',r'container\.(hold_env|app_commit|image_ref|image_id|running|restart_count|started_at|exit_code|api_hold_log|front_healthz_8080|api_health_3000|core_health_8081|present)=(?:[a-f0-9]{7,64}|sha256:[a-f0-9]{64}|ghcr\.io/manudss/iam-platform-poc(?::[A-Za-z0-9._-]{1,64})?(?:@sha256:[a-f0-9]{64})?|[0-9TZ:.-]{1,32}|true|false|absent|unknown|unexpected|err|invalid|held=(?:true|false),settingPresent=(?:true|false))',r'file\.(UPDATE_PAUSED|\.update\.lock|MAINTENANCE|OPS-MAINTENANCE)\.present=(true|false)(?: mtime=(?:[0-9]{1,15}|unknown))?',r'state\.(sha256=[a-f0-9]{64}|present=false)',r'unit\.lyam-boot\.active=(active|inactive|failed|activating|deactivating|unknown)',r'journal\.(format|history_length|last_delivered_sha|last_delivered_digest|last_delivered_mode|pending|failed|resume_required|recovery_fence|opening_intent_present|resumptions_count|last_resumption_observed_sha)=(?:[0-9]{1,6}|[a-f0-9]{40}|sha256:[a-f0-9]{64}|True|False|true|false|none|normal|ui-open-automation-held|closed-recovery|in-place|absent|unexpected|unknown|other|absent_or_unexpected)']
 for line in lines:
  if any(re.fullmatch(p,line) for p in patterns):print(line);complete|=line=='diag.complete=true'
  elif line and not line.startswith('transport.') and line not in ['--- runtime','--- locks','--- journal','note.gate_paths=default (LYAM_FRONT_BARRIER_FILE/LYAM_OPS_BARRIER_FILE overrides not read)']:rejected+=1
else:
 # Numeric-only flattened inventory avoids publishing arbitrary JSON text/keys.
 allowed={'inventory_version','complete','dolt','nats','runs_by_status_test','steps_by_status_simulated','tasks_by_status_kind','ticket_links_by_status','piece_state_rows','active_definitions_main_branch','nonterminal_run_snapshots','runs_with_unexpected_status','read_only_session','stream','consumers','listed','total','incomplete','missing_numeric_fields','totals','num_pending','num_ack_pending','num_redelivered','num_waiting','by_plugin_allowlist','retained_messages','consumer_count','rows','truncated','oversize_graphs','unparsable_or_over_500_nodes','graphs_with_block_category','trigger_kind','consumers','pending','ack_pending','redelivered','unknown','source_error','note','count'}
 enums={'queued','running','waiting','completed','failed','canceled','pending','done','skipped','open','decided','claimed','true','false','none','cron','event','other','mail','http','sheets','jira','iga','lyam-other','absent','unsupported','timeout','denied','error','column_missing','too_many_groups','api_error_or_fields_missing','no_core_nats_config','api_process_not_found'}
 source=Path(__file__).with_name('inventory.cjs').read_text()
 for name in ['PLUGIN_IDS','RUN_STATUS','TASK_STATUS','TASK_KIND','STEP_STATUS','LINK_STATUS']:
  match=re.search(r'const '+name+r' = (?:new Set\()?\[([^\]]+)\]',source)
  if match:enums.update(re.findall(r"'([^']+)'",match.group(1)))
 def safe_key(k):
  if '|kind=' in k:
   status,kind=k.split('|kind=',1)
   return status in {'open','decided','canceled','other'} and kind in enums
  return k in allowed or k in enums or bool(re.fullmatch(r'(queued|running|waiting|completed|failed|canceled)\|test=(true|false|other)|(pending|running|done|failed|skipped)\|simulated=(true|false|other)',k))
 def emit(x,path='inventory'):
  global rejected
  if isinstance(x,dict):
   for k,v in x.items():
    if k=='note':continue
    if safe_key(k):emit(v,path+'.'+k)
    else:rejected+=1
  elif isinstance(x,bool):print(path+'='+str(x).lower())
  elif isinstance(x,int) and 0<=x<=10**12:print(path+'='+str(x))
  elif isinstance(x,str) and x in enums:print(path+'='+x)
  else:rejected+=1
 for line in lines:
  if not line.startswith('{'):continue
  try:
   value=json.loads(line);emit(value);complete=value.get('complete') is True
  except (ValueError,TypeError):rejected+=1
print('transport.filtered_lines='+str(rejected))
ok=rc==0 and rejected==0 and complete and 'transport.remote_enter=true' in seen and 'transport.sudo_enter=true' in seen and 'transport.payload_exit=0' in seen
if mode=='host':ok=ok and 'transport.host_enter=true' in seen
print('transport.complete='+str(ok).lower());sys.exit(0 if ok else 1)
