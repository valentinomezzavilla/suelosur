module.exports = (...rolesPermitidos) => {
  return (req, res, next) => {
    const rol = req.session.user?.rol
    if (!rolesPermitidos.includes(rol)) {
      return res.status(403).render('pages/error', {
        layout: 'layouts/main',
        mensaje: 'No tenés permiso para acceder a esta sección.'
      })
    }
    next()
  }
}
