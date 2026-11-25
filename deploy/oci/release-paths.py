#!/usr/bin/env python3
"""Pure review planner. Produces required bindings, never writes env or starts services."""
from pathlib import PurePosixPath


def plan(root, container, backup, front, ops):
 def absolute(value):
  p=PurePosixPath(value)
  if not value.startswith('/') or '..' in p.parts or str(p)!=value or any(c.isspace() for c in value):raise ValueError('canonical absolute path required')
  return p
 r=absolute(root);b=absolute(backup);f=absolute(front);o=absolute(ops)
 if f==o or f.parent!=o.parent or f.parent==r or r in f.parents:raise ValueError('distinct gates in dedicated front directory required')
 if r==b or r not in b.parents:raise ValueError('backups must have explicit dedicated directory in active root')
 if not container or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-' for c in container):raise ValueError('container name required')
 return {'LYAM_CONTAINER':container,'LYAM_DATA_DIR':str(r/'data'),'LYAM_BACKUP_DIR':str(b),'LYAM_QUEUE_STATE':str(r/'deploy-queue/state.json'),'LYAM_ORDERED_QUEUE':str(r/'bin/ordered-queue.py'),'LYAM_LOCK_FILE':str(r/'.update.lock'),'LYAM_PAUSE_FILE':str(r/'UPDATE_PAUSED'),'LYAM_UPDATE_SCRIPT':str(r/'bin/update.sh'),'LYAM_POST_UPDATE_CHECK':str(r/'bin/qualification.py'),'LYAM_QUALIFICATION_POLICY':str(r/'qualification.json'),'LYAM_FRONT_BARRIER_FILE':str(f),'LYAM_OPS_BARRIER_FILE':str(o)}


def verify(env, expected):
 if any(env.get(k)!=v for k,v in expected.items()):raise ValueError('explicit operational path binding differs')
 return True
