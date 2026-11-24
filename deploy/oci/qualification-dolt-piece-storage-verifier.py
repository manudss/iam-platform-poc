#!/usr/bin/env python3
"""Reviewed transformation verifier for ONE declared Dolt change: migration 0003 (native connector storage).
Called by qualification.py as: verifier BEFORE.json AFTER.json CHANGES, only when compare() found changes.
It proves, from hash/shape-only per-table evidence ('dolt-tables-v3'), that the ONLY difference between the two snapshots is:
  database iam_meta, branch main: working root changed, head unchanged, and exactly one new BASE TABLE workflow_piece_state with
  columns (tenant varchar(64), scope_id varchar(200), state_key varchar(200), value_json longtext), all NOT NULL, no default,
  primary key (tenant, scope_id, state_key), zero rows. Every pre-existing table of that branch is byte-identical (hash, rows, shape),
  and EVERY other database/branch (including business, dirty working sets and non-target branches) is identical in full.
Schema exactness is proven three ways: structured columns/keys/indexes, and the whole SHOW CREATE TABLE text hash pinned to a value calibrated on real Dolt.
Also: Dolt's own dolt_status accounting must gain exactly that one unstaged new table, dolt_schemas/dolt_procedures hashes are unchanged, and the capture refuses a ref that moved while collected.
Anything else, or evidence missing/unknown, refuses. It authorizes nothing else: not a generic Dolt exemption, not other digests.
Exit 0 only on the exact declared transformation; otherwise exit 1 printing only a bounded category (no names, hashes or data)."""
import json,re,sys
from pathlib import Path

TARGET=('iam_meta','main');NEW='workflow_piece_state'
EXPECTED_COLUMNS=[('tenant','varchar(64)'),('scope_id','varchar(200)'),('state_key','varchar(200)'),('value_json','longtext')]
EXPECTED_PK=['tenant','scope_id','state_key']
ENTRY={'evidence','database','branch','head','root','tables','schemaObjects','status'}
OBJECTS={'schemas','procedures'}
STATUS={'table','staged','status'}
NEW_STATUS={'table':'workflow_piece_state','staged':False,'status':'new table'}   # Dolt's own working-set accounting: the one root difference allowed
TABLE={'name','kind','columns','pk','indexes','rows','ddlHash','hash'}
COLUMN={'name','type','nullable','key','collation','defaultIsNull','defaultHash','extra','commentHash'}
NULL_DEFAULT_SHA256='5d1480744600a3aff4a2532f7b2485b710504387754b712f3a86bdfd85f60b76'   # sha256 of the canonical typed NULL serialization {"k":"null"}
INDEX={'name','nonUnique','seq','column','collation','subPart','type','nullable','expressionHash'}
EMPTY_SHA256='e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'   # sha256('') : an empty column comment
# sha256 of the exact SHOW CREATE TABLE text Dolt emits for the reviewed CREATE TABLE of workflow_piece_state. It MUST be calibrated from a real Dolt run
# of that exact statement; until set the verifier fails closed. Pinning it covers CHECK, FOREIGN KEY, charset/collation and table options.
EXPECTED_DDL_SHA256='e6525724bc9daf1eb34e72cf085fe6b27a208e21bf0ad72848be3378fab49610'
IDENT=re.compile(r'[A-Za-z0-9_]{1,64}')

class Refuse(Exception):pass
def need(ok,category):
    if not ok:raise Refuse(category)

def load(path):
    snap=json.loads(Path(path).read_text());need(isinstance(snap,dict) and isinstance(snap.get('dolt'),list) and snap['dolt'],'evidence-missing')
    out={}
    for e in snap['dolt']:
        need(isinstance(e,dict) and set(e)==ENTRY and e['evidence']=='dolt-tables-v3','evidence-missing')
        need(all(isinstance(e[k],str) and e[k] for k in ('database','branch','head','root')) and isinstance(e['tables'],list),'evidence-malformed')
        need(isinstance(e['schemaObjects'],dict) and set(e['schemaObjects'])==OBJECTS and all(isinstance(v,str) and v for v in e['schemaObjects'].values()),'evidence-malformed')
        need(isinstance(e['status'],list) and all(isinstance(r,dict) and set(r)==STATUS and isinstance(r['table'],str) and isinstance(r['staged'],bool) and isinstance(r['status'],str) for r in e['status']),'evidence-malformed')
        key=(e['database'],e['branch']);need(key not in out,'evidence-duplicate')
        names=set()
        for t in e['tables']:
            need(isinstance(t,dict) and set(t)==TABLE and isinstance(t['name'],str) and IDENT.fullmatch(t['name']) and t['name'] not in names and t['kind'] in ('BASE TABLE','VIEW'),'evidence-malformed')
            names.add(t['name'])
            need(isinstance(t['columns'],list) and all(isinstance(c,dict) and set(c)==COLUMN and type(c['defaultIsNull']) is bool for c in t['columns']) and isinstance(t['pk'],list) and isinstance(t['hash'],str) and t['hash'] and isinstance(t['ddlHash'],str) and t['ddlHash'],'evidence-malformed')
            need(isinstance(t['indexes'],list) and all(isinstance(i,dict) and set(i)==INDEX for i in t['indexes']),'evidence-malformed')
            need(t['kind']=='VIEW' and t['rows'] is None or t['kind']=='BASE TABLE' and type(t['rows']) is int and t['rows']>=0,'evidence-malformed')
        need([t['name'] for t in e['tables']]==sorted(names),'evidence-malformed')
        out[key]=e
    return out

