module.exports = (req, res, next) => {
  if (!req.session.user) {
    // Guardar el destino (solo GET de navegación) para volver tras el login.
    // Útil para deep-links, p.ej. el link "Iniciar viaje" que le llega al chofer por WhatsApp.
    if (req.method === 'GET' && !req.xhr) req.session.returnTo = req.originalUrl
    return res.redirect('/auth/login')
  }
  res.locals.user = req.session.user
  next()
}
