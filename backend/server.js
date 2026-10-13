const express=require('express'),cors=require('cors'),jwt=require('jsonwebtoken'),bcrypt=require('bcryptjs');
const {createClient}=require('@supabase/supabase-js');
const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_KEY);
const app=express();app.use(express.json());
app.use(cors({origin:process.env.FRONT_ORIGIN||'*'}));
const wrap=f=>(q,r)=>f(q,r).catch(e=>r.status(500).json({error:e.message}));
const auth=(roles)=>(q,r,n)=>{try{const t=(q.headers.authorization||'').slice(7);
  q.user=jwt.verify(t,process.env.JWT_SECRET);
  if(roles&&!roles.includes(q.user.role))return r.status(403).json({error:'Accès refusé'});n();}
  catch{r.status(401).json({error:'Connexion requise'})}};
const ADMIN=auth(['admin']),WRITER=auth(['admin','data_admin']);
const ok=(r,{data,error})=>error?r.status(400).json({error:error.message}):r.json(data);

// Amorçage : crée le compte du Ministère (admin principal) si aucun utilisateur
(async()=>{const {count}=await db.from('users').select('*',{count:'exact',head:true});
 if(!count&&process.env.ADMIN_EMAIL)await db.from('users').insert({email:process.env.ADMIN_EMAIL,
  nom:'Ministère du Travail',role:'admin',institution:'DT',hash:bcrypt.hashSync(process.env.ADMIN_PASSWORD,10)});})();

app.get('/',(q,r)=>r.json({service:'LMIS Djibouti',ok:true}));
app.post('/auth/login',wrap(async(q,r)=>{const {data:u}=await db.from('users').select('*').eq('email',q.body.email).maybeSingle();
 if(!u||!bcrypt.compareSync(q.body.password||'',u.hash))return r.status(401).json({error:'Identifiants invalides'});
 const user={id:u.id,email:u.email,nom:u.nom,role:u.role,institution:u.institution};
 r.json({token:jwt.sign(user,process.env.JWT_SECRET,{expiresIn:'8h'}),user});}));
// Admin : créer des comptes (administrateurs de données, lecteurs/ministres)
app.post('/users',ADMIN,wrap(async(q,r)=>{const {email,nom,role,institution,password}=q.body;
 ok(r,await db.from('users').insert({email,nom,role,institution,hash:bcrypt.hashSync(password,10)}).select('id,email,role,institution').single());}));
app.get('/users',ADMIN,wrap(async(q,r)=>ok(r,await db.from('users').select('id,email,nom,role,institution'))));

// Lecture publique (diffusion)
app.get('/institutions',wrap(async(q,r)=>ok(r,await db.from('institutions').select('*'))));
app.get('/indicators',wrap(async(q,r)=>ok(r,await db.from('indicators').select('*').order('code'))));
app.get('/dataflows',wrap(async(q,r)=>ok(r,await db.from('dataflows').select('*').order('code'))));
app.get('/observations',wrap(async(q,r)=>{let s=db.from('observations').select('*').order('periode');
 if(q.query.indicator)s=s.eq('indicator',q.query.indicator);ok(r,await s.limit(2000));}));

// Écriture : administrateurs de données (leur institution) et admin
const own=(q,r,code)=>q.user.role==='admin'||q.user.institution===code;
app.post('/indicators',WRITER,wrap(async(q,r)=>{if(!own(q,r,q.body.institution))return r.status(403).json({error:'Autre institution'});
 ok(r,await db.from('indicators').upsert(q.body).select().single());}));
app.post('/dataflows',WRITER,wrap(async(q,r)=>{if(!own(q,r,q.body.institution))return r.status(403).json({error:'Autre institution'});
 ok(r,await db.from('dataflows').upsert({...q.body,statut:'soumis'},{onConflict:'code'}).select().single());}));
app.post('/dataflows/:id/valider',ADMIN,wrap(async(q,r)=>ok(r,await db.from('dataflows')
 .update({statut:q.body.refuser?'brouillon':'valide',valide_le:new Date()}).eq('id',q.params.id).select().single())));
