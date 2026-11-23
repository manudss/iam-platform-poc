CREATE TEMP TABLE qualification_capture(value jsonb);
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
DO $capture$
DECLARE t record; seq_record record; captured_value jsonb; rows_json jsonb='{}'; sequences_json jsonb='{}'; schema_json jsonb; defs_json jsonb; projection jsonb;
BEGIN
 IF current_setting('transaction_read_only') <> 'on' OR current_setting('transaction_isolation') <> 'repeatable read' THEN RAISE EXCEPTION 'required read-only repeatable-read absent'; END IF;
 FOR t IN SELECT schemaname,tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') AND schemaname NOT LIKE 'pg_temp_%' AND schemaname NOT LIKE 'pg_toast%' ORDER BY schemaname,tablename LOOP
  EXECUTE format('SELECT coalesce(jsonb_object_agg(h,n),''{}'') FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text,''UTF8'')),''hex'') h,count(*) n FROM %I.%I t GROUP BY 1) x',t.schemaname,t.tablename) INTO captured_value;
  rows_json=rows_json||jsonb_build_object(t.schemaname||'.'||t.tablename,captured_value);
 END LOOP;
 SELECT json_build_object('columns',(SELECT coalesce(json_agg(c ORDER BY table_schema,table_name,ordinal_position),'[]') FROM information_schema.columns c WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_schema NOT LIKE 'pg_temp_%'), 'indexes',(SELECT coalesce(json_agg(i ORDER BY schemaname,tablename,indexname),'[]') FROM pg_indexes i WHERE schemaname NOT IN ('pg_catalog','information_schema')), 'views',(SELECT coalesce(json_agg(v ORDER BY schemaname,viewname),'[]') FROM pg_views v WHERE schemaname NOT IN ('pg_catalog','information_schema')), 'functions',(SELECT coalesce(json_agg(f ORDER BY schema,name,args),'[]') FROM (SELECT n.nspname schema,p.proname name,pg_get_function_identity_arguments(p.oid) args,pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_temp_%' AND p.prokind IN ('f','p')) f), 'constraints',(SELECT coalesce(json_agg(c ORDER BY nspname,relname,conname),'[]') FROM (SELECT n.nspname,r.relname,c.conname,pg_get_constraintdef(c.oid) definition FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_temp_%') c)) INTO schema_json;
 SELECT coalesce(jsonb_agg(s ORDER BY sequence_schema,sequence_name),'[]') INTO defs_json FROM information_schema.sequences s WHERE sequence_schema NOT IN ('pg_catalog','information_schema');
 FOR seq_record IN SELECT sequence_schema,sequence_name FROM information_schema.sequences WHERE sequence_schema NOT IN ('pg_catalog','information_schema') ORDER BY sequence_schema,sequence_name LOOP
  EXECUTE format('SELECT to_jsonb(s) FROM (SELECT last_value,is_called FROM %I.%I) s',seq_record.sequence_schema,seq_record.sequence_name) INTO captured_value;
  sequences_json=sequences_json||jsonb_build_object(seq_record.sequence_schema||'.'||seq_record.sequence_name,captured_value);
 END LOOP;
 SELECT jsonb_build_object('pairs',(SELECT coalesce(jsonb_agg(p ORDER BY whole,legacy),'[]') FROM (SELECT encode(sha256(convert_to(to_jsonb(a)::text,'UTF8')),'hex') whole,encode(sha256(convert_to((to_jsonb(a)-'actor_id'-'actor_kind'-'applied_at')::text,'UTF8')),'hex') legacy,count(*) multiplicity FROM public.activations a GROUP BY 1,2) p),'row_count',count(*),'nonnull_new_columns',count(*) FILTER(WHERE actor_id IS NOT NULL OR actor_kind IS NOT NULL OR applied_at IS NOT NULL)) INTO projection FROM public.activations;
 INSERT INTO qualification_capture VALUES (jsonb_build_object('format',1,'transaction',jsonb_build_object('read_only',true,'isolation','repeatable read','snapshot',pg_current_snapshot()::text,'database',current_database()),'postgres',jsonb_build_object('rows',rows_json,'schema',schema_json,'sequenceDefinitions',defs_json,'sequences',sequences_json),'projection',projection));
END $capture$;
SELECT value FROM qualification_capture;
COMMIT;
