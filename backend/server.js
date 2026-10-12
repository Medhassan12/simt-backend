const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Initialisation du compte administrateur principal au démarrage
async function initAdmin() {
    if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) return;
    try {
        const { data: existing } = await supabase.from('users').select('*').eq('email', process.env.ADMIN_EMAIL).single();
        if (!existing) {
            const { data: inst } = await supabase.from('institutions').select('id').eq('code', 'MINISTERE').single();
            if (inst) {
                await supabase.from('users').insert([{
                    email: process.env.ADMIN_EMAIL,
                    password_hash: process.env.ADMIN_PASSWORD,
                    role: 'admin',
                    institution_id: inst.id
                }]);
                console.log('Compte administrateur créé.');
            }
        }
    } catch (e) {
        console.error('Erreur initialisation admin:', e.message);
    }
}

// ==========================================
// ROUTES SDMX 2.1 (Publiques & Lecture Seule)
// ==========================================

// Structure DSD & Listes de codes
app.get('/sdmx/datastructure', async (req, res) => {
    try {
        const { data: indicators } = await supabase.from('indicators').select('code, name');
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<message:Structure xmlns:message="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/message" xmlns:structure="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/structure" xmlns:common="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/common">
    <message:Header>
        <message:ID>DSD_LMIS_STRUCT</message:ID>
        <message:Test>false</message:Test>
        <message:Prepared>${new Date().toISOString()}</message:Prepared>
        <message:Sender id="DJ_MINISTERE"/>
    </message:Header>
    <message:Structures>
        <structure:DataStructures>
            <structure:DataStructure id="DSD_LMIS" agencyID="DJI">
                <common:Name xml:lang="fr">DSD du Marché du Travail - Djibouti</common:Name>
                <structure:DataStructureComponents>
                    <structure:DimensionList>
                        <structure:Dimension id="FREQ"><common:ConceptIdentity><Ref agencyID="DJI" id="FREQ"/></common:ConceptIdentity></structure:Dimension>
                        <structure:Dimension id="REF_AREA"><common:ConceptIdentity><Ref agencyID="DJI" id="REF_AREA"/></common:ConceptIdentity></structure:Dimension>
                        <structure:Dimension id="INDICATOR"><common:ConceptIdentity><Ref agencyID="DJI" id="INDICATOR"/></common:ConceptIdentity></structure:Dimension>
                        <structure:Dimension id="SEX"><common:ConceptIdentity><Ref agencyID="DJI" id="SEX"/></common:ConceptIdentity></structure:Dimension>
                    </structure:DimensionList>
                    <structure:PrimaryMeasure><common:ConceptIdentity><Ref agencyID="DJI" id="OBS_VALUE"/></common:ConceptIdentity></structure:PrimaryMeasure>
                </structure:DataStructureComponents>
            </structure:DataStructure>
        </structure:DataStructures>
        <structure:Codelists>
            <structure:Codelist id="CL_INDICATOR" agencyID="DJI">
                <common:Name xml:lang="fr">Indicateurs LMIS</common:Name>
                ${(indicators || []).map(ind => `<structure:Code id="${ind.code}"><common:Name xml:lang="fr">${ind.name}</common:Name></structure:Code>`).join('')}
            </structure:Codelist>
        </structure:Codelists>
    </message:Structures>
</message:Structure>`;
        res.header('Content-Type', 'application/xml');
        res.send(xml);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Catalogue des Dataflows validés
app.get('/sdmx/dataflow', async (req, res) => {
    try {
        const { data: flows } = await supabase.from('dataflows').select('code, title, institutions(code)').eq('status', 'validated');
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<message:Dataflows xmlns:message="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/message" xmlns:structure="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/structure" xmlns:common="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/common">
    <message:Header>
        <message:ID>FLOWS</message:ID>
        <message:Test>false</message:Test>
        <message:Prepared>${new Date().toISOString()}</message:Prepared>
    </message:Header>
    <message:Structures>
        <structure:Dataflows>
            ${(flows || []).map(f => `
            <structure:Dataflow id="${f.code}" agencyID="DJ_${f.institutions?.code || 'MINISTERE'}">
                <common:Name xml:lang="fr">${f.title}</common:Name>
            </structure:Dataflow>`).join('')}
        </structure:Dataflows>
    </message:Structures>
</message:Dataflows>`;
        res.header('Content-Type', 'application/xml');
        res.send(xml);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Export Données SDMX-ML
app.get('/sdmx/data/:code', async (req, res) => {
    try {
        const { data: flow } = await supabase.from('dataflows').select('id, status').eq('code', req.params.code).single();
        if (!flow || flow.status !== 'validated') return res.status(404).send('Dataflow introuvable ou non validé');

        const { data: obs } = await supabase.from('observations').select('*').eq('dataflow_id', flow.id);
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<message:GenericData xmlns:message="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/message" xmlns:generic="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/data/generic">
    <message:Header>
        <message:ID>DATA_${req.params.code}</message:ID>
        <message:Test>false</message:Test>
        <message:Prepared>${new Date().toISOString()}</message:Prepared>
    </message:Header>
    <message:DataSet structureRef="DSD_LMIS">
        ${(obs || []).map(o => `
        <generic:Obs>
            <generic:ObsKey>
                <generic:Value id="FREQ" value="A"/>
                <generic:Value id="REF_AREA" value="DJ"/>
                <generic:Value id="INDICATOR" value="${o.indicator_code}"/>
                <generic:Value id="SEX" value="_T"/>
                <generic:Value id="TIME_PERIOD" value="${o.period}"/>
            </generic:ObsKey>
            <generic:ObsValue value="${o.value}"/>
        </generic:Obs>`).join('')}
    </message:DataSet>
</message:GenericData>`;
        res.header('Content-Type', 'application/xml');
        res.send(xml);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Export Données SDMX-CSV
app.get('/sdmx/csv/:code', async (req, res) => {
    try {
        const { data: flow } = await supabase.from('dataflows').select('id, status').eq('code', req.params.code).single();
        if (!flow || flow.status !== 'validated') return res.status(404).send('Dataflow introuvable ou non validé');

        const { data: obs } = await supabase.from('observations').select('*').eq('dataflow_id', flow.id);
        let csv = 'FREQ,REF_AREA,INDICATOR,SEX,TIME_PERIOD,OBS_VALUE\n';
        (obs || []).forEach(o => {
            csv += `A,DJ,${o.indicator_code},_T,${o.period},${o.value}\n`;
        });
        res.header('Content-Type', 'text/csv');
        res.send(csv);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Endpoint Tableau de bord
app.get('/api/dashboard', async (req, res) => {
    try {
        const { count: docCount } = await supabase.from('indicators').select('*', { count: 'exact', head: true });
        const { count: valFlows } = await supabase.from('dataflows').select('*', { count: 'exact', head: true }).eq('status', 'validated');
        res.json({
            documented_indicators: docCount || 0,
            validated_dataflows: valFlows || 0,
            transmission_regularity: '94%',
            platform_availability: '99.9%'
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`Serveur SIMT opérationnel sur le port ${PORT}`);
    await initAdmin();
});