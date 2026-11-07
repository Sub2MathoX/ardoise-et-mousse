'use strict';
const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const euro = (cents) => new Intl.NumberFormat('fr-FR', {style:'currency', currency:'EUR'}).format(cents / 100);
const number = (value) => new Intl.NumberFormat('fr-FR', {maximumFractionDigits:2}).format(value);
const liters = (ml) => `${number(ml / 1000)} L`;
const dateTime = (time) => new Date(time * 1000).toLocaleString('fr-FR', {dateStyle:'short', timeStyle:'short'});
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const paths = {
  glass:'M6 3h12l-2 17H8L6 3Zm1 5h10',
  keg:'M7 3h10M7 21h10M6 4c-3 4-3 12 0 16h12c3-4 3-12 0-16H6Zm-2 4h16M4 16h16M9 10h6v4H9z',
  arrow:'m9 5 7 7-7 7', back:'m15 5-7 7 7 7', plus:'M12 5v14M5 12h14',
  check:'m5 12 4 4L19 6', close:'m6 6 12 12M18 6 6 18',
  switch:'M4 7h15m-4-4 4 4-4 4M20 17H5m4-4-4 4 4 4',
  home:'m3 10 9-7 9 7v11h-6v-7H9v7H3V10Z',
  users:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM17 4a4 4 0 0 1 0 7M22 21v-2a4 4 0 0 0-3-4',
  wallet:'M3 5h17v15H3V5Zm0 0 13-3v3M15 11h6v5h-6v-5Z',
  settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',
  history:'M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v5l3 2',
  lock:'M5 10h14v11H5V10Zm3 0V6a4 4 0 0 1 8 0v4M12 14v3',
  logout:'M10 4H4v16h6M8 12h13m-4-4 4 4-4 4',
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.glass}"/></svg>`;
const brand = () => '<span class="brand-symbol">a<span>&</span>m</span><span class="brand-name">Ardoise & Mousse<small>Le comptoir de la maison</small></span>';
const avatar = (p, mini=false) => `<span class="avatar ${esc(p.color)} ${mini?'mini':''}">${esc(p.name.split(/\s+/).slice(0,2).map(s=>s[0]).join('').toUpperCase())}</span>`;
const empty = (title, message, action='') => `<div class="empty">${icon('glass')}<h3>${esc(title)}</h3><p>${esc(message)}</p>${action}</div>`;
const btn = (label, action, symbol='plus', extra='') => `<button class="btn ${extra}" data-action="${action}">${icon(symbol)}${label}</button>`;
const statusLabel = (k) => k.unassigned ? '<span class="pill red">À affecter</span>' : `<span class="pill ${k.status==='stock'?'amber':k.status==='closed'?'gray':'dot'}">${{active:'En service',stock:'En stock',closed:'Clôturé'}[k.status]}</span>`;
let publicData, adminData, selectedProfile=null, currentTab='dashboard', stockFilter='stock', detailId=null, isAdmin=location.pathname.startsWith('/admin'), loggedIn=false;
let busy=false, toastTimer, undoTimer, pending;
try { pending = JSON.parse(sessionStorage.getItem('pending') || 'null'); } catch { pending=null; }

