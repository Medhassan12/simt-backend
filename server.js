// DELETE user route
app.delete('/api/users/:email', authenticateToken, async (req, res) => {
  try {
    const { email } = req.params;

    // Protection for root administrator account
    if (email === 'admin@travail.gov.dj') {
      return res.status(403).json({ message: 'Le compte administrateur principal ne peut pas être supprimé.' });
    }

    const { error } = await supabase
      .from('users')
      .delete()
      .eq('email', email);

    if (error) {
      return res.status(400).json({ message: error.message });
    }

    res.json({ message: `Utilisateur ${email} supprimé avec succès.` });
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur lors de la suppression.' });
  }
});