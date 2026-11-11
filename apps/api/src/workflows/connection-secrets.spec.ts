import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { SecretsService } from '../integrations/secrets.service.js';
const bin=process.env.BAO_BIN??'';
describe('immutable connection secret revisions with real OpenBao', {skip:!existsSync(bin)&&'BAO_BIN missing'},()=>{
  it('writes once, refuses an overwrite, reads the same reference and returns undefined for absent revisions',async()=>{
    let process_:ChildProcess|undefined; const oldAddr=process.env.IAM_BAO_ADDR,oldToken=process.env.IAM_BAO_TOKEN;
    try{
      process_=spawn(bin,['server','-dev','-dev-root-token-id=fictional-local-test-token','-dev-listen-address=127.0.0.1:14378'],{stdio:'ignore'});
      process.env.IAM_BAO_ADDR='http://127.0.0.1:14378';process.env.IAM_BAO_TOKEN='fictional-local-test-token';
      let ready=false;for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:14378/v1/sys/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.equal(ready,true);
      const service=new SecretsService(),ref='iam/workflow-connections/test/conn-test/immutable-revision';
      await service.put(ref,{value:'FICTIONAL-TEST-CREDENTIAL'});
      assert.equal((await service.get(ref))?.value,'FICTIONAL-TEST-CREDENTIAL');
      await assert.rejects(()=>service.put(ref,{value:'REPLACEMENT'}),/write failed/);
      assert.equal((await service.get(ref))?.value,'FICTIONAL-TEST-CREDENTIAL');
      assert.equal(await service.get(ref+'-missing'),undefined);
    }finally{process_?.kill();if(oldAddr===undefined)delete process.env.IAM_BAO_ADDR;else process.env.IAM_BAO_ADDR=oldAddr;if(oldToken===undefined)delete process.env.IAM_BAO_TOKEN;else process.env.IAM_BAO_TOKEN=oldToken;}
  });
});
