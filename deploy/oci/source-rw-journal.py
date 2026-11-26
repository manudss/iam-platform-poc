#!/usr/bin/env python3
"""Exclusive append-only source-RW event directory. No recovery, retry or effects."""
import hashlib,json,os,stat,time
from pathlib import Path
class Journal:
 def __init__(self,path):self.path=Path(path);self.next=0;self.previous=None
 def _syncdir(self,p):
  fd=os.open(p,os.O_RDONLY|os.O_DIRECTORY)
  try:os.fsync(fd)
  finally:os.close(fd)
 def create(self,event):
  for p in [self.path.parent,*self.path.parent.parents]:
   st=p.lstat()
   if p.is_symlink() or st.st_uid or st.st_gid or st.st_mode&0o022:raise ValueError('protected source-RW journal ancestry required')
  self.path.mkdir(mode=0o700);self._syncdir(self.path.parent)
  self.append(event)
 def append(self,event):
  envelope={'at_unix_ns':time.time_ns(),'sequence':self.next,'previous_sha256':self.previous,'event':event}
  raw=json.dumps(envelope,sort_keys=True,separators=(',',':')).encode();p=self.path/('%06d.json'%self.next)
  fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
  with os.fdopen(fd,'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
  self._syncdir(self.path)
  if p.read_bytes()!=raw:raise ValueError('source-RW journal reread differs')
  self.previous=hashlib.sha256(raw).hexdigest();self.next+=1
  return self.previous
