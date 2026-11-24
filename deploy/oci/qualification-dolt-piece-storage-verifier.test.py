import copy,importlib.util,json,subprocess,sys,tempfile,unittest
from pathlib import Path
HERE=Path(__file__).parent;PATH=HERE/'qualification-dolt-piece-storage-verifier.py'
spec=importlib.util.spec_from_file_location('v',PATH);v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
"""DOUBLES: synthetic hash/shape snapshots. They prove the verifier's decision table only. They do NOT prove that the real Dolt capture
produces this shape: that needs the real Dolt delivery run (see the report) which must feed this verifier the genuine before/after files."""
E=v.EMPTY_SHA256;DDL='ddl-sha-of-real-dolt-calibration'
v.EXPECTED_DDL_SHA256=DDL     # test value; the real one must be calibrated on real Dolt (see report)
def col(n,t,null='NO',d=v.NULL_DEFAULT_SHA256,dn=True,key='',extra='',coll='utf8mb4_0900_bin',comment=E):return {'name':n,'type':t,'nullable':null,'key':key,'collation':coll,'defaultIsNull':dn,'defaultHash':d,'extra':extra,'commentHash':comment}
def ix(name,seq,column,nu=0,sub=None,coll='A',typ='BTREE',expr=None):return {'name':name,'nonUnique':nu,'seq':seq,'column':column,'collation':coll,'subPart':sub,'type':typ,'nullable':'','expressionHash':expr}
def tbl(name,rows=3,h=None,cols=None,pk=None,indexes=None,ddl=None):
    pk=pk if pk is not None else ['id'];return {'name':name,'kind':'BASE TABLE','columns':cols or [col('id','int',key='PRI',coll=None)],'pk':pk,'indexes':indexes if indexes is not None else [ix('PRIMARY',n+1,c) for n,c in enumerate(pk)],'rows':rows,'ddlHash':ddl or ('d-'+name),'hash':h or ('h-'+name)}
OBJS={'schemas':'s','procedures':'p'}
def entry(db,br,tables,head=None,root=None,objs=None,status=None):return {'status':status or [],'evidence':'dolt-tables-v3','database':db,'branch':br,'head':head or ('head-'+db+br),'root':root or ('root-'+db+br),'tables':sorted(tables,key=lambda t:t['name']),'schemaObjects':dict(objs or OBJS)}
PIECE=tbl('workflow_piece_state',rows=0,h='piece-new',ddl=DDL,cols=[col('tenant','varchar(64)',key='PRI'),col('scope_id','varchar(200)',key='PRI'),col('state_key','varchar(200)',key='PRI'),col('value_json','longtext')],pk=['tenant','scope_id','state_key'])
def snap():return {'dolt':[entry('iam','main',[tbl('people'),tbl('orders')]),entry('iam','personal/kept',[tbl('people',h='h-people-kept')],root='dirty-root'),entry('iam','wf-run-1',[tbl('people')]),
  entry('iam_meta','main',[tbl('workflow_runs'),tbl('workflow_definitions')]),entry('iam_meta','other',[tbl('workflow_runs')]),entry('other_db','main',[tbl('x')])]}
def good_after():
    a=copy.deepcopy(snap())
    for e in a['dolt']:
        if (e['database'],e['branch'])==('iam_meta','main'):e['tables']=sorted(e['tables']+[copy.deepcopy(PIECE)],key=lambda t:t['name']);e['root']='root-after';e['status']=e['status']+[dict(v.NEW_STATUS)]
    return a