// Transmission : lot d'observations, journalisé pour mesurer la régularité
app.post('/observations',WRITER,wrap(async(q,r)=>{const rows=(Array.isArray(q.body)?q.body:[q.body]);
 const inst=q.user.role==='admin'?(rows[0]&&rows[0].institution):q.user.institution;
 const clean=rows.map(x=>({indicator:x.indicator,periode:String(x.periode),valeur:+x.valeur,sexe:x.sexe||'_T',institution:inst}));
 const {error}=await db.from('observations').insert(clean);if(error)return r.status(400).json({error:error.message});
 await db.from('transmissions').insert({institution:inst,nb_lignes:clean.length});r.json({inserees:clean.length});}));

// Portail citoyen : dépôt public de besoins ; traitement par le Ministère
app.post('/requests',wrap(async(q,r)=>{if(!q.body.sujet)return r.status(400).json({error:'Sujet requis'});
 const {nom,email,organisation,sujet,message}=q.body;ok(r,await db.from('requests').insert({nom,email,organisation,sujet,message}).select('id').single());}));
app.get('/requests',ADMIN,wrap(async(q,r)=>ok(r,await db.from('requests').select('*').order('cree_le',{ascending:false}))));
app.patch('/requests/:id',ADMIN,wrap(async(q,r)=>ok(r,await db.from('requests').update({statut:q.body.statut}).eq('id',q.params.id).select().single())));

// Plan d'actions (réunions BIT, comités)
app.get('/actions',auth(),wrap(async(q,r)=>ok(r,await db.from('actions').select('*').order('echeance'))));
app.post('/actions',ADMIN,wrap(async(q,r)=>ok(r,await db.from('actions').insert(q.body).select().single())));
app.patch('/actions/:id',ADMIN,wrap(async(q,r)=>ok(r,await db.from('actions').update({statut:q.body.statut}).eq('id',q.params.id).select().single())));

// Indicateurs de suivi du plan de travail (section D)
app.get('/kpi',wrap(async(q,r)=>{
 const [i,d,t,o]=await Promise.all([db.from('indicators').select('documente,institution'),db.from('dataflows').select('statut'),
  db.from('transmissions').select('institution,cree_le').gte('cree_le',new Date(Date.now()-90*864e5).toISOString()),
  db.from('observations').select('*',{count:'exact',head:true})]);
 const ind=i.data||[],df=d.data||[],tr=t.data||[];
 const par={};['ANEFIP','CNSS','INSTAD','IGT'].forEach(c=>par[c]=tr.filter(x=>x.institution===c).length);
 r.json({taux_documentes:ind.length?Math.round(100*ind.filter(x=>x.documente).length/ind.length):0,
  nb_indicateurs:ind.length,dataflows_valides:df.filter(x=>x.statut==='valide').length,dataflows_total:df.length,
  transmissions_90j:par,observations:o.count||0,disponibilite:'OK'});}));

// ===== Export SDMX (Dataflows validés uniquement) =====
const X=s=>String(s??'').replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
const NS='xmlns:message="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/message" xmlns:common="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/common" xmlns:generic="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/data/generic" xmlns:structure="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/structure" xmlns:xml="http://www.w3.org/XML/1998/namespace"';
const hdr=(t)=>`<message:Header><message:ID>LMIS-DJ-${Date.now()}</message:ID><message:Test>false</message:Test><message:Prepared>${new Date().toISOString()}</message:Prepared><message:Sender id="DJ_MTFPS"/></message:Header>`;
const xml=(r,b)=>r.type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?>\n'+b);
async function flow(code){const {data:d}=await db.from('dataflows').select('*').eq('code',code).eq('statut','valide').maybeSingle();
 if(!d)return null;const {data:o}=await db.from('observations').select('*').eq('institution',d.institution).order('periode').limit(50000);return {d,o:o||[]}}
