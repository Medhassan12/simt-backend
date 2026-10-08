const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());

// Enable CORS for all origins and DELETE method
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Supabase Connection
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fleglctqwzvcnvpdoxfy.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY; 
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const JWT_SECRET = process.env.JWT_SECRET || 'simt_djibouti_secret_key';

// Middleware Authentication
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

// Health Check
app.get('/', (req, res) => res.send('SIMT Djibouti Backend API Online'));

// 1. LOGIN ROUTE
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (error || !user) {
      return res.status(401).json({ message: 'Identifiants invalides' });
    }

    const validPassword = await bcrypt.compare(password, user.hash);
    if (!validPassword) {
      return res.status(401).json({ message: 'Identifiants invalides' });
    }

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, user: { email: user.email, role: user.role, institution: user.institution } });
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// 2. GET ALL USERS
app.get('/api/users', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await supabase.from('users').select('id, email, nom, role, institution');
    if (error) return res.status(400).json({ message: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// 3. CREATE USER ROUTE
app.post('/api/users', authenticateToken, async (req, res) => {
  const { email, nom, password, role, institution } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    const { data, error } = await supabase
      .from('users')
      .insert([{ email, nom, role, institution, hash }]);

    if (error) return res.status(400).json({ message: error.message });
    res.status(201).json({ message: 'Compte créé avec succès' });
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de la création.' });
  }
});

// 4. DELETE USER ROUTE
app.delete('/api/users/:email', authenticateToken, async (req, res) => {
  try {
    const { email } = req.params;

    if (email === 'admin@travail.gov.dj') {
      return res.status(403).json({ message: 'Le compte administrateur principal ne peut pas être supprimé.' });
    }

    const { error } = await supabase
      .from('users')
      .delete()
      .eq('email', email);

    if (error) return res.status(400).json({ message: error.message });

    res.json({ message: `Utilisateur ${email} supprimé avec succès.` });
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur lors de la suppression.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));