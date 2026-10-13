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