function uuid() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(x=>x.toString(16).padStart(2,'0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
async function api(path, payload, key) {
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), 12000);
  try {
    const response = await fetch(path, {method:payload===undefined?'GET':'POST', credentials:'same-origin',
      headers:payload===undefined?{}:{'Content-Type':'application/json','X-AM-Request':'1',...(key?{'Idempotency-Key':key}:{})},
      body:payload===undefined?undefined:JSON.stringify(payload), signal:controller.signal});
    const data = await response.json();
    if (!response.ok) { const error=new Error(data.error || 'Erreur du serveur.'); error.status=response.status; throw error; }
    return data;
  } finally { clearTimeout(timer); }
}
function pendingBanner() {
  $('#connection').hidden = !pending;
  if (pending) $('#connection').innerHTML='Une opération attend une confirmation du serveur. <button class="btn" data-action="retry">Vérifier et réessayer</button>';
}
async function mutate(path, payload, retry=false) {
  if (busy) throw new Error('Une opération est déjà en cours.');
  if (pending && !retry) throw new Error('Vérifiez d’abord l’opération en attente en haut de l’écran.');
  busy=true;
  const operation = retry ? pending : {path,payload,key:uuid()};
  pending=operation;
  sessionStorage.setItem('pending',JSON.stringify(pending));
  try {
    const result=await api(operation.path,operation.payload,operation.key);
    pending=null; sessionStorage.removeItem('pending'); pendingBanner();
    return result;
  } catch(error) {
    if (error.status && error.status<500 && error.status!==401) { pending=null; sessionStorage.removeItem('pending'); }
    pendingBanner();
    if (!error.status || error.status>=500) throw new Error('Confirmation non reçue. Utilisez « Vérifier et réessayer » : aucun verre ne sera compté deux fois.');
    throw error;
  } finally { busy=false; }
}
function toast(message, error=false, duration=4500) {
  clearTimeout(toastTimer); clearInterval(undoTimer);
  $('#toast').className=`toast ${error?'error':''}`;
  $('#toast').textContent=message; $('#toast').hidden=false;
  toastTimer=setTimeout(()=>$('#toast').hidden=true,duration);
}
function servedToast(result) {
  toast(result.message,false,10000);
  const left = Math.max(0,result.undo_until-Math.floor(Date.now()/1000));
  if (!left) return;
  const button=document.createElement('button'); button.className='btn'; button.textContent=`Annuler (${left} s)`;
  $('#toast').append(button);
  button.onclick=async()=>{button.disabled=true;try{await mutate(`/api/consume/${result.id}/undo`,{token:result.undo_token});toast('Consommation annulée.');await refresh();}catch(e){toast(e.message,true);}};
  undoTimer=setInterval(()=>{const remaining=result.undo_until-Math.floor(Date.now()/1000);button.textContent=`Annuler (${Math.max(0,remaining)} s)`;if(remaining<=0){button.remove();clearInterval(undoTimer);}},250);
}
function modal(title, body) {
  const dialog=$('#dialog');
  dialog.innerHTML=`<div class="dialog-head"><h2 id="dialog-title">${esc(title)}</h2><button class="btn quiet small" data-action="close-modal" aria-label="Fermer">${icon('close')}</button></div><div class="dialog-body">${body}</div>`;
  if (!dialog.open) dialog.showModal();
}
function closeModal() { $('#dialog').close(); }
function formError(form, message) {
  let error=form.querySelector('.form-error');
  if (!error) {error=document.createElement('div');error.className='notice error form-error full';error.setAttribute('role','alert');form.prepend(error);}
  error.textContent=message;
}
function fields(form) { return Object.fromEntries(new FormData(form)); }
function options(profiles, selected='') { return profiles.map(p=>`<option value="${esc(p.id)}" ${p.id===selected?'selected':''}>${esc(p.name)}${p.active===0?' (archivé)':''}</option>`).join(''); }
const actions=(label='Enregistrer')=>`<div class="dialog-actions full"><button type="button" class="btn" data-action="close-modal">Annuler</button><button class="btn primary" type="submit">${label}</button></div>`;

