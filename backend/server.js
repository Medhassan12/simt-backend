const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Route de test
app.get('/', (req, res) => {
  res.json({ message: 'Bienvenue sur l API SIMT Djibouti' });
});

// Route pour récupérer les institutions
app.get('/api/institutions', async (req, res) => {
  const { data, error } = await supabase.from('institutions').select('*');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Route pour récupérer les indicateurs
app.get('/api/indicators', async (req, res) => {
  const { data, error } = await supabase.from('indicators').select('*');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur SIMT démarré sur le port ${PORT}`);
});