#!/usr/bin/env python3
"""OpenSSH debug text is private data. Publish only fixed stage flags and bounded exit integers."""
import re,sys
from pathlib import Path

def stages(trace):
 patterns={
 'connection_established':r'(?m)^debug1: Connection established\.$',
 'server_identification':r'(?m)^debug1: Remote protocol version [^\r\n]+$',
 'host_key_accepted':r'(?m)^debug1: Host [^\r\n]+ is known and matches the [^\r\n]+ host key\.$',
 'authentication_accepted':r'(?m)^Authenticated to [^\r\n]+ using "[^"\r\n]+"\.$|^debug1: Authentication succeeded \([^\r\n]+\)\.$',
 'channel_open_confirmed':r'(?m)^debug2: channel [0-9]+: open confirm rwindow [0-9]+ rmax [0-9]+$',
 'exec_accepted':r'(?m)^debug2: exec request accepted on channel [0-9]+$',
 'exec_refused':r'(?m)^exec request failed on channel [0-9]+\s*$|^debug2: exec request failed on channel [0-9]+\s*$',
 'exit_status_received':r'(?m)^debug1: client_input_channel_req: channel [0-9]+ rtype exit-status reply [01]$',
 }
 result={k:bool(re.search(p,trace)) for k,p in patterns.items()}
 matches=re.findall(r'(?m)^debug1: Exit status ([0-9]{1,3})$',trace)
 result['remote_exit_status']=int(matches[-1]) if matches and int(matches[-1])<=255 else 'unknown'
 return result

def main():
 trace=Path(sys.argv[1]).read_bytes();out=Path(sys.argv[2]).read_bytes();rc=int(sys.argv[3])
 print('ssh_probe.version=1');print('ssh_probe.local_exit='+str(rc));print('ssh_probe.stdout_bytes='+str(len(out)));print('ssh_probe.trace_bytes='+str(len(trace)))
 # Oversize trace is not parsed as if complete. No raw text is ever emitted.
 if len(trace)>1024*1024:print('ssh_probe.trace_complete=false');return 1
 s=stages(trace.decode(errors='replace'))
 for k,v in s.items():print('ssh_probe.'+k+'='+(str(v).lower() if isinstance(v,bool) else str(v)))
 print('ssh_probe.trace_complete=true')
 ok=rc==0 and s['authentication_accepted'] and s['exec_accepted'] and s['exit_status_received'] and s['remote_exit_status']==0
 print('ssh_probe.command_succeeded='+str(ok).lower());return 0 if ok else 1
if __name__=='__main__':sys.exit(main())