// Catalogue des Dataflows validés (SDMX-ML 2.1 Structure)
app.get('/sdmx/dataflow',wrap(async(q,r)=>{const {data}=await db.from('dataflows').select('*').eq('statut','valide');
 xml(r,`<message:Structure ${NS}>${hdr()}<message:Structures><structure:Dataflows>${(data||[]).map(d=>
 `<structure:Dataflow id="${X(d.code)}" agencyID="DJ_${X(d.institution)}" version="1.0"><common:Name xml:lang="fr">${X(d.libelle)}</common:Name></structure:Dataflow>`).join('')}</structure:Dataflows></message:Structures></message:Structure>`)}));
// Données au format SDMX-ML 2.1 Generic : /sdmx/data/CODE
app.get('/sdmx/data/:code',wrap(async(q,r)=>{const f=await flow(q.params.code);
 if(!f)return r.status(404).json({error:'Dataflow inconnu ou non validé'});
 const g={};f.o.forEach(x=>{const k=x.indicator+'|'+x.sexe;(g[k]??=[]).push(x)});
 const ser=Object.entries(g).map(([k,l])=>{const [ind,sx]=k.split('|');
  return `<generic:Series><generic:SeriesKey><generic:Value id="FREQ" value="A"/><generic:Value id="REF_AREA" value="DJ"/><generic:Value id="INDICATOR" value="${X(ind)}"/><generic:Value id="SEX" value="${X(sx)}"/></generic:SeriesKey>`+
  l.map(x=>`<generic:Obs><generic:ObsDimension value="${X(x.periode)}"/><generic:ObsValue value="${x.valeur}"/></generic:Obs>`).join('')+'</generic:Series>'}).join('');
 xml(r,`<message:GenericData ${NS}>${hdr()}<message:DataSet structureRef="${X(f.d.dsd||'DSD_LMIS_DJ')}"><generic:DataSetAction>Replace</generic:DataSetAction>${ser}</message:DataSet></message:GenericData>`)}));
