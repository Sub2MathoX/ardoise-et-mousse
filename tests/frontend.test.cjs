// Tests de parcours côté client sans dépendance à un navigateur installé.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../app/static/app.js'), 'utf8');
const fixture = {
  profiles:[{id:'alice',name:'Alice',color:'sage'}, {id:'guest',name:'Invité',color:'clay'}],
  active:{id:'keg',name:'Blonde maison',volume_ml:6000,served_ml:1000},
  stock:[], settings:{small_ml:250,large_ml:500},
};
function node() {
  return {innerHTML:'',textContent:'',hidden:false,open:false,className:'',
    showModal(){this.open=true;},close(){this.open=false;},append(){},remove(){},
    setAttribute(){},querySelector(){return null;},prepend(){}};
}
async function browser() {
  const elements = new Map(['#app','#dialog','#toast','#connection','#admin-body'].map(id=>[id,node()]));
  const stored = new Map();
  const calls = [];
  const sandbox={
    console,crypto:webcrypto,Intl,Date,AbortController,
    location:{pathname:'/'},
    document:{querySelector:s=>elements.get(s),querySelectorAll:()=>[],addEventListener(){},createElement:node,activeElement:null},
    sessionStorage:{getItem:k=>stored.get(k)||null,setItem:(k,v)=>stored.set(k,v),removeItem:k=>stored.delete(k)},
    setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},
    FormData:class {},
  };
  sandbox.fetch=async(url,opts)=>{calls.push({url,opts});return {ok:true,status:200,json:async()=>structuredClone(fixture)};};
  const context=vm.createContext(sandbox);
  vm.runInContext(source,context);
  await new Promise(resolve=>setImmediate(resolve));
  return {context,elements,stored,calls,run:code=>vm.runInContext(code,context),
    setFetch:fn=>{context.fetch=async(url,opts)=>{calls.push({url,opts});return fn(url,opts);};}};
}
test('la tablette affiche les profils et masque les montants',async()=>{
  const b=await browser();
  const html=b.elements.get('#app').innerHTML;
  assert.match(html,/Qui prend un verre/);assert.match(html,/Invité/);
  assert.doesNotMatch(html,/€|balance_cents|cost_cents/);
});
test('sélection puis formats configurables et champ libre',async()=>{
  const b=await browser();
  b.run("selectedProfile='alice'; publicData.settings.small_ml=125; renderTablet()");
  const html=b.elements.get('#app').innerHTML;
  assert.match(html,/À vous, Alice/);assert.match(html,/data-volume="12.5"/);
  assert.match(html,/data-volume="50"/);assert.match(html,/id="custom-volume"/);
});
test('aucun fût : les profils sont désactivés',async()=>{
  const b=await browser();
  b.run('publicData.active=null;renderTablet()');
  assert.match(b.elements.get('#app').innerHTML,/Aucun fût en service/);
  assert.match(b.elements.get('#app').innerHTML,/data-id="alice" disabled/);
});
test('les noms saisis sont échappés dans les écrans',async()=>{
  const b=await browser();
  b.run('publicData.profiles[0].name="<img src=x onerror=alert(1)>";renderTablet()');
  assert.doesNotMatch(b.elements.get('#app').innerHTML,/<img src=x/);
  assert.match(b.elements.get('#app').innerHTML,/&lt;img/);
});
test('une réponse perdue conserve la clé et bloque une deuxième opération',async()=>{
  const b=await browser();
  b.setFetch(async()=>{throw new TypeError('network');});
  await assert.rejects(b.run("mutate('/api/consume',{profile_id:'alice',keg_id:'keg',volume_cl:25})"),/Confirmation non reçue/);
  const original=JSON.parse(b.stored.get('pending'));
  await assert.rejects(b.run("mutate('/api/consume',{profile_id:'alice',keg_id:'keg',volume_cl:50})"),/en attente/);
  b.setFetch(async()=>({ok:true,status:200,json:async()=>({id:'receipt'})}));
  const result=await b.run('mutate(null,null,true)');
  assert.equal(result.id,'receipt');assert.equal(b.stored.has('pending'),false);
  const submissions=b.calls.filter(c=>c.url==='/api/consume');
  assert.equal(submissions.length,2);
  assert.equal(submissions[0].opts.headers['Idempotency-Key'],original.key);
  assert.equal(submissions[1].opts.headers['Idempotency-Key'],original.key);
  assert.equal(submissions[0].opts.body,submissions[1].opts.body);
});
test('une session expirée conserve l’opération pour reprise après connexion',async()=>{
  const b=await browser();
  b.setFetch(async()=>({ok:false,status:401,json:async()=>({error:'Connexion requise'})}));
  await assert.rejects(b.run("mutate('/api/admin/ledger',{amount_eur:10})"),/Connexion requise/);
  assert.equal(b.stored.has('pending'),true);
});
test('un fût obsolète rejette la saisie sans annoncer un succès',async()=>{
  const b=await browser();
  b.setFetch(async()=>({ok:false,status:409,json:async()=>({error:'Le fût a changé'})}));
  await assert.rejects(b.run("mutate('/api/consume',{keg_id:'ancien'})"),/Le fût a changé/);
  assert.equal(b.stored.has('pending'),false);
});
test('les six vues administrateur se rendent sur une base vide',async()=>{
  const b=await browser();
  b.setFetch(async()=>({ok:true,status:200,json:async()=>({entries:[]})}));
  b.run('adminData={profiles:[],kegs:[],settings:{small_ml:250,large_ml:500}}');
  for(const tab of ['dashboard','stock','profiles','balances','history','settings']){
    b.run(`currentTab='${tab}';renderAdmin()`);
    await new Promise(resolve=>setImmediate(resolve));
    assert.ok(b.elements.get('#admin-body').innerHTML.length>20);
    assert.doesNotMatch(b.elements.get('#admin-body').innerHTML,/undefined|NaN/);
  }
});
