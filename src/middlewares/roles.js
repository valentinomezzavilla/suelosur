// Destino de redirección amistosa por rol cuando intenta entrar
// a una sección sin permiso (en vez de mostrar un 403 plano).
const HOME_POR_ROL = {
  chofer:         '/hoja-de-ruta',
  admin_ventas:   '/ventas',
  admin_contable: '/cobranzas',
  dueno:          '/dashboard',
}

module.exports = (...rolesPermitidos) => {
  return (req, res, next) => {
    const rol = req.session.user?.rol
    if (!rolesPermitidos.includes(rol)) {
      // Si el usuario tiene su propio "home", redirigir ahí con un mensaje claro
      // (mejor UX que un 403 que rompe el "back" del browser).
      const home = HOME_POR_ROL[rol]
      if (home && req.method === 'GET') {
        req.flash('warning', 'No tenés permiso para acceder a esa sección.')
        return res.redirect(home)
      }
      return res.status(403).render('pages/error', {
        layout: 'layouts/main',
        titulo: 'Sin permiso',
        mensaje: 'No tenés permiso para acceder a esta sección.'
      })
    }
    next()
  }
}