// Données au format SDMX-CSV (importable dans .Stat) : /sdmx/csv/CODE
app.get('/sdmx/csv/:code',wrap(async(q,r)=>{const f=await flow(q.params.code);
 if(!f)return r.status(404).json({error:'Dataflow inconnu ou non validé'});
 const e=v=>'"'+String(v).replace(/"/g,'""')+'"';
 r.type('text/csv').attachment(q.params.code+'.csv').send(['DATAFLOW,FREQ,REF_AREA,INDICATOR,SEX,TIME_PERIOD,OBS_VALUE',
  ...f.o.map(x=>[e(`DJ_${f.d.institution}:${f.d.code}(1.0)`),'A','DJ',e(x.indicator),e(x.sexe),e(x.periode),x.valeur].join(','))].join('\n'))}));

// ===== DSD, concepts et listes de codes (SDMX-ML 2.1 Structure) =====
app.get('/sdmx/datastructure',wrap(async(q,r)=>{
 const {data:ind}=await db.from('indicators').select('*').order('code');
 const A='DJ_MTFPS',cl=(id,nom,items)=>`<structure:Codelist id="${id}" agencyID="${A}" version="1.0"><common:Name xml:lang="fr">${nom}</common:Name>${items.map(([c,n])=>`<structure:Code id="${X(c)}"><common:Name xml:lang="fr">${X(n)}</common:Name></structure:Code>`).join('')}</structure:Codelist>`;
 const cn=[['FREQ','Périodicité'],['REF_AREA','Zone géographique'],['INDICATOR','Indicateur'],['SEX','Sexe'],['TIME_PERIOD','Période'],['OBS_VALUE','Valeur observée']];
 const dim=(id,pos)=>`<structure:Dimension id="${id}" position="${pos}"><structure:ConceptIdentity><Ref id="${id}" maintainableParentID="CS_LMIS" agencyID="${A}" version="1.0" class="Concept"/></structure:ConceptIdentity><structure:LocalRepresentation><structure:Enumeration><Ref id="CL_${id}" agencyID="${A}" version="1.0" class="Codelist"/></structure:Enumeration></structure:LocalRepresentation></structure:Dimension>`;
 xml(r,`<message:Structure ${NS}>${hdr()}<message:Structures>
<structure:Concepts><structure:ConceptScheme id="CS_LMIS" agencyID="${A}" version="1.0"><common:Name xml:lang="fr">Concepts du SIMT</common:Name>${cn.map(([c,n])=>`<structure:Concept id="${c}"><common:Name xml:lang="fr">${n}</common:Name></structure:Concept>`).join('')}</structure:ConceptScheme></structure:Concepts>
<structure:Codelists>${cl('CL_FREQ','Périodicité',[['A','Annuelle'],['Q','Trimestrielle'],['M','Mensuelle']])}${cl('CL_REF_AREA','Zone',[['DJ','Djibouti']])}${cl('CL_SEX','Sexe',[['_T','Total'],['M','Hommes'],['F','Femmes']])}${cl('CL_INDICATOR','Indicateurs du marché du travail',(ind||[]).map(i=>[i.code,i.libelle+(i.unite?' ('+i.unite+')':'')]))}</structure:Codelists>
<structure:DataStructures><structure:DataStructure id="DSD_LMIS" agencyID="${A}" version="1.0"><common:Name xml:lang="fr">DSD du SIMT Djibouti</common:Name><structure:DataStructureComponents><structure:DimensionList id="DimensionDescriptor">${['FREQ','REF_AREA','INDICATOR','SEX'].map((d,i)=>dim(d,i+1)).join('')}<structure:TimeDimension id="TIME_PERIOD" position="5"><structure:ConceptIdentity><Ref id="TIME_PERIOD" maintainableParentID="CS_LMIS" agencyID="${A}" version="1.0" class="Concept"/></structure:ConceptIdentity></structure:TimeDimension></structure:DimensionList><structure:MeasureList id="MeasureDescriptor"><structure:PrimaryMeasure id="OBS_VALUE"><structure:ConceptIdentity><Ref id="OBS_VALUE" maintainableParentID="CS_LMIS" agencyID="${A}" version="1.0" class="Concept"/></structure:ConceptIdentity></structure:PrimaryMeasure></structure:MeasureList></structure:DataStructureComponents></structure:DataStructure></structure:DataStructures>
</message:Structures></message:Structure>`)}));

app.listen(process.env.PORT||3000,()=>console.log('LMIS API prête'));
```[cite: 8]

---

### 2. `frontend/index.html`
Replace your frontend file with this updated version (pointing to your live Render URL on line 12)[cite: 5]:

```javascript
<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SIMT Djibouti – Système d'Information sur le Marché du Travail</title>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"></script>
<style>body{background:#0f172a;color:#e2e8f0;font-family:system-ui,sans-serif}
.c{background:#1e293b;border:1px solid #334155;border-radius:.5rem;padding:1rem}
input,select,textarea{background:#0f172a;border:1px solid #475569;border-radius:.375rem;padding:.4rem .6rem;width:100%}
button.b{background:#0ea5e9;color:#fff;border-radius:.375rem;padding:.4rem .9rem}button.b:hover{background:#0284c7}
th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #334155}a:focus,button:focus,input:focus,select:focus{outline:2px solid #38bdf8}</style></head>
<body><header class="flex flex-wrap items-center justify-between gap-2 p-4 border-b border-slate-700">
<div><h1 class="text-xl font-bold">SIMT Djibouti</h1><p class="text-sm text-slate-400">Ministère du Travail · Projet conjoint OIT · .Stat / SDMX</p></div>
<div class="text-sm flex items-center gap-3"><span id="who"></span></div></header>
<nav id="nav" class="flex flex-wrap gap-2 p-3"></nav>
<main id="app" class="p-4 max-w-6xl mx-auto"></main>
<script>
const API='https://simt-djibouti-backend.onrender.com'; // adresse de votre API Render live
let S={tab:'dash',user:JSON.parse(localStorage.u||'null'),token:localStorage.t||''};
const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function api(p,m='GET',b){const r=await fetch(API+p,{method:m,headers:{'Content-Type':'application/json',Authorization:'Bearer '+S.token},body:b?JSON.stringify(b):undefined});
 const j=await r.json();if(!r.ok)throw new Error(j.error||'Erreur');return j}
const role=()=>S.user?.role,isAdmin=()=>role()==='admin',canW=()=>['admin','data_admin'].includes(role());
const TABS=()=>[['dash','Tableau de bord'],['ind','Indicateurs'],['obs','Données'],['df','Dataflows'],['req','Déposer un besoin'],
 ...(S.user?[['act','Plan d\'actions']]:[]),...(isAdmin()?[['adm','Administration']]:[]),['login',S.user?'Déconnexion':'Connexion']];
function nav(){$('#who').innerHTML=S.user?`${esc(S.user.nom||S.user.email)} · <b>${esc({admin:'Contrôleur principal',data_admin:'Administrateur de données',lecteur:'Lecteur'}[role()])}</b>`:'Visiteur';
 $('#nav').innerHTML=TABS().map(([k,l])=>`<button class="px-3 py-1 rounded ${S.tab===k?'bg-sky-600':'bg-slate-700'}" onclick="go('${k}')">${l}</button>`).join('')}
function go(t){if(t==='login'&&S.user){localStorage.clear();S.user=null;S.token='';t='dash'}S.tab=t;nav();V[t]().catch(e=>$('#app').innerHTML=`<p class="c text-red-300">${esc(e.message)} (l'API Render peut mettre 30 s à se réveiller)</p>`)}
const tbl=(h,rows)=>`<div class="c overflow-x-auto"><table class="w-full text-sm"><tr>${h.map(x=>`<th>${x}</th>`).join('')}</tr>${rows.map(r=>`<tr>${r.map(x=>`<td>${x}</td>`).join('')}</tr>`).join('')||'<tr><td>Aucune donnée pour le moment.</td></tr>'}</table></div>`;
const f=(id,l,t='text')=>`<label class="block text-sm mb-2">${l}<input id="${id}" type="${t}"></label>`;
const v=id=>$('#'+id).value;
const send=async(fn,msg)=>{try{await fn();alert(msg);go(S.tab)}catch(e){alert(e.message)}};

let ch;
const V={
async dash(){const k=await api('/kpi'),o=await api('/observations');
 const card=(a,b)=>`<div class="c"><div class="text-3xl font-bold">${a}</div><div class="text-sm text-slate-400">${b}</div></div>`;
 $('#app').innerHTML=`<div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">${card(k.taux_documentes+' %','Indicateurs documentés ('+k.nb_indicateurs+')')}
 ${card(k.dataflows_valides+' / '+k.dataflows_total,'Dataflows validés')}${card(k.observations,'Observations')}${card(k.disponibilite,'Disponibilité de la plateforme')}</div>
 <div class="grid md:grid-cols-2 gap-3"><div class="c"><h2 class="font-semibold mb-2">Transmissions par institution (90 jours)</h2><canvas id="c1"></canvas></div>
 <div class="c"><h2 class="font-semibold mb-2">Évolution des observations</h2><canvas id="c2"></canvas></div></div>`;
 new Chart($('#c1'),{type:'bar',data:{labels:Object.keys(k.transmissions_90j),datasets:[{label:'Transmissions',data:Object.values(k.transmissions_90j),backgroundColor:'#0ea5e9'}]}});
 const g={};o.forEach(x=>(g[x.indicator]??={})[x.periode]=x.valeur);const ps=[...new Set(o.map(x=>x.periode))].sort();
 new Chart($('#c2'),{type:'line',data:{labels:ps,datasets:Object.entries(g).map(([n,m])=>({label:n,data:ps.map(p=>m[p]??null),spanGaps:true}))}})},
async ind(){const d=await api('/indicators');
 $('#app').innerHTML=tbl(['Code','Libellé','Institution','Unité','Classification','Métadonnées'],d.map(x=>[x.code,esc(x.libelle),x.institution,esc(x.unite),esc(x.classification),x.documente?'✔ documenté':'à documenter']))+
 (canW()?`<div class="c mt-4"><h2 class="font-semibold mb-2">Ajouter / documenter un indicateur</h2><div class="grid md:grid-cols-3 gap-2">${f('i1','Code (ex. EMP_TOT)')}${f('i2','Libellé')}${f('i3','Unité')}${f('i4','Définition (métadonnées de référence)')}</div>
 <label class="text-sm"><input type="checkbox" id="i5" style="width:auto"> Métadonnées complètes</label><br><button class="b mt-2" onclick="saveInd()">Enregistrer</button></div>`:'')},
async obs(){const d=await api('/observations');
 $('#app').innerHTML=tbl(['Indicateur','Institution','Période','Sexe','Valeur'],d.slice(-200).reverse().map(x=>[x.indicator,x.institution,x.periode,x.sexe,x.valeur]))+
 (canW()?`<div class="c mt-4"><h2 class="font-semibold mb-2">Transmettre des données</h2><p class="text-xs text-slate-400 mb-2">Une ligne par observation : INDICATEUR,PERIODE,VALEUR[,SEXE]</p>
 <textarea id="o1" rows="5" placeholder="EMP_TOT,2025,152300&#10;UNEMP_TOT,2025,48.4"></textarea><button class="b mt-2" onclick="sendObs()">Transmettre</button></div>`:'<p class="text-sm text-slate-400 mt-3">Connectez-vous en tant qu\'administrateur de données pour transmettre.</p>')},
async df(){const d=await api('/dataflows');
 $('#app').innerHTML=tbl(['Code','Libellé','Institution','DSD','Statut','Export / action'],d.map(x=>[x.code,esc(x.libelle),x.institution,esc(x.dsd),x.statut,
 x.statut==='valide'?`<a class="text-sky-400 underline mr-2" href="${API}/sdmx/data/${x.code}" target="_blank">SDMX-ML</a><a class="text-sky-400 underline" href="${API}/sdmx/csv/${x.code}">SDMX-CSV</a>`:isAdmin()?`<button class="b" onclick="valDf(${x.id})">Valider</button>`:'']))+`<p class="text-xs text-slate-400 mt-2">Catalogue SDMX : <a class="text-sky-400 underline" href="${API}/sdmx/datastructure" target="_blank">DSD et listes de codes</a> · <a class="text-sky-400 underline" href="${API}/sdmx/dataflow" target="_blank">${API}/sdmx/dataflow</a> · seuls les Dataflows validés sont diffusés.</p>`+
 (canW()?`<div class="c mt-4"><h2 class="font-semibold mb-2">Soumettre un Dataflow</h2><div class="grid md:grid-cols-4 gap-2">${f('d1','Code')}${f('d2','Libellé')}${f('d3','DSD')}${f('d4','Institution (code)')}</div><button class="b mt-2" onclick="saveDf()">Soumettre pour validation</button></div>`:'')},
async req(){$('#app').innerHTML=`<div class="c max-w-xl"><h2 class="font-semibold mb-1">Exprimer un besoin d'information</h2><p class="text-sm text-slate-400 mb-3">Citoyens, entreprises, ministères, partenaires : la Direction du Travail reçoit et traite chaque demande.</p>
 ${f('r1','Nom')}${f('r2','E-mail','email')}${f('r3','Organisation')}${f('r4','Sujet')}<label class="block text-sm mb-2">Message<textarea id="r5" rows="4"></textarea></label><button class="b" onclick="sendReq()">Envoyer ma demande</button></div>`},
async act(){const d=await api('/actions');
 $('#app').innerHTML=tbl(['Action','Responsable','Échéance','Statut'],d.map(x=>[esc(x.titre),esc(x.responsable),x.echeance||'',isAdmin()?`<select onchange="api('/actions/${x.id}','PATCH',{statut:this.value})">${['a_faire','en_cours','fait'].map(s=>`<option ${s===x.statut?'selected':''}>${s}</option>`)}</select>`:x.statut]))+
 (isAdmin()?`<div class="c mt-4"><div class="grid md:grid-cols-3 gap-2">${f('a1','Action')}${f('a2','Responsable')}${f('a3','Échéance','date')}</div><button class="b mt-2" onclick="send(()=>api('/actions','POST',{titre:v('a1'),responsable:v('a2'),echeance:v('a3')||null}),'Action ajoutée')">Ajouter</button></div>`:'')},
async adm(){const [u,r]=await Promise.all([api('/users'),api('/requests')]);
 $('#app').innerHTML=`<h2 class="font-semibold mb-2">Demandes reçues</h2>`+tbl(['Date','De','Sujet','Message','Statut'],r.map(x=>[x.cree_le.slice(0,10),esc(x.nom||x.email),esc(x.sujet),esc(x.message),
 `<select onchange="api('/requests/${x.id}','PATCH',{statut:this.value})">${['nouvelle','en_cours','traitee'].map(s=>`<option ${s===x.statut?'selected':''}>${s}</option>`)}</select>`]))+
 `<h2 class="font-semibold mt-6 mb-2">Comptes</h2>`+tbl(['E-mail','Rôle','Institution'],u.map(x=>[esc(x.email),x.role,x.institution||'']))+
 `<div class="c mt-4"><h3 class="font-semibold mb-2">Créer un compte</h3><div class="grid md:grid-cols-5 gap-2">${f('u1','E-mail','email')}${f('u2','Nom')}${f('u3','Mot de passe','password')}
 <label class="text-sm">Rôle<select id="u4"><option value="data_admin">Administrateur de données</option><option value="lecteur">Lecteur (ministre)</option><option value="admin">Admin</option></select></label>${f('u5','Institution (ANEFIP, CNSS, INSTAD, IGT, DT)')}</div>
 <button class="b mt-2" onclick="send(()=>api('/users','POST',{email:v('u1'),nom:v('u2'),password:v('u3'),role:v('u4'),institution:v('u5')||null}),'Compte créé')">Créer</button></div>`},
async login(){$('#app').innerHTML=`<div class="c max-w-sm">${f('l1','E-mail','email')}${f('l2','Mot de passe','password')}<button class="b" onclick="login()">Se connecter</button></div>`}};
async function login(){try{const j=await api('/auth/login','POST',{email:v('l1'),password:v('l2')});S.token=j.token;S.user=j.user;localStorage.t=j.token;localStorage.u=JSON.stringify(j.user);go('dash')}catch(e){alert(e.message)}}
const saveInd=()=>send(()=>api('/indicators','POST',{code:v('i1'),libelle:v('i2'),unite:v('i3'),definition:v('i4'),documente:$('#i5').checked,institution:S.user.institution||'DT'}),'Indicateur enregistré');
const saveDf=()=>send(()=>api('/dataflows','POST',{code:v('d1'),libelle:v('d2'),dsd:v('d3'),institution:v('d4')||S.user.institution}),'Dataflow soumis');
const valDf=id=>send(()=>api('/dataflows/'+id+'/valider','POST',{}),'Dataflow validé');
const sendObs=()=>send(()=>api('/observations','POST',v('o1').split('\n').filter(Boolean).map(l=>{const [indicator,periode,valeur,sexe]=l.split(',').map(s=>s.trim());return {indicator,periode,valeur,sexe,institution:S.user.institution}})),'Données transmises');
const sendReq=()=>send(()=>api('/requests','POST',{nom:v('r1'),email:v('r2'),organisation:v('r3'),sujet:v('r4'),message:v('r5')}),'Demande envoyée, merci');
go('dash');
</script></body></html>
```[cite: 5]

---

### How to Commit and Push Your Changes
Open your terminal in VS Code and run the following commands:

```powershell
git add .
git commit -m "Restore original full server architecture and update frontend backend URL"
git push origin main