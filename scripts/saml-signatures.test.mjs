import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { createSamlEngine } from '../plugins/saml-idp/handlers.mjs';
import { selfSignedCert } from '../plugins/saml-idp/selfsigned.mjs';
const require = createRequire(new URL('../plugins/saml-idp/package.json',import.meta.url));
const samlify = require('samlify');
const R='urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect', P='urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST';

test('SAML HTTP route accepts the registered signature and refuses unsigned or wrong-key requests', async () => {
  const key=selfSignedCert('Fictional test SP'), wrong=selfSignedCert('Wrong test SP');
  const app={ id:'signed',name:'Signed',enabled:true,protocol:'saml',entity_id:'https://sp.test',acs_url:'https://sp.test/acs',sp_certificate:key.certPem,want_signed_requests:true,allowed_roles:['employee'],attribute_mapping:{} };
  const engine=createSamlEngine({liveApps:async()=>[app],pluginActive:async()=>true,secretGet:async()=>undefined,env:{},emit:()=>{},warn:()=>{}});
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://localhost');
    req.originalUrl=req.url;req.params={tenant:'test'};req.path=url.pathname.replace('/sso/test/saml','');req.query=Object.fromEntries(url.searchParams);req.protocol='http';
    engine.route(req,res).catch(e=>{res.statusCode=500;res.end(String(e));});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const idp=signed=>samlify.IdentityProvider({entityID:base+'/sso/test/saml',wantAuthnRequestsSigned:signed,singleSignOnService:[{Binding:R,Location:base+'/sso/test/saml/login'}]});
  const sp=(signed,k)=>samlify.ServiceProvider({entityID:app.entity_id,signingCert:k.certPem,privateKey:k.privateKeyPem,authnRequestsSigned:signed,assertionConsumerService:[{Binding:P,Location:app.acs_url}]});
  try {
    for(const [label,signed,k,status] of [['valid',true,key,302],['unsigned',false,key,400],['wrong-key',true,wrong,400]]) {
      const r=sp(signed,k).createLoginRequest(idp(signed),'redirect',{relayState:'demo state & value'});
      const response=await fetch(r.context,{redirect:'manual'});
      assert.equal(response.status,status,`${label}: ${await response.text()}`);
    }
  } finally {await new Promise(resolve=>server.close(resolve));}
});