def status_counts(rows):
    # Fixed 20 cells: target/other x unstaged/staged x new/modified/deleted/renamed/other.
    counts=[0]*20
    for row in rows:
        kind=['new table','modified','deleted','renamed'].index(row['status']) if row['status'] in ['new table','modified','deleted','renamed'] else 4
        index=(0 if row['table']==NEW else 1)*10+int(row['staged'])*5+kind
        counts[index]=min(1000000,counts[index]+1)
    return counts

def verify(before_path,after_path,changes):
    need(changes=='dolt','change-categories')    # compare() must have reported Dolt and NOTHING else (bao, credentials, postgres preserved)
    b,a=load(before_path),load(after_path)
    need(set(b)==set(a),'branch-set-changed')
    need(TARGET in b,'target-branch-absent')
    for key in b:
        if key!=TARGET:need(b[key]==a[key],'other-database-or-branch-changed')
    x,y=b[TARGET],a[TARGET]
    need(x['head']==y['head'],'target-head-changed')                 # nothing is committed: the new table lives in the working set only
    need(x['root']!=y['root'],'no-target-change')
    need(x['schemaObjects']==y['schemaObjects'],'schema-objects-changed')
    if sorted(y['status'],key=json.dumps)!=sorted(x['status']+[NEW_STATUS],key=json.dumps):
        print('DOLT_STATUS_DIAG_V1 '+json.dumps({'before':status_counts(x['status']),'after':status_counts(y['status'])},separators=(',',':')),file=sys.stderr)
    need(sorted(y['status'],key=json.dumps)==sorted(x['status']+[NEW_STATUS],key=json.dumps),'working-status-changed')   # Dolt's status diff vs HEAD is exactly one new unstaged table
    old={t['name']:t for t in x['tables']};new={t['name']:t for t in y['tables']}
    need(NEW not in old,'table-already-present')                      # an idempotent rerun produces no dolt change, never reaches this verifier
    need(set(old)<=set(new) and set(new)-set(old)=={NEW},'table-set-changed')
    for name,t in old.items():need(new[name]==t,'existing-table-changed')
    t=new[NEW]
    need(t['kind']=='BASE TABLE' and t['rows']==0,'new-table-not-empty')
    need([(c['name'],c['type']) for c in t['columns']]==EXPECTED_COLUMNS,'new-table-columns')
    need([c['key'] for c in t['columns']]==['PRI','PRI','PRI',''],'new-table-keys')
    need(all(c['nullable']=='NO' and c['defaultIsNull'] is True and c['defaultHash']==NULL_DEFAULT_SHA256 and c['extra']=='' and c['commentHash']==EMPTY_SHA256 for c in t['columns']),'new-table-column-attributes')
    need(len({c['collation'] for c in t['columns']})==1 and t['columns'][0]['collation'],'new-table-collation')
    need(t['pk']==EXPECTED_PK,'new-table-primary-key')
    ix=t['indexes'];need(len(ix)==3 and [(i['name'],i['seq'],i['column']) for i in ix]==[('PRIMARY',n+1,c) for n,c in enumerate(EXPECTED_PK)]
        and all(i['nonUnique']==0 and i['subPart'] is None and i['expressionHash'] is None for i in ix) and len({(i['collation'],i['type'],i['nullable']) for i in ix})==1,'new-table-indexes')   # no secondary, unique, FK-backing or prefix index
    need(EXPECTED_DDL_SHA256 is not None,'ddl-not-calibrated')
    need(t['ddlHash']==EXPECTED_DDL_SHA256,'new-table-ddl')           # canonical DDL: CHECK, FOREIGN KEY, table options, charset/collation

def main(argv):
    try:
        need(len(argv)==3,'usage');verify(argv[0],argv[1],argv[2])
    except Refuse as r:
        print('DOLT_TRANSFORMATION_REFUSED '+str(r),file=sys.stderr);return 1
    except Exception:
        print('DOLT_TRANSFORMATION_REFUSED unreadable-evidence',file=sys.stderr);return 1
    print('dolt transformation verified: only iam_meta/main gained empty workflow_piece_state');return 0
if __name__=='__main__':sys.exit(main(sys.argv[1:]))