function kegCard() {
  const k=publicData.active;
  const remaining=k?Math.max(0,k.volume_ml-k.served_ml):0;
  return `<aside><div class="tap-card"><span class="eyebrow">À la pression</span><span class="pill dot">${k?'Le fût du moment':'Le comptoir est en pause'}</span><h2>${k?esc(k.name):'Un nouveau fût ?'}</h2><p class="beer-type">${k?`${liters(k.volume_ml)} à partager entre amis`:'Choisissez un fût dans votre réserve.'}</p><div class="keg-art"><svg viewBox="0 0 100 130" aria-hidden="true"><path d="M28 10h44l7 11c9 17 9 73 0 90l-7 9H28l-7-9c-9-17-9-73 0-90l7-11Z"/><path d="M23 25h54M18 38h64M18 94h64M23 107h54M36 10V4h28v6M30 52h40v28H30z"/><text x="50" y="71" fill="currentColor" stroke="none" text-anchor="middle" font-family="Georgia" font-size="15">a&amp;m</text></svg></div>${k?`<progress class="meter" max="${k.volume_ml}" value="${remaining}" aria-label="Volume restant estimé"></progress><div class="remaining"><span>Restant estimé</span><strong>${liters(remaining)}</strong></div>`:''}<button class="btn" data-action="switch">${icon('switch')}${k?'Changer le fût':'Ouvrir un fût'}</button></div><p class="tap-note">${k&&k.served_ml>k.volume_ml?'Le volume saisi dépasse la capacité du fût. Les consommations restent possibles.':'Les bons moments se partagent.<br>Les comptes aussi.'}</p></aside>`;
}
function renderTablet() {
  const selected=publicData.profiles.find(p=>p.id===selectedProfile);
  if (!selected) selectedProfile=null;
  const k=publicData.active;
  let content;
  if (selected && k) {
    content=`<button class="btn quiet small" data-action="back-profiles">${icon('back')}Changer de personne</button><div class="serve-heading">${avatar(selected)}<div><span class="eyebrow">C’est votre tournée de compteur</span><h1>À vous, ${esc(selected.name)}.</h1></div></div><div class="sizes">${[publicData.settings.small_ml,publicData.settings.large_ml].map((ml,i)=>`<button class="size-btn" data-action="serve" data-volume="${ml/10}">${icon('glass')}<strong>${number(ml/10)} <small>cl</small></strong><span>${i===0?'Le petit verre':'Le grand verre'}</span></button>`).join('')}</div><form id="custom-volume" class="custom-volume"><label>Un autre format<input name="volume_cl" aria-label="Volume personnalisé en centilitres" placeholder="Volume en cl" type="number" inputmode="decimal" step="0.1" min="0.1" max="500" required></label><button class="btn" type="submit">${icon('plus')}Compter</button></form><p class="hint">Une pression pour enregistrer. Vous aurez 10 secondes pour annuler.</p>`;
  } else {
    content=`<div class="choose-heading"><span class="eyebrow">Bienvenue au comptoir</span><h1>Qui prend un verre ?</h1><p>Votre prénom, votre format. Et santé !</p></div>`;
    if (!k) content+=`<div class="notice">Aucun fût en service. Ouvrez un fût pour commencer à compter les verres.</div>`;
    content+=publicData.profiles.length?`<div class="profiles-grid">${publicData.profiles.map(p=>`<button class="person" data-action="select-profile" data-id="${p.id}" ${!k?'disabled':''}>${avatar(p)}<span class="person-name">${esc(p.name)}</span></button>`).join('')}</div>`:empty('Faisons connaissance','Ajoutez les premiers profils dans le back-office. Le profil invité se crée de la même façon.','<a class="btn primary" href="/admin">Configurer le comptoir</a>');
  }
  $('#app').innerHTML=`<main class="tablet"><header class="tablet-header"><a class="brand" href="/">${brand()}</a><span class="tablet-date">${new Date().toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long'})}</span></header><div class="tablet-layout">${kegCard()}<section>${content}</section></div><footer class="tablet-footer"><span>Un verre à la fois, chacun sa part.</span><a href="/admin">${icon('lock')} Back-office</a></footer></main>`;
}
async function serve(volume) {
  if (busy) return;
  const payload={profile_id:selectedProfile,keg_id:publicData.active.id,volume_cl:volume};
  document.querySelectorAll('.size-btn, #custom-volume button').forEach(b=>b.disabled=true);
  try {const result=await mutate('/api/consume',payload);selectedProfile=null;servedToast(result);await refresh();}
  catch(e){toast(e.message,true);await refresh();}
}
async function switchModal() {
  publicData=await api('/api/public');
  if (!isAdmin) renderTablet();
  const k=publicData.active;
  modal(k?'Changer le fût':'Ouvrir un fût',`<p>${k?`Le fût <strong>${esc(k.name)}</strong> sera clôturé et son coût réparti. Choisissez son remplaçant.`:'Choisissez le prochain fût à mettre en service.'}</p>${publicData.stock.length?publicData.stock.map(s=>`<button class="stock-choice" data-action="confirm-switch" data-id="${s.id}">${icon('keg')}<span><strong>${esc(s.name)}</strong><small>${liters(s.volume_ml)} · acheté le ${esc(s.purchased_on.split('-').reverse().join('/'))}</small></span>${icon('arrow')}</button>`).join(''):'<div class="notice">La réserve est vide. Enregistrez vos achats dans le back-office.</div>'}${k?'<button class="btn wide quiet" data-action="confirm-switch" data-id="">Terminer ce fût sans remplaçant</button>':''}`);
}
function confirmSwitch(id) {
  const next=publicData.stock.find(k=>k.id===id), active=publicData.active;
  modal('On change de fût ?',`<p>${active?`Terminer <strong>${esc(active.name)}</strong>`:'Le comptoir est prêt'}${next?` et ouvrir <strong>${esc(next.name)}</strong>.`:'. Aucun nouveau fût ne sera ouvert.'}</p><p>Vérifiez que les derniers verres ont bien été enregistrés.</p><form id="switch-form"><input type="hidden" name="next" value="${esc(id)}"><input type="hidden" name="expected" value="${active?.id||''}">${actions(next?'Confirmer le changement':'Terminer le fût')}</form>`);
}