test('without a secret-store key the demonstration signing key is stable across restarts and environments', async () => {
  // Regression (11 Nov 2026): with no key in the secret store the IdP generated a fresh certificate per
  // process, so a redeploy - or any preview, a different process with its own key - signed assertions the
  // demo applications could not verify against the IdP metadata they had fetched earlier: samlify failed
  // the sign-in with ERROR_UNMATCH_CERTIFICATE_DECLARATION_IN_METADATA (reported on travelops.apps.dss.name).
  const app={ id:'travelops',name:'TravelOps',enabled:true,protocol:'saml',entity_id:'https://travelops.apps.dss.name/saml/metadata',acs_url:'https://travelops.apps.dss.name/saml/acs',allowed_roles:['traveler'],attribute_mapping:{NameID:'email',email:'email',roles:'roles'} };
  const lucie={ id:'demo-lucie',display_name:'Lucie Demo',email:'lucie.demo@example.invalid',department:'hr',roles:['traveler'] };
  const deps=()=>({liveApps:async()=>[app],pluginActive:async()=>true,directoryUser:async()=>lucie,secretGet:async()=>undefined,env:{},emit:()=>{},warn:()=>{}});

  const serve=(engine,host,path,query={})=>new Promise((resolve,reject)=>{
    const req={ params:{tenant:'acme-demo'},path,method:'GET',query,headers:{'x-forwarded-proto':'https','x-forwarded-host':host},originalUrl:`/sso/acme-demo/saml${path}` };
    const res={ statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v;},end(b){this.body=b;resolve(this);} };
    engine.route(req,res).catch(reject);
  });
  const certOf=async(engine,host)=>{ const r=await serve(engine,host,'/metadata'); return /<ds:X509Certificate>([^<]+)<\/ds:X509Certificate>/.exec(r.body)[1]; };

  // A response signed before a "restart" still verifies against the metadata a fresh process serves for
  // the SAME environment (same issuer): the application's cached metadata never goes stale on deploys.
  const prod=createSamlEngine(deps()), prodRestarted=createSamlEngine(deps());
  const prodCert=await certOf(prod,'lyam.dss.name'), restartedCert=await certOf(prodRestarted,'lyam.dss.name');
  assert.equal(restartedCert,prodCert,'two processes without a secret-store key publish the same certificate');
  const login=await serve(prod,'lyam.dss.name','/login',{app:'travelops'});
  assert.equal(login.statusCode,302);
  const rid=/\/sso-saml\/([0-9a-f]+)/.exec(login.headers.location)[1];
  const done=await prod.complete('acme-demo',rid,'demo-lucie','allow');
  assert.equal(done.acsUrl,app.acs_url);
  const idpForSp=samlify.IdentityProvider({ entityID:'https://lyam.dss.name/sso/acme-demo/saml',signingCert:restartedCert,singleSignOnService:[{Binding:R,Location:'https://lyam.dss.name/sso/acme-demo/saml/login'}] });
  const sp=samlify.ServiceProvider({ entityID:app.entity_id,wantAssertionsSigned:true,assertionConsumerService:[{Binding:P,Location:app.acs_url}] });
  const parsed=await sp.parseLoginResponse(idpForSp,'post',{body:{SAMLResponse:done.samlResponse}});
  assert.equal(parsed.extract.nameID,lucie.email,'the signed assertion still verifies after a restart');

  // Another environment (a preview) shares the certificate, but stays a different IdP: its responses keep
  // being refused against the prod metadata (issuer mismatch) - the application trusts one IdP entity.
  const preview=createSamlEngine(deps());
  const previewCert=await certOf(preview,'iam-pr86.onrender.com');
  assert.equal(previewCert,prodCert,'every environment publishes the same demonstration certificate');
  const previewLogin=await serve(preview,'iam-pr86.onrender.com','/login',{app:'travelops'});
  const previewRid=/\/sso-saml\/([0-9a-f]+)/.exec(previewLogin.headers.location)[1];
  const previewDone=await preview.complete('acme-demo',previewRid,'demo-lucie','allow');
  await assert.rejects(sp.parseLoginResponse(idpForSp,'post',{body:{SAMLResponse:previewDone.samlResponse}}),/ERR_UNMATCH_ISSUER/,'a response from another IdP entity is still refused');

  // A real deployment's secret-store key still wins over the demonstration fallback.
  const own=selfSignedCert('Fictional private deployment');
  const privateDeployment=createSamlEngine({ ...deps(),secretGet:async()=>({cert:own.certPem,privateKey:own.privateKeyPem}) });
  const privateCert=await certOf(privateDeployment,'iam.example.test');
  assert.equal(privateCert,own.certPem.replace(/-----[^-]+-----/g,'').replace(/\s/g,''),'the secret-store key is served');
  assert.notEqual(privateCert,prodCert,'and it is not the demonstration key');

  // So does a key carried by the environment (PEMs pasted single-line with escaped newlines included).
  const envKey=selfSignedCert('Fictional env deployment');
  const envDeployment=createSamlEngine({ ...deps(),env:{ IAM_SAML_SIGNING_CERT:envKey.certPem.replace(/\n/g,'\\n'),IAM_SAML_SIGNING_PRIVATE_KEY:envKey.privateKeyPem.replace(/\n/g,'\\n') } });
  const envCert=await certOf(envDeployment,'iam-env.example.test');
  assert.equal(envCert,envKey.certPem.replace(/-----[^-]+-----/g,'').replace(/\s/g,''),'the environment key is served');
  assert.notEqual(envCert,prodCert,'and it is not the demonstration key');

  // Precedence: the secret store beats the environment.
  const both=createSamlEngine({ ...deps(),secretGet:async()=>({cert:own.certPem,privateKey:own.privateKeyPem}),env:{ IAM_SAML_SIGNING_CERT:envKey.certPem,IAM_SAML_SIGNING_PRIVATE_KEY:envKey.privateKeyPem } });
  assert.equal(await certOf(both,'iam-both.example.test'),own.certPem.replace(/-----[^-]+-----/g,'').replace(/\s/g,''),'the secret store wins over the environment');
});
