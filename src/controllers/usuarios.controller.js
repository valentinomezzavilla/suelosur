'use strict'
const UsuariosModel  = require('../models/usuarios.model')
const EmpleadosModel = require('../models/empleados.model')
const { query }      = require('../config/db')
const paginar        = require('../utils/paginar')

// Crea un empleado-chofer asociado a un usuario si todavía no existe.
async function crearEmpleadoChoferSiNoExiste(idUsuario, datosUsuario) {
  if (!idUsuario) return
  const existe = (await query(`SELECT id FROM empleados WHERE id_usuario = ?`, [idUsuario])).rows[0]
  if (existe) return existe.id
  // Separar nombre / apellido si vino en formato "Nombre Apellido"
  const partes = (datosUsuario.nombre || '').trim().split(/\s+/)
  const nombre = partes[0] || datosUsuario.usuario || 'Chofer'
  const apellido = partes.slice(1).join(' ') || ''
  return EmpleadosModel.crear({
    nombre, apellido,
    es_chofer: 'true',
    cargo: 'Chofer',
    sector: 'Operaciones',
    id_usuario: idUsuario,
    estado_laboral: 'activo',
  })
}

const UsuariosController = {
  async index(req, res) {
    try {
      const { q, sort, dir, rol, estado, page } = req.query
      let todos = await UsuariosModel.listar()
      if (q && q.trim()) {
        const term = q.trim().toLowerCase()
        todos = todos.filter(u =>
          (u.nombre || '').toLowerCase().includes(term) ||
          (u.usuario || '').toLowerCase().includes(term)
        )
      }
      if (rol)               todos = todos.filter(u => u.rol === rol)
      if (estado === 'activo')   todos = todos.filter(u => !!u.activo)
      if (estado === 'inactivo') todos = todos.filter(u => !u.activo)

      const sortMap = {
        usuario: (u) => (u.usuario || '').toLowerCase(),
        nombre:  (u) => (u.nombre || '').toLowerCase(),
        rol:     (u) => (u.rol || ''),
      }
      const sortKey = sortMap[sort] ? sort : 'nombre'
      const dirNorm = String(dir || '').toUpperCase() === 'DESC' ? 'DESC' : 'ASC'
      const getter = sortMap[sortKey]
      todos = [...todos].sort((a, b) => {
        const va = getter(a), vb = getter(b)
        if (va < vb) return dirNorm === 'ASC' ? -1 : 1
        if (va > vb) return dirNorm === 'ASC' ?  1 : -1
        return 0
      })

      const { items: usuarios, total, page: pag, limit, totalPaginas } = paginar(todos, page, 20)
      res.render('pages/usuarios/index', {
        titulo: 'Usuarios', usuarios, total, page: pag, limit, totalPaginas,
        filtros: { q: q||'', rol: rol||'', estado: estado||'', sort: sortKey, dir: dirNorm },
        scripts: ['/js/usuarios.js'],
      })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('back')
    }
  },
  async nuevo(req, res) {
    res.render('pages/usuarios/form', { titulo: 'Nuevo Usuario', usuario: null })
  },
  async crear(req, res) {
    try {
      const { usuario, nombre, rol, password, password_confirm } = req.body
      if (!usuario || !nombre || !rol || !password) { req.flash('error', 'Todos los campos son obligatorios.'); return res.redirect('/usuarios/nuevo') }
      if (password !== password_confirm) { req.flash('error', 'Las contraseñas no coinciden.'); return res.redirect('/usuarios/nuevo') }
      if (await UsuariosModel.existeUsuario(usuario)) { req.flash('error', `El usuario "${usuario}" ya existe.`); return res.redirect('/usuarios/nuevo') }
      const idUsuario = await UsuariosModel.crear({ usuario, nombre, rol, password })
      if (rol === 'chofer') {
        try {
          await crearEmpleadoChoferSiNoExiste(idUsuario, { usuario, nombre })
          req.flash('success', `Usuario ${nombre} creado y registrado como chofer.`)
        } catch (e) {
          console.error('No se pudo crear el empleado-chofer:', e)
          req.flash('success', `Usuario ${nombre} creado (registro de chofer falló — completalo manualmente).`)
        }
      } else {
        req.flash('success', `Usuario ${nombre} creado.`)
      }
      res.redirect('/usuarios')
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/usuarios/nuevo')
    }
  },
  async editar(req, res) {
    try {
      const usuario = await UsuariosModel.obtener(req.params.id)
      if (!usuario) { req.flash('error', 'No encontrado.'); return res.redirect('/usuarios') }
      res.render('pages/usuarios/form', { titulo: 'Editar Usuario', usuario })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/usuarios')
    }
  },
  async actualizar(req, res) {
    try {
      const { usuario, nombre, rol, password, password_confirm } = req.body
      const id = req.params.id
      if (!usuario || !nombre || !rol) { req.flash('error', 'Usuario, nombre y rol son obligatorios.'); return res.redirect(`/usuarios/${id}/editar`) }
      if (password && password !== password_confirm) { req.flash('error', 'Las contraseñas no coinciden.'); return res.redirect(`/usuarios/${id}/editar`) }
      if (await UsuariosModel.existeUsuario(usuario, id)) { req.flash('error', `El usuario "${usuario}" ya está en uso.`); return res.redirect(`/usuarios/${id}/editar`) }
      await UsuariosModel.actualizar(id, { usuario, nombre, rol, password: password || null })
      // Si pasó a ser chofer, crear empleado-chofer si no existe
      if (rol === 'chofer') {
        try { await crearEmpleadoChoferSiNoExiste(id, { usuario, nombre }) } catch (e) { console.error('crear chofer auto:', e) }
      }
      req.flash('success', 'Usuario actualizado.')
      res.redirect('/usuarios')
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/usuarios')
    }
  },
  async toggleActivo(req, res) {
    try {
      if (req.params.id === req.session.user.id) { req.flash('error', 'No podés desactivar tu propia cuenta.'); return res.redirect('/usuarios') }
      await UsuariosModel.toggleActivo(req.params.id)
      req.flash('success', 'Estado del usuario actualizado.')
    } catch (err) {
      console.error(err); req.flash('error', 'Error.')
    }
    res.redirect('/usuarios')
  },
}

module.exports = UsuariosController