const tabs=[['dashboard','home','Vue d’ensemble'],['stock','keg','Les fûts'],['profiles','users','Les profils'],['balances','wallet','Les ardoises'],['history','history','Journal'],['settings','settings','Réglages']];
function renderLogin() {
  $('#app').innerHTML=`<main class="login-page"><a class="brand" href="/">${brand()}</a><section class="panel"><span class="eyebrow">Espace administrateur</span><h1>Derrière le comptoir.</h1><p>Connectez-vous pour gérer les fûts, les profils et les ardoises.</p><form id="login-form"><label>Mot de passe<input name="password" type="password" autocomplete="current-password" required minlength="12"></label><button class="btn primary" type="submit">Entrer dans le back-office ${icon('arrow')}</button></form></section><a class="back" href="/">Retour à la tablette</a></main>`;
}
function renderAdmin() {
  const titles={dashboard:'Tout est sous contrôle.',stock:'La réserve du comptoir.',profiles:'Les habitués de la maison.',balances:'Les bons comptes.',history:'La mémoire du comptoir.',settings:'À votre façon.'};
  const topAction=currentTab==='stock'?btn('Ajouter un achat','new-keg','plus','primary'):currentTab==='profiles'?btn('Ajouter un profil','new-profile','plus','primary'):'';
  $('#app').innerHTML=`<div class="admin-layout"><aside class="sidebar"><a href="/admin" class="brand">${brand()}</a><nav class="nav" aria-label="Administration">${tabs.map(([id,symbol,label])=>`<button class="${id===currentTab?'active':''}" data-action="tab" data-id="${id}" ${id===currentTab?'aria-current="page"':''}>${icon(symbol)}${label}</button>`).join('')}</nav><div class="sidebar-foot"><a class="btn" href="/">${icon('glass')}Ouvrir la tablette</a><button class="btn quiet" data-action="logout">${icon('logout')}Déconnexion</button></div></aside><main class="admin-content"><header class="admin-top"><div><span class="eyebrow">Back-office / ${tabs.find(t=>t[0]===currentTab)[2]}</span><h1>${titles[currentTab]}</h1></div>${topAction}</header><div id="admin-body"></div><footer class="admin-footer">Ardoise & Mousse · Le comptoir de la maison</footer></main></div>`;
  const renderers={dashboard:dashboardView,stock:stockView,profiles:profilesView,balances:balancesView,history:historyView,settings:settingsView};
  renderers[currentTab]();
}
function dashboardView() {
  const active=adminData.kegs.find(k=>k.status==='active'), stock=adminData.kegs.filter(k=>k.status==='stock');
  const unpaid=adminData.profiles.reduce((sum,p)=>sum+Math.max(0,p.balance_cents),0), unassigned=adminData.kegs.filter(k=>k.unassigned);
  $('#admin-body').innerHTML=`${unassigned.length?`<div class="notice">${unassigned.length} fût(s) clôturé(s) sans consommation : coût à affecter depuis l’onglet Les fûts.</div>`:''}<div class="stats"><div class="stat featured"><span class="eyebrow">À recevoir</span><div class="value">${euro(unpaid)}</div><small>Ardoises des fûts clôturés</small></div><div class="stat"><span class="eyebrow">Dans la réserve</span><div class="value">${stock.length} <small>fût${stock.length>1?'s':''}</small></div><small>${liters(stock.reduce((s,k)=>s+k.volume_ml,0))} à partager</small></div><div class="stat"><span class="eyebrow">Autour du comptoir</span><div class="value">${adminData.profiles.filter(p=>p.active).length}</div><small>Profils actifs</small></div></div><div class="dashboard-grid"><section class="panel"><div class="section-head"><h2>À la pression</h2>${active?statusLabel(active):''}</div>${active?`<span class="eyebrow">${liters(active.volume_ml)} · ${euro(active.cost_cents)}</span><h2>${esc(active.name)}</h2><p class="muted">${liters(active.served_ml)} enregistrés · ${liters(Math.max(0,active.volume_ml-active.served_ml))} restants estimés</p><div class="simple-list">${Object.entries(active.allocation).map(([id,cost])=>`<div class="simple-item"><span>${esc(adminData.profiles.find(p=>p.id===id)?.name)}</span><span class="money">${euro(cost)}</span></div>`).join('')}</div><p class="hint">Répartition provisoire. Les montants seront fixés à la clôture.</p><div class="dialog-actions">${btn('Détail du fût','keg-detail','arrow','small').replace('data-action="keg-detail"',`data-action="keg-detail" data-id="${active.id}"`)}</div>`:empty('Le comptoir est en pause','Enregistrez vos achats puis ouvrez un fût depuis la tablette.','<a class="btn" href="/">Ouvrir la tablette</a>')}</section><section class="panel"><div class="section-head"><h2>Les ardoises</h2><button class="btn quiet small" data-action="tab" data-id="balances">Tout voir ${icon('arrow')}</button></div>${adminData.profiles.length?adminData.profiles.slice().sort((a,b)=>b.balance_cents-a.balance_cents).slice(0,6).map(p=>`<div class="simple-item">${avatar(p,true)}<div class="details"><strong>${esc(p.name)}</strong><small>${p.balance_cents<0?'Crédit disponible':p.balance_cents===0?'Tout est réglé':'À régler'}</small></div><span class="money">${euro(p.balance_cents)}</span></div>`).join(''):empty('Personne pour le moment','Créez les profils des habitués pour commencer.')}</section></div>`;
}
function stockView() {
  const list=adminData.kegs.filter(k=>k.status===stockFilter);
  $('#admin-body').innerHTML=`<div class="sub-tabs">${[['stock','En réserve'],['active','En service'],['closed','Clôturés']].map(([id,label])=>`<button class="${stockFilter===id?'active':''}" data-action="stock-filter" data-id="${id}">${label} · ${adminData.kegs.filter(k=>k.status===id).length}</button>`).join('')}</div><section class="panel">${list.length?`<div class="table-wrap"><table><thead><tr><th>Bière</th><th>Volume</th><th>Coût</th><th>État</th><th>Actions</th></tr></thead><tbody>${list.map(k=>`<tr><td><span class="table-name">${esc(k.name)}</span><small>Achat du ${esc(k.purchased_on.split('-').reverse().join('/'))}</small></td><td>${liters(k.volume_ml)}${k.status!=='stock'?`<small>${liters(k.served_ml)} saisis</small>`:''}</td><td class="money">${euro(k.cost_cents)}</td><td>${statusLabel(k)}</td><td><button class="btn small" data-action="${k.status==='stock'?'edit-keg':'keg-detail'}" data-id="${k.id}">${k.status==='stock'?'Modifier':'Détails'} ${icon('arrow')}</button></td></tr>`).join('')}</tbody></table></div>`:empty(stockFilter==='stock'?'La réserve est vide.':'Aucun fût ici pour le moment.',stockFilter==='stock'?'Enregistrez votre prochain achat. Vous pouvez ajouter plusieurs fûts identiques en une seule fois.':'Les fûts apparaîtront ici au fil des tournées.',stockFilter==='stock'?btn('Ajouter un achat','new-keg','plus','primary'):'')}</section>`;
}
function profilesView() {
  $('#admin-body').innerHTML=adminData.profiles.length?`<div class="profile-admin-grid">${adminData.profiles.map(p=>`<article class="panel profile-admin ${!p.active?'archived':''}"><div class="row">${avatar(p)}<div><h3>${esc(p.name)}</h3><small>${p.active?'Sur la tablette':'Archivé'} · ordre ${p.position}</small></div></div><div class="row between"><span class="money">${euro(p.balance_cents)}</span><button class="btn small" data-action="edit-profile" data-id="${p.id}">Modifier</button></div></article>`).join('')}</div>`:empty('Invitez les habitués.','Créez un profil par personne, y compris pour vous et vos invités.',btn('Premier profil','new-profile','plus','primary'));
}
function balancesView() {
  $('#admin-body').innerHTML=`<div class="notice">Les fûts en cours ne sont pas encore facturés. Un solde négatif représente un crédit pour la personne.</div><section class="panel">${adminData.profiles.length?`<div class="table-wrap"><table><thead><tr><th>Personne</th><th>Solde</th><th>Actions</th></tr></thead><tbody>${adminData.profiles.map(p=>`<tr><td><div class="row">${avatar(p,true)}<span class="table-name">${esc(p.name)}${!p.active?' (archivé)':''}</span></div></td><td class="money">${euro(p.balance_cents)}</td><td><div class="row wrap"><button class="btn small" data-action="ledger-detail" data-id="${p.id}">Historique</button><button class="btn small primary" data-action="payment" data-id="${p.id}">Règlement</button><button class="btn quiet small" data-action="adjustment" data-id="${p.id}">Ajuster</button></div></td></tr>`).join('')}</tbody></table></div>`:empty('Les comptes sont à zéro.','Les ardoises se rempliront à la clôture du premier fût.')}</section>`;
}
async function historyView() {
  $('#admin-body').innerHTML='<p class="muted">Chargement du journal…</p>';
  try {
    const data=await api('/api/admin/audit');
    if(currentTab!=='history') return;
    const labels={'consumption.created':'Verre enregistré','consumption.undone':'Verre annulé','consumption.corrected':'Consommation corrigée','keg.switched':'Changement de fût','keg.saved':'Fût enregistré','profile.saved':'Profil enregistré','ledger.created':'Écriture d’ardoise','settings.changed':'Formats modifiés','keg.assigned':'Coût affecté'};
    $('#admin-body').innerHTML=`<section class="panel"><p class="hint">Les 200 dernières opérations. Les actions sur tablette sont en accès libre ; le profil consommateur ne prouve pas qui a effectué la saisie.</p>${data.entries.length?data.entries.map(e=>`<details class="simple-item"><summary>${esc(labels[e.action]||e.action)} <small>${dateTime(e.created_at)}</small></summary><pre class="audit-detail">${esc(JSON.stringify(JSON.parse(e.detail),null,2))}</pre></details>`).join(''):empty('Une page blanche.','Les opérations seront conservées ici.')}</section>`;
  }catch(e){toast(e.message,true);}
}
function settingsView() {
  $('#admin-body').innerHTML=`<section class="panel settings-panel"><h2>Les formats du comptoir</h2><p>Deux raccourcis pour les verres habituels. Le volume libre reste disponible sur la tablette, de 0,1 à 500 cl.</p><form id="settings-form" class="form-grid"><label>Premier bouton (cl)<input type="number" name="small_cl" value="${adminData.settings.small_ml/10}" min="0.1" max="500" step="0.1" required></label><label>Deuxième bouton (cl)<input type="number" name="large_cl" value="${adminData.settings.large_ml/10}" min="0.1" max="500" step="0.1" required></label><div class="full"><button class="btn primary" type="submit">Enregistrer les formats</button></div></form></section><section class="panel settings-panel"><h2>Le partage des coûts</h2><p>Chaque fût est réparti selon les volumes enregistrés. Les pertes sont donc partagées entre les consommateurs. Les centimes restants sont attribués aux plus grands restes de calcul.</p><p>Un fût clôturé sans consommation reste à affecter. Les corrections des fûts clôturés recalculent les parts et conservent les règlements.</p><button class="btn" data-action="logout">${icon('logout')}Déconnexion du back-office</button></section>`;
}
function profileModal(id) {
  const p=adminData.profiles.find(p=>p.id===id)||{name:'',color:'sage',position:adminData.profiles.length,active:1};
  modal(id?'Modifier le profil':'Une place au comptoir',`<form id="profile-form" class="form-grid"><input name="id" type="hidden" value="${esc(id||'')}"><label class="full">Prénom ou nom<input name="name" value="${esc(p.name)}" maxlength="40" required autocomplete="off" placeholder="Ex. Mathieu ou Invité"></label><label>Couleur<select name="color">${[['sage','Sauge'],['amber','Ambre'],['rose','Rose'],['blue','Bleu'],['lavender','Lavande'],['clay','Argile']].map(([v,n])=>`<option value="${v}" ${v===p.color?'selected':''}>${n}</option>`).join('')}</select></label><label>Ordre sur la tablette<input name="position" type="number" min="0" max="999" value="${p.position}" required></label><label class="check full"><input name="active" type="checkbox" ${p.active?'checked':''}>Afficher ce profil sur la tablette</label><p class="full field-help">Archiver un profil conserve ses consommations et son ardoise.</p>${actions()}</form>`);
}
function kegModal(id) {
  const k=adminData.kegs.find(k=>k.id===id)||{name:'',volume_ml:6000,cost_cents:0,purchased_on:today()};
  modal(id?'Modifier le fût':'Un nouvel achat',`<p>Un prix par fût, consigne exclue si elle vous est remboursée. Chaque exemplaire aura son propre suivi.</p><form id="keg-form" class="form-grid"><input name="id" type="hidden" value="${esc(id||'')}"><label class="full">Nom de la bière<input name="name" value="${esc(k.name)}" maxlength="80" placeholder="Ex. Leffe Blonde" required></label><label>Volume par fût (L)<input type="number" name="volume_l" min="0.001" max="100" step="0.001" value="${k.volume_ml/1000}" required></label><label>Coût par fût (€)<input type="number" name="cost_eur" min="0" max="10000" step="0.01" value="${id?k.cost_cents/100:''}" placeholder="Ex. 32,90" required></label><label>Date d’achat<input type="date" name="purchased_on" value="${k.purchased_on}" required></label>${!id?'<label>Nombre de fûts identiques<input name="quantity" type="number" value="1" min="1" max="100" required></label>':''}${actions(id?'Enregistrer':'Ajouter à la réserve')}</form>`);
}
function paymentModal(id, adjustment=false) {
  const p=adminData.profiles.find(p=>p.id===id);
  modal(adjustment?'Ajuster une ardoise':'Enregistrer un règlement',`<p><strong>${esc(p.name)}</strong> · Solde actuel : ${euro(p.balance_cents)}</p><form id="ledger-form" class="form-grid"><input name="profile_id" type="hidden" value="${id}"><input name="kind" type="hidden" value="${adjustment?'adjustment':'payment'}"><label class="full">${adjustment?'Montant signé (€)':'Montant reçu (€)'}<input name="amount_eur" type="number" step="0.01" ${adjustment?'min="-10000"':'min="0.01"'} max="10000" value="${!adjustment&&p.balance_cents>0?(p.balance_cents/100).toFixed(2):''}" required></label>${adjustment?'<p class="field-help full">Un montant positif augmente la dette ; un montant négatif la réduit. Pour annuler un règlement erroné, ajoutez un ajustement positif du même montant.</p>':''}<label class="full">Motif ou moyen de règlement<input name="note" maxlength="250" required placeholder="${adjustment?'Ex. Correction de saisie':'Ex. Virement reçu'}"></label>${actions()}</form>`);
}
async function ledgerModal(id) {
  const p=adminData.profiles.find(p=>p.id===id), data=await api(`/api/admin/profiles/${id}/ledger`);
  const labels={allocation:'Part de fût',payment:'Règlement',adjustment:'Ajustement'};
  modal(`L’ardoise de ${p.name}`,`<div class="detail-summary"><div><small>Solde actuel</small><strong>${euro(p.balance_cents)}</strong></div></div>${data.entries.length?data.entries.map(e=>`<div class="simple-item"><div class="details"><strong>${labels[e.kind]}</strong><small>${esc(e.note)}</small><small>${dateTime(e.created_at)}</small></div><span class="money">${e.amount_cents>0?'+':''}${euro(e.amount_cents)}</span></div>`).join(''):'<p>Aucune écriture pour le moment.</p>'}`);
}
let detailData;
async function kegDetail(id) {
  detailId=id; detailData=await api(`/api/admin/kegs/${id}`);
  const {keg:k,entries}=detailData;
  modal(k.name,`<div class="detail-summary"><div><small>Coût à répartir</small><strong>${euro(k.cost_cents)}</strong></div><div><small>Volume enregistré</small><strong>${liters(k.served_ml)}</strong></div></div>${k.served_ml>k.volume_ml?'<div class="notice">Le volume enregistré dépasse la capacité du fût. Vérifiez les saisies.</div>':''}${k.status==='closed'?'<div class="notice">Une correction recalculera les parts. Les écarts seront inscrits aux ardoises sans effacer les règlements.</div>':'<p>Répartition provisoire, fixée à la clôture du fût.</p>'}${Object.keys(k.allocation).length?`<div class="simple-list">${Object.entries(k.allocation).map(([pid,amount])=>`<div class="simple-item"><span>${esc(adminData.profiles.find(p=>p.id===pid)?.name)}</span><strong>${euro(amount)}</strong></div>`).join('')}</div>`:''}${!k.served_ml&&k.status==='closed'?`<div class="notice">${k.manual_assignee?`Coût affecté à ${esc(adminData.profiles.find(p=>p.id===k.manual_assignee)?.name)}.`:'Aucun verre enregistré : ce coût reste à affecter.'}</div><button class="btn" data-action="assign" data-id="${id}">Affecter le coût</button>`:''}<div class="section-head"><h3>Consommations</h3><button class="btn small" data-action="add-consumption">${icon('plus')}Ajouter un oubli</button></div>${entries.length?entries.map(e=>`<div class="simple-item"><div class="details ${e.cancelled_at?'cancelled':''}"><strong>${esc(e.name)} · ${number(e.volume_ml/10)} cl</strong><small>${dateTime(e.created_at)}${e.cancelled_at?' · annulée':''}</small></div><button class="btn small quiet" data-action="edit-consumption" data-id="${e.id}">Corriger</button></div>`).join(''):'<p>Aucune consommation enregistrée.</p>'}`);
}
function correctionModal(id) {
  const e=detailData.entries.find(c=>c.id===id);
  modal(e?'Corriger une consommation':'Ajouter une consommation oubliée',`<p>Fût : ${esc(detailData.keg.name)}.${detailData.keg.status==='closed'?' Les ardoises seront recalculées.':''}</p><form id="correction-form" class="form-grid"><input name="id" type="hidden" value="${id||''}"><input name="keg_id" type="hidden" value="${detailId}"><label class="full">Personne<select name="profile_id" required>${options(adminData.profiles,e?.profile_id)}</select></label><label class="full">Volume (cl)<input name="volume_cl" type="number" min="0.1" max="500" step="0.1" value="${e?e.volume_ml/10:25}" required></label>${e?'<label class="check full"><input type="checkbox" name="cancel">Annuler cette consommation</label>':''}<label class="full">Motif de la correction<input name="note" maxlength="250" required placeholder="Ex. Verre oublié ou mauvais profil"></label>${actions('Enregistrer la correction')}</form>`);
}
function assignModal(id) {
  modal('Affecter le coût du fût',`<p>Le coût complet sera porté sur l’ardoise du profil sélectionné.</p><form id="assign-form" class="form-grid"><input name="id" type="hidden" value="${id}"><label class="full">Profil<select name="profile_id" required>${options(adminData.profiles)}</select></label><label class="full">Motif<input name="note" maxlength="250" required></label>${actions('Affecter le coût')}</form>`);
}
async function refresh() {
  if(isAdmin) {
    try {adminData=await api('/api/admin');loggedIn=true;renderAdmin();}
    catch(e){if(e.status===401){loggedIn=false;renderLogin();}else{throw e;}}
  } else {publicData=await api('/api/public');renderTablet();}
}
document.addEventListener('click',async(event)=>{
  const target=event.target.closest('[data-action]');if(!target||target.disabled)return;
  const action=target.dataset.action,id=target.dataset.id;
  try {
    if(action==='close-modal')closeModal();
    else if(action==='select-profile'){selectedProfile=id;renderTablet();}
    else if(action==='back-profiles'){selectedProfile=null;renderTablet();}
    else if(action==='serve')await serve(target.dataset.volume);
    else if(action==='switch')await switchModal();
    else if(action==='confirm-switch')confirmSwitch(id);
    else if(action==='tab'){currentTab=id;renderAdmin();}
    else if(action==='stock-filter'){stockFilter=id;stockView();}
    else if(action==='new-profile'||action==='edit-profile')profileModal(id);
    else if(action==='new-keg'||action==='edit-keg')kegModal(id);
    else if(action==='payment'||action==='adjustment')paymentModal(id,action==='adjustment');
    else if(action==='ledger-detail')await ledgerModal(id);
    else if(action==='keg-detail')await kegDetail(id);
    else if(action==='add-consumption'||action==='edit-consumption')correctionModal(id);
    else if(action==='assign')assignModal(id);
    else if(action==='logout'){await api('/api/logout',{});loggedIn=false;renderLogin();}
    else if(action==='reload'){await refresh();}
    else if(action==='retry'){
      if(!pending)return;
      const path=pending.path;
      const result=await mutate(null,null,true);
      if(path==='/api/consume'){selectedProfile=null;servedToast(result);}else toast('Opération confirmée.');
      closeModal();await refresh();
    }
  } catch(e){toast(e.message,true);}
});
document.addEventListener('submit',async(event)=>{
  event.preventDefault();const form=event.target;if(busy)return;
  // Un champ nommé "id" masque form.id : lire l’attribut du formulaire.
  const formId=form.getAttribute('id');
  const data=fields(form), button=form.querySelector('[type="submit"]');
  if(button)button.disabled=true;
  try{
    if(formId==='custom-volume'){await serve(data.volume_cl);return;}
    if(formId==='login-form'){await api('/api/login',{password:data.password});await refresh();return;}
    if(formId==='profile-form')await mutate('/api/admin/profiles',{...data,position:Number(data.position),active:form.elements.active.checked});
    else if(formId==='keg-form')await mutate('/api/admin/kegs',{...data,quantity:Number(data.quantity||1)});
    else if(formId==='settings-form')await mutate('/api/admin/settings',data);
    else if(formId==='ledger-form')await mutate('/api/admin/ledger',data);
    else if(formId==='correction-form')await mutate('/api/admin/consumptions',{...data,cancel:form.elements.cancel?.checked||false});
    else if(formId==='assign-form')await mutate(`/api/admin/kegs/${data.id}/assign`,data);
    else if(formId==='switch-form')await mutate('/api/switch',{expected_keg_id:data.expected||null,next_keg_id:data.next||null});
    else throw new Error('Formulaire non reconnu. Actualisez la page avant de réessayer.');
    closeModal();toast('C’est enregistré.');await refresh();
  }catch(e){formError(form,e.message);}
  finally{if(button)button.disabled=false;}
});
async function start(){
  pendingBanner();
  try{await refresh();}catch(e){$('#app').innerHTML=`<main class="login-page">${empty('Le comptoir est injoignable.','Vérifiez que le serveur est démarré et que la tablette est connectée au réseau.',btn('Réessayer','reload','history','primary'))}</main>`;}
}
setInterval(async()=>{
  if(isAdmin||busy||$('#dialog').open||document.activeElement?.tagName==='INPUT')return;
  try{const next=await api('/api/public');if(JSON.stringify(next)!==JSON.stringify(publicData)){publicData=next;renderTablet();}}catch{/* La saisie ne sera confirmée que par le serveur. */}
},15000);
start();
