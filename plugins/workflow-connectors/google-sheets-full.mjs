/** Expose the installed upstream catalogue, not a separately maintained subset. */
import {createHash} from 'node:crypto';
import {piece,runPieceAction} from './adapter.mjs';
import {serviceAccountAuth} from './sheets-api.mjs';
const PKG='@activepieces/piece-google-sheets';
const upstream=piece(PKG);
export const SHEETS_ACTIONS=upstream._actions;
export const SHEETS_TRIGGERS=upstream._triggers;
export const SHEETS_ACTION_KEYS=Object.fromEntries(Object.keys(SHEETS_ACTIONS).map(key=>[sheetType(key),key]));
function sheetType(key){return 'google-sheets-ap-'+createHash('sha256').update(key).digest('hex').slice(0,16);}
const complex=new Set(['JSON','OBJECT','ARRAY','DYNAMIC']);
function parse(value,name,prop,runtime=false){
  if(value===undefined||value===null||value===''){if(prop.required)throw Error(name+' is required');return undefined;}
  if(!runtime&&typeof value==='string'&&value.includes('{{'))return value;
 if(runtime&&typeof value==='string'&&value.includes('{{'))throw Error(name+': unresolved placeholder');
  if(prop.type==='CHECKBOX'){if(value===true||value==='true')return true;if(value===false||value==='false')return false;throw Error(name+': boolean required');}
  if(prop.type==='NUMBER'){const n=Number(value);if(!Number.isFinite(n))throw Error(name+': number required');return n;}
  if(complex.has(prop.type)) {if(typeof value!=='string')return value;try{return JSON.parse(value);}catch{throw Error(name+': valid JSON required');}}
  if(['DROPDOWN','STATIC_DROPDOWN'].includes(prop.type)&&typeof value==='number')return value;
  if(typeof value!=='string'||value.length>32000)throw Error(name+': invalid string');
  return value;
}
export function sheetFields(props){
 return Object.entries(props).filter(([,p])=>p.type!=='MARKDOWN').map(([key,p])=>({key,label:p.displayName||key,type:p.type==='CHECKBOX'?'boolean':p.type==='NUMBER'?'number':complex.has(p.type)?'text':p.type==='STATIC_DROPDOWN'?'select':'string',required:!!p.required,...(p.defaultValue!==undefined?{default:complex.has(p.type)?JSON.stringify(p.defaultValue):p.defaultValue}:{}),...(p.options?.options?{options:p.options.options.map(o=>String(o.value))}:{}),help:complex.has(p.type)?'Native Activepieces JSON input. Dynamic properties use their resolved object shape; use the property resolver to inspect fields.':p.description||'Native Activepieces input. Dropdowns accept their actual identifier.'}));
}
export function sheetProps(props,cfg,runtime=false){return Object.fromEntries(Object.entries(props).filter(([,p])=>p.type!=='MARKDOWN').map(([k,p])=>[k,parse(cfg[k]??p.defaultValue,k,p,runtime)]));}
const READ=new Set(['find_rows','find_row_by_num','get_next_rows','get-many-rows','read-data-range','find_spreadsheets','find-worksheet','export_sheet','sheets_find_rows','sheets_get_all_rows','sheets_get_next_rows','sheets_get_row','sheets_get_spreadsheet','sheets_get_values','sheets_search_spreadsheets','sheets_find_worksheet','sheets_export_worksheet']);
export function sheetsMutates(key,props={}){return key==='custom_api_call'?!['GET','HEAD'].includes(String(props.method??'GET')):!READ.has(key);}
function authOf(settings){if(!settings?.googleServiceAccount)throw Error('Managed Google connection required');return serviceAccountAuth(settings.googleServiceAccount,settings.googleUserEmail);}
/** Credential destinations cannot be supplied by a custom URL, redirect or auth header. */
export function validateCustomCall(props){
 if(!props.url||typeof props.url.url!=='string')throw Error('Custom API URL requires an object with url');
 let u;try{u=new URL(props.url.url,'https://sheets.googleapis.com/v4/');}catch{throw Error('Invalid Google API URL');}
 if(u.protocol!=='https:'||u.hostname!=='sheets.googleapis.com'||u.port||u.username||u.password||!u.pathname.startsWith('/v4/')||u.hash)throw Error('Custom calls are limited to the Google Sheets API');
 if([...u.searchParams.keys(),...Object.keys(props.queryParams??{})].some(k=>['access_token','oauth_token','key'].includes(k.toLowerCase())))throw Error('Custom query authentication is not allowed');
 if(props.followRedirects)throw Error('Custom API redirects are disabled');
 if(Object.keys(props.headers??{}).some(k=>['authorization','host','cookie','proxy-authorization'].includes(k.toLowerCase())))throw Error('Custom authentication headers are not allowed');
 props.url={...props.url,url:u.toString()};
}
export const sheetBlockType=sheetType;
export const GOOGLE_SHEETS_BLOCKS=Object.entries(SHEETS_ACTIONS).map(([key,action])=>({
 type:sheetBlockType(key),family:'Google Sheets · Activepieces',label:action.displayName+(action.audience==='ai'?' (API inputs)':''),simulated:false,category:'real',
 description:(action.description||action.displayName)+' Native Activepieces action; Simulation makes no external call. Real changes are external and not reverted by a branch.',
 fields:sheetFields(action.props??{}),outputs:[{key:'result',description:'Native Activepieces result (object/array/value)'},{key:'confirmed',description:'Action returned successfully, not a transaction guarantee'}],
 validate(cfg){const props=sheetProps(action.props??{},cfg);return {...Object.fromEntries(Object.keys(props).map(k=>[k,cfg[k]??action.props[k].defaultValue??''])),source:'google'};},
 async run(ctx){
  if(ctx.dryRun)return {confirmed:false,dryRun:true};
  const props=sheetProps(action.props??{},ctx.config,true);
  if(ctx.settings?.googleScope!=='account')throw Error('Full Sheets catalogue requires an explicitly account-scoped managed connection');
  if(key==='custom_api_call')validateCustomCall(props);
  const auth=authOf(ctx.settings);
  if(!ctx.pieceRuntime)throw Error('Durable Activepieces runtime unavailable');
  if(sheetsMutates(key,props)||['get_next_rows','sheets_get_next_rows'].includes(key)){if(!ctx.markEffectPending)throw Error('Durable effect tracking unavailable');await ctx.markEffectPending({kind:'google-sheets-action',action:key});}
  const invoke=()=>runPieceAction(PKG,key,{auth,propsValue:props,runtime:ctx.pieceRuntime});
  const result=ctx.pieceRuntime.withLock?await ctx.pieceRuntime.withLock(invoke):await invoke();
  return {result:result??null,confirmed:true};
 }
}));
export const GOOGLE_SHEETS_EVENTS=Object.fromEntries(Object.entries(SHEETS_TRIGGERS).map(([key,t])=>['google-sheets.ap-'+key.replaceAll('_','-'),{
 label:t.displayName+' (Activepieces)',payload:['*'],activepiecesTrigger:key,
 configFields:[{key:'connectionId',label:'Managed Google connection',type:'string',required:true},...sheetFields(t.props??{})],
}]));
export async function runSheetsTrigger(key,stage,{settings,config,runtime,payload,webhookUrl,isRepublish=false}){
 const t=SHEETS_TRIGGERS[key];if(!t||!['onEnable','onDisable','onRenew','run','test'].includes(stage))throw Error('Unknown Sheets trigger lifecycle');
 return t[stage]({auth:authOf(settings),propsValue:sheetProps(t.props??{},config,true),...runtime,payload:payload??{headers:{},body:{}},webhookUrl,isRepublish});
}
export async function resolveSheetProperty(key,property,{settings,config}){
 const action=SHEETS_ACTIONS[SHEETS_ACTION_KEYS[key]??key]??SHEETS_TRIGGERS[key],p=action?.props?.[property];if(!p)throw Error('Unknown Sheets property');
 const props=sheetProps(Object.fromEntries(Object.entries(action.props).map(([k,v])=>[k,{...v,required:false}])),config,true);
 const auth=authOf(settings);
 if(p.type==='DYNAMIC'&&typeof p.props==='function')return p.props({...props,auth},{searchValue:''});
 if(p.type==='DROPDOWN'&&typeof p.options==='function')return p.options({...props,auth},{searchValue:''});
 return p;
}
