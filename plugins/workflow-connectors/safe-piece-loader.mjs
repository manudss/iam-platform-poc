/** Fail-closed, byte-pinned correction of upstream process-global TLS mutation.
 * Compile only the reviewed neutralized bytes, never execute the original module.
 * No runtime environment restoration and no concurrent insecure window. */
import{readFileSync}from'node:fs';
import{dirname,join}from'node:path';
import{createHash}from'node:crypto';
import{Module,builtinModules}from'node:module';
const reviewed={
 '@activepieces/piece-google-sheets':{version:'0.19.5',sha256:'18395161e95fd2781d0e884f3ec08fea314379daa4a81e9bef824e7fd4d4cf73',count:1},
 '@activepieces/piece-jira-cloud':{version:'0.6.4',sha256:'091c2ba72af6613f0b5824f55f2a3f13f85225cb9e06f3e4c09b1c321667bd02',count:1},
 '@activepieces/piece-http':{version:'0.13.2',sha256:'7e6833d5d1c41ec07f8d70e1b5a2df18b2782d56a7c44f0a9c88a9194b7581ff',count:1},
 '@activepieces/piece-text-helper':{version:'0.6.7',sha256:'94b578c3e120906b99f464c2c677669ee7f0bf75924fcdd4b6aa810c9a37ab67',count:0},
};
const NEEDLE='process.env.NODE_TLS_REJECT_UNAUTHORIZED="0";',cache=new Map();
export function assertNativeTls(){if(process.env.NODE_TLS_REJECT_UNAUTHORIZED!==undefined&&process.env.NODE_TLS_REJECT_UNAUTHORIZED!=='1')throw Error('Native pieces require enabled TLS certificate verification');}
export function neutralizePieceSource(pkg,source,version){const expected=reviewed[pkg];if(!expected||expected.version!==version||createHash('sha256').update(source).digest('hex')!==expected.sha256)throw Error('Native piece bytes/version not reviewed');const text=source.toString('utf8');if(text.split(NEEDLE).length-1!==expected.count)throw Error('Native TLS patch occurrence mismatch');const safe=text.split(NEEDLE).join('');if(safe.includes('NODE_TLS_REJECT_UNAUTHORIZED')||safe.includes('rejectUnauthorized'))throw Error('Native bundle contains unreviewed TLS controls');return safe;}
export function loadSafePiece(require,pkg){
 assertNativeTls();if(cache.has(pkg))return cache.get(pkg);
 const entry=require.resolve(pkg),version=JSON.parse(readFileSync(join(dirname(entry),'..','package.json'),'utf8')).version;
 if(require.cache[entry])throw Error('Native piece was loaded outside the safe loader');
 const source=neutralizePieceSource(pkg,readFileSync(entry),version),mod=new Module(entry);
 const external=[...source.matchAll(/require\(["']([^"']+)["']\)/g)].map(m=>m[1]).filter(x=>!builtinModules.includes(x)&&!x.startsWith('node:'));if(external.some(x=>x!=='jsdom')||(external.length&&pkg!=='@activepieces/piece-text-helper'))throw Error('Native bundle external dependency not reviewed');
 mod.require=id=>{if(!builtinModules.includes(id)&&!id.startsWith('node:'))throw Error('Native optional external dependency unavailable pending review');return Module.prototype.require.call(mod,id);};
 mod.filename=entry;mod.paths=Module._nodeModulePaths(dirname(entry));
 mod._compile(source,entry);mod.loaded=true;cache.set(pkg,mod.exports);return mod.exports;
}