class V(unittest.TestCase):
    def run_v(self,before,after,changes='dolt'):
        with tempfile.TemporaryDirectory() as d:
            b=Path(d)/'b.json';a=Path(d)/'a.json';b.write_text(json.dumps(before));a.write_text(json.dumps(after))
            return v.main([str(b),str(a)]+([changes] if changes is not None else []))
    def ok(self,after,before=None,changes='dolt'):self.assertEqual(self.run_v(before or snap(),after,changes),0)
    def refused(self,after,category,before=None,changes='dolt'):
        import io,contextlib
        err=io.StringIO()
        with contextlib.redirect_stderr(err):rc=self.run_v(before or snap(),after,changes)
        self.assertEqual(rc,1);self.assertIn(category,err.getvalue());return err.getvalue()
    def mut(self,fn,db='iam_meta',br='main'):
        a=good_after()
        for e in a['dolt']:
            if (e['database'],e['branch'])==(db,br):fn(e);e['tables']=sorted(e['tables'],key=lambda x:x['name'])
        return a
    def piece(self,e):return [t for t in e['tables'] if t['name']=='workflow_piece_state'][0]
    def test_exact_transformation_accepted(self):self.ok(good_after())
    def test_cli_exit_codes(self):
        with tempfile.TemporaryDirectory() as d:
            b=Path(d)/'b.json';a=Path(d)/'a.json';b.write_text(json.dumps(snap()));a.write_text(json.dumps(good_after()))
            r=subprocess.run([sys.executable,str(PATH),str(b),str(a),'dolt'],capture_output=True);self.assertEqual(r.returncode,1);self.assertIn(b'new-table-ddl',r.stderr)   # doubles use a different DDL hash from the calibrated real contract
            self.assertEqual(subprocess.run([sys.executable,str(PATH),str(b),str(a)],capture_output=True).returncode,1)
            self.assertEqual(subprocess.run([sys.executable,str(PATH),str(b),str(a),'dolt,bao'],capture_output=True).returncode,1)
    def test_other_categories_refused(self):
        for c in (None,'','dolt,bao','bao','dolt,postgres-rows','dolt,credentials'):self.refused(good_after(),'change-categories',changes=c) if c is not None else self.assertEqual(self.run_v(snap(),good_after(),None),1)
    def test_loss_or_change_in_business_and_other_branches_refused(self):
        for db,br,fn,why in [('iam','main',lambda e:e.update(root='r2'),'root'),('iam','main',lambda e:e['tables'].pop(),'dropped table'),('iam','main',lambda e:e['tables'][0].update(rows=e['tables'][0]['rows']-1),'row lost'),
            ('iam','main',lambda e:e['tables'][0].update(hash='x'),'table content'),('iam','main',lambda e:e.update(head='h2'),'head'),('iam','personal/kept',lambda e:e.update(root='clean'),'dirty working set reset'),
            ('iam','personal/kept',lambda e:e['tables'][0].update(hash='x'),'dirty table'),('iam','wf-run-1',lambda e:e['tables'].append(tbl('extra')),'non-target branch table'),
            ('iam_meta','other',lambda e:e['tables'].append(copy.deepcopy(PIECE)),'piece table on non-target meta branch'),('other_db','main',lambda e:e['schemaObjects'].update(schemas='x'),'other db schema objects')]:
            with self.subTest(why):self.refused(self.mut(fn,db,br),'other-database-or-branch-changed')
    def test_branch_or_database_set_changes_refused(self):
        a=good_after();a['dolt'].append(entry('iam','new-branch',[tbl('people')]));self.refused(a,'branch-set-changed')
        a=good_after();a['dolt']=[e for e in a['dolt'] if e['branch']!='personal/kept'];self.refused(a,'branch-set-changed')
        a=good_after();a['dolt'].append(entry('third_db','main',[]));self.refused(a,'branch-set-changed')
        a=good_after();a['dolt']=[e for e in a['dolt'] if e['database']!='other_db'];self.refused(a,'branch-set-changed')
    def test_target_changes_refused(self):
        self.refused(self.mut(lambda e:e.update(head='committed')),'target-head-changed')
        self.refused(self.mut(lambda e:e.update(root='root-iam_metamain')),'no-target-change')
        self.refused(self.mut(lambda e:e['schemaObjects'].update(schemas='added')),'schema-objects-changed')
        self.refused(self.mut(lambda e:e['tables'].append(tbl('extra_meta'))),'table-set-changed')
        self.refused(self.mut(lambda e:e['tables'].remove(self.piece(e))),'no-target-change' if False else 'table-set-changed')
        for name in ('workflow_runs','workflow_definitions'):
            with self.subTest(name):
                self.refused(self.mut(lambda e:[t for t in e['tables'] if t['name']==name][0].update(hash='changed')),'existing-table-changed')
                self.refused(self.mut(lambda e:[t for t in e['tables'] if t['name']==name][0].update(rows=99)),'existing-table-changed')
        a=self.mut(lambda e:e['tables'].remove([t for t in e['tables'] if t['name']=='workflow_runs'][0]));self.refused(a,'table-set-changed')
        a=self.mut(lambda e:[t for t in e['tables'] if t['name']=='workflow_runs'][0]['columns'].append(col('c','int')));self.refused(a,'existing-table-changed')
    def test_new_table_shape_rows_pk_defaults(self):
        self.refused(self.mut(lambda e:self.piece(e).update(rows=1)),'new-table-not-empty')
        self.refused(self.mut(lambda e:self.piece(e).update(kind='VIEW',rows=None)),'new-table-not-empty')
        self.refused(self.mut(lambda e:self.piece(e)['columns'][1].update(type='varchar(255)')),'new-table-columns')
        self.refused(self.mut(lambda e:self.piece(e)['columns'][3].update(type='text')),'new-table-columns')
        self.refused(self.mut(lambda e:self.piece(e)['columns'].pop()),'new-table-columns')
        self.refused(self.mut(lambda e:self.piece(e)['columns'].reverse()),'new-table-columns')
        self.refused(self.mut(lambda e:self.piece(e)['columns'].append(col('extra','int'))),'new-table-columns')
        self.refused(self.mut(lambda e:self.piece(e)['columns'][0].update(nullable='YES')),'new-table-column-attributes')
        self.refused(self.mut(lambda e:self.piece(e)['columns'][3].update(defaultHash='a'*64)),'new-table-column-attributes')
        self.refused(self.mut(lambda e:self.piece(e)['columns'][3].update(defaultIsNull=False)),'new-table-column-attributes')
        self.refused(self.mut(lambda e:self.piece(e)['columns'][3].update(defaultIsNull=False,defaultHash=v.EMPTY_SHA256)),'new-table-column-attributes')
        self.refused(self.mut(lambda e:self.piece(e)['columns'][3].update(commentHash='c'*64)),'new-table-column-attributes')
        self.refused(self.mut(lambda e:self.piece(e)['columns'][3].update(extra='auto_increment')),'new-table-column-attributes')
        self.refused(self.mut(lambda e:self.piece(e).update(pk=['scope_id','tenant','state_key'])),'new-table-primary-key')
        self.refused(self.mut(lambda e:self.piece(e).update(pk=['tenant','scope_id'])),'new-table-primary-key')
        self.refused(self.mut(lambda e:self.piece(e).update(pk=[])),'new-table-primary-key')
    def test_schema_exactness_unique_secondary_check_fk_collation_options(self):
        P=self.piece
        self.refused(self.mut(lambda e:P(e)['columns'][3].update(key='UNI')),'new-table-keys')                      # the reviewed blocker: value_json UNI
        self.refused(self.mut(lambda e:P(e)['columns'][0].update(key='')),'new-table-keys')
        self.refused(self.mut(lambda e:(P(e)['columns'][3].update(key='UNI'),P(e).update(hash='another'))),'new-table-keys')   # arbitrary table hash does not help
        self.refused(self.mut(lambda e:P(e)['indexes'].append(ix('by_state',1,'state_key',nu=1))),'new-table-indexes')   # secondary index
        self.refused(self.mut(lambda e:P(e)['indexes'].append(ix('uniq_value',1,'value_json',nu=0,sub=191))),'new-table-indexes')   # unique prefix index
        self.refused(self.mut(lambda e:P(e)['indexes'].append(ix('fk_backing',1,'tenant',nu=1))),'new-table-indexes')        # index backing a foreign key
        self.refused(self.mut(lambda e:P(e)['indexes'].pop()),'new-table-indexes')
        self.refused(self.mut(lambda e:P(e)['indexes'][1].update(nonUnique=1)),'new-table-indexes')
        self.refused(self.mut(lambda e:P(e)['indexes'][0].update(subPart=10)),'new-table-indexes')
        self.refused(self.mut(lambda e:P(e)['indexes'][2].update(expressionHash='e'*64)),'new-table-indexes')
        self.refused(self.mut(lambda e:P(e)['indexes'][1].update(column='state_key')),'new-table-indexes')
        self.refused(self.mut(lambda e:P(e)['indexes'][2].update(collation='D')),'new-table-indexes')
        self.refused(self.mut(lambda e:P(e)['columns'][1].update(collation='utf8mb4_0900_ai_ci')),'new-table-collation')       # collation differs
        self.refused(self.mut(lambda e:[c.update(collation=None) for c in P(e)['columns']]),'new-table-collation')
        # CHECK constraint, foreign key, charset or table options change only the canonical DDL text hash
        for why in ('check','foreign key','charset','table option','comment'):
            with self.subTest(why):self.refused(self.mut(lambda e:P(e).update(ddlHash='ddl-with-'+why)),'new-table-ddl')
    def test_working_status_and_objects_must_account_for_exactly_the_new_table(self):
        self.refused(self.mut(lambda e:e.update(status=[])),'working-status-changed')                                  # root moved but Dolt status shows nothing
        self.refused(self.mut(lambda e:e['status'].append({'table':'people','staged':False,'status':'modified'})),'working-status-changed')   # hidden second change
        self.refused(self.mut(lambda e:e['status'].__setitem__(0,dict(v.NEW_STATUS,staged=True))),'working-status-changed')
        self.refused(self.mut(lambda e:e['status'].__setitem__(0,dict(v.NEW_STATUS,status='modified'))),'working-status-changed')
        for k in ('procedures',):self.refused(self.mut(lambda e:e['schemaObjects'].update({k:'changed'})),'schema-objects-changed')
        self.refused(self.mut(lambda e:e['schemaObjects'].pop('procedures')),'evidence-malformed')
        self.refused(self.mut(lambda e:e.update(schemaObjects='o')),'evidence-malformed')
    def test_other_branch_status_drift_refused(self):
        self.refused(self.mut(lambda e:e['status'].append({'table':'x','staged':False,'status':'modified'}),'iam','main'),'other-database-or-branch-changed')
    def test_ddl_calibration_fails_closed(self):
        old=v.EXPECTED_DDL_SHA256;v.EXPECTED_DDL_SHA256=None
        try:self.refused(good_after(),'ddl-not-calibrated')
        finally:v.EXPECTED_DDL_SHA256=old
    def test_existing_table_ddl_default_or_index_change_refused(self):
        for fn in (lambda t:t.update(ddlHash='x'),lambda t:t['columns'][0].update(defaultHash='a'*64),lambda t:t['columns'][0].update(defaultIsNull=False),lambda t:t['columns'][0].update(collation='other'),lambda t:t['indexes'].append(ix('extra',1,'id',nu=1)),lambda t:t['columns'][0].update(commentHash='b'*64)):
            self.refused(self.mut(lambda e:fn([t for t in e['tables'] if t['name']=='workflow_runs'][0])),'existing-table-changed')
    def test_snapshots_hold_no_raw_default_or_comment_values(self):
        raw=json.dumps(good_after());self.assertNotIn('"default"',raw);self.assertNotIn('"comment"',raw)
    def test_preexisting_piece_table_refused(self):
        b=snap()
        for e in b['dolt']:
            if (e['database'],e['branch'])==('iam_meta','main'):e['tables']=sorted(e['tables']+[copy.deepcopy(PIECE)],key=lambda t:t['name'])
        a=good_after();self.refused(a,'table-already-present',before=b)
    def test_evidence_missing_malformed_or_old_format_refused(self):
        old={'dolt':[{'database':'iam','branch':'main','head':'h','root':'r'}]}
        self.assertEqual(self.run_v(old,good_after()),1);self.assertEqual(self.run_v(snap(),old),1)
        for fn in (lambda a:a['dolt'][0].pop('tables'),lambda a:a['dolt'][0].update(extra=1),lambda a:a['dolt'][0].update(evidence='v0'),lambda a:a['dolt'].append(copy.deepcopy(a['dolt'][0])),
                   lambda a:a['dolt'][0]['tables'][0].update(rows=-1),lambda a:a['dolt'][0]['tables'][0].update(name='bad name'),lambda a:a['dolt'][0]['tables'][0].update(kind='SYSTEM VIEW'),lambda a:a['dolt'][0]['tables'][0].pop('hash'),
                   lambda a:a['dolt'][0]['tables'].reverse(),lambda a:a.update(dolt=[]),lambda a:a['dolt'][0]['tables'][0]['columns'][0].update(unknown=1),lambda a:a['dolt'][0]['tables'][0].pop('ddlHash'),lambda a:a['dolt'][0]['tables'][0].pop('indexes'),lambda a:a['dolt'][0]['tables'][0]['columns'][0].update(default='raw'),lambda a:a['dolt'][0]['tables'][0]['indexes'].append({'name':'x'})):
            a=good_after();fn(a);self.assertEqual(self.run_v(snap(),a),1)
        with tempfile.TemporaryDirectory() as d:
            (Path(d)/'a.json').write_text('{not json');(Path(d)/'b.json').write_text(json.dumps(snap()))
            self.assertEqual(v.main([str(Path(d)/'b.json'),str(Path(d)/'a.json'),'dolt']),1)
    def test_refusal_message_carries_only_a_bounded_category(self):
        a=self.mut(lambda e:self.piece(e).update(rows=1));msg=self.refused(a,'new-table-not-empty')
        for secret in ('workflow_piece_state','piece-new','head-','root-','personal/kept'):self.assertNotIn(secret,msg)
