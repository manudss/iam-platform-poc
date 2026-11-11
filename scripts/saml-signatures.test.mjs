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
