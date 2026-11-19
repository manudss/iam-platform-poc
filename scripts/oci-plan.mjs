// Derive an ordered first-parent main queue. A push containing N commits yields N entries.
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
const sha=/^[a-f0-9]{40}$/;
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
const [command,base,head,out]=process.argv.slice(2);
if(command==='plan'){
 if(!sha.test(base??'')||!sha.test(head??''))throw Error('full baseline and head SHA required');
 const commits=git('rev-list','--first-parent','--reverse',`${base}..${head}`).split('\n').filter(Boolean);
 if(!git('rev-list','--first-parent',head).split('\n').includes(base))throw Error('deployed SHA is not on current main first-parent chain; manual review, no rewind');
 if(commits.length>32)throw Error('queue exceeds qualification batch bound; explicit operator batching required');
 let parent=base;
 const entries=commits.map(id=>{
  const actual=git('rev-parse',`${id}^1`);if(actual!==parent)throw Error('gap');
  const entry={sha:id,parent};parent=id;return entry;
 });
 writeFileSync(out,JSON.stringify({format:1,base,entries})+'\n');
 console.log(JSON.stringify({include:entries.map(e=>({sha:e.sha}))}));
}else if(command==='receipts'){
 // base=plan file, head=downloaded receipt directory, out=qualified queue file.
 const plan=JSON.parse(readFileSync(base,'utf8'));
 const receipts=readdirSync(head,{recursive:true}).filter(f=>String(f).endsWith('.json')).map(f=>JSON.parse(readFileSync(head+'/'+f,'utf8')));
 for(const e of plan.entries){
  const found=receipts.filter(r=>r.sha===e.sha);if(found.length!==1||!/^sha256:[a-f0-9]{64}$/.test(found[0].digest))throw Error('missing/ambiguous image receipt');e.digest=found[0].digest;
 }
 writeFileSync(out,JSON.stringify(plan)+'\n');
}else throw Error('unknown plan command');