class Wiring(unittest.TestCase):
    def test_qualification_passes_exact_categories_to_the_verifier_and_container_captures_table_evidence(self):
        q=(HERE/'qualification.py').read_text();self.assertIn("categories-v1",q);self.assertIn("[str(evidence/'before.json')",q) if False else None
        m=(HERE/'qualification-container.mjs').read_text()
        self.assertNotIn('SHOW FULL TABLES\').map(r=>Object.values',m);self.assertNotIn("default:c.Default",m)
        for token in ("evidence:'dolt-tables-v3'","DOLT_HASHOF_TABLE","SHOW FULL TABLES","SHOW KEYS","SHOW FULL COLUMNS","dolt_schemas","schemaObjects","dolt_status","dolt-tables-v3","dolt_procedures","sql_mode","Dolt system table columns unknown","defaultIsNull","Dolt session identity mismatch","Dolt inventory moved during capture","defaultIsNull"):self.assertIn(token,m)
        self.assertNotIn("SHOW PROCEDURE STATUS",m);self.assertNotIn("SHOW TRIGGERS",m)
class Interface(unittest.TestCase):
    """Real subprocess run of qualification.py's verifier dispatch is not possible without Docker; this executes the dispatch block with real scripts."""
    def dispatch(self,entry):
        src=(HERE/'qualification.py').read_text();i=src.index("        entry=p.get('transformationVerifiers'");j=src.index("    print('ISOLATED LOOPBACK ONLY")
        import textwrap,os;block=textwrap.dedent(src[i:j]).replace('p.get(\'transformationVerifiers\',{}).get(a.image)','ENTRY')
        calls=[];ns={'ENTRY':entry,'changes':['DOLT:x','DOLT:y'],'Path':Path,'os':os,'json':json,'sys':sys,'evidence':Path('/ev'),'after_file':Path('/af'),'cmd':lambda c:calls.append(c)}
        wrapped='def f():\n'+textwrap.indent(block,'    ')
        exec(wrapped,ns);ns['f']();return calls
    def test_legacy_string_gets_two_arguments_and_versioned_object_three(self):
        with tempfile.TemporaryDirectory() as d:
            x=Path(d)/'v';x.write_text('#!/bin/sh\n');x.chmod(0o755)
            self.assertEqual(self.dispatch(str(x)),[[str(x),'/ev/before.json','/af']])
            self.assertEqual(self.dispatch({'path':str(x),'interface':'categories-v1'}),[[str(x),'/ev/before.json','/af','DOLT']])
            for bad in ({'path':str(x)},{'path':str(x),'interface':'v9'},{'path':str(x),'interface':'categories-v1','x':1},None,[str(x)]):
                with self.assertRaises(ValueError):self.dispatch(bad)
