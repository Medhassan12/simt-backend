require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

// Resolve Environment Variables with fallbacks
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
const jwtSecret = process.env.JWT_SECRET || process.env['JWT-SECRET'];

// Diagnostic log to verify variables at startup
if (!supabaseUrl || !supabaseKey) {
  console.error('CRITICAL ERROR: Missing SUPABASE_URL or SUPABASE_KEY!');
} else {
  console.log('Supabase initialized successfully.');
}

const db = createClient(supabaseUrl, supabaseKey);

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.FRONT_ORIGIN || '*' }));

// Helper functions & Middlewares
const wrap = f => (q, r) => f(q, r).catch(e => r.status(500).json({ error: e.message }));

const auth = (roles = []) => (q, r, n) => {
  try {
    const t = (q.headers.authorization || '').split(' ')[1];
    q.user = jwt.verify(t, jwtSecret);
    if (roles.length && !roles.includes(q.user.role)) return r.status(403).json({ error: 'Accès refusé' });
    n();
  } catch {
    r.status(401).json({ error: 'Connexion requise' });
  }
};

const ADMIN = auth(['admin']);
const WRITER = auth(['admin', 'data_admin']);

// 1. Login Route
app.post('/login', wrap(async (req, res) => {
  const { email, password } = req.body;

  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (email === adminEmail && password === adminPassword) {
    const token = jwt.sign(
      { email, role: 'admin' },
      jwtSecret,
      { expiresIn: '24h' }
    );
    return res.json({ token, role: 'admin' });
  }

  res.status(401).json({ error: 'Email ou mot de passe incorrect' });
}));

// 2. Health Check Route
app.get('/', (req, res) => res.send('API is running successfully!'));

// Start Server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});