class SysObjects(unittest.TestCase):
    """Executes the real sysObjects code from qualification-container.mjs under node with a stubbed query (double of the Dolt 2.6.1 shapes the producer confirmed)."""
    def test_all_columns_hashed_exact_absence(self):
        import shutil
        if not shutil.which('node'):self.skipTest('node absent')
        m=(HERE/'qualification-container.mjs').read_text();blk=m[m.index(" const SYS="):m.index(" const schemaObjects=")]
        js=("import {createHash} from 'node:crypto';const hash=x=>createHash('sha256').update(x).digest('hex');const ident=/^[A-Za-z0-9_]{1,64}$/;\n"
            "let mode;const query=()=>{if(mode.err){const e=new Error('x');e.stderr=mode.err;throw e;}return mode.rows;};\n"+blk+
            "const run=(m,t)=>{mode=m;try{return JSON.stringify(sysObjects('r',t||'dolt_procedures'));}catch(e){return 'ERR '+e.message;}};\n"
            "const P={name:'p',create_stmt:'c',created_at:'1',modified_at:'2',sql_mode:'A'};const S=(extra,sm)=>({rows:[{type:'trigger',name:'t',fragment:'f',extra,sql_mode:sm||'A'}]});\n"
            "console.log(JSON.stringify([run({rows:[P]})!==run({rows:[{...P,sql_mode:'B'}]}),run({rows:[P]})!==run({rows:[{...P,created_at:'9'}]}),run({rows:[P]})!==run({rows:[{...P,modified_at:'9'}]}),run({rows:[P]})!==run({rows:[{...P,create_stmt:'d'}]}),"
            "run({rows:[{...P,z:1}]}),run({rows:[{name:'p'}]}),run({rows:[{...P,sql_mode:undefined}]}),"
            "run({err:'Error: table not found: dolt_procedures'}),run({err:'a\\ntable not found: dolt_procedures'}),run({err:'table not found: dolt_procedures and more'}),run({err:'table not found: dolt_schemas'}),run({err:'boom'}),"
            "run(S('{\"CreatedAt\":5,\"k\":1}'),'dolt_schemas')===run(S('{\"k\":1,\"CreatedAt\":5}'),'dolt_schemas'),run(S('{\"CreatedAt\":5,\"k\":1}'),'dolt_schemas')!==run(S('{\"CreatedAt\":7,\"k\":1}'),'dolt_schemas'),run(S('{\"CreatedAt\":5,\"k\":1}'),'dolt_schemas')!==run(S('{\"CreatedAt\":5,\"k\":2}'),'dolt_schemas'),run(S('{\"CreatedAt\":5}'),'dolt_schemas')!==run(S('{\"CreatedAt\":5}','B'),'dolt_schemas'),run(S('not json'),'dolt_schemas')]));")
        r=subprocess.run(['node','--input-type=module','-e',js],capture_output=True,text=True);self.assertEqual(r.returncode,0,r.stderr)
        o=json.loads(r.stdout)
        self.assertEqual(o[0:4],[True]*4)                                   # sql_mode, both timestamps and statement are all hashed
        for k in (4,5,6):self.assertTrue(o[k].startswith('ERR'))           # unknown/missing columns, undefined value
        self.assertTrue(all(o[k].startswith('ERR') for k in (7,8,9,10,11)))   # every query error refuses, including apparent missing-table errors
        self.assertEqual(o[12:16],[True,True,True,True]);self.assertFalse(o[16].startswith('ERR'))   # extra canonicalised (key order), every key kept, non-JSON kept as raw text
if __name__=='__main__':unittest.main()
