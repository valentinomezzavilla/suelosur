'use strict'
const ClientesModel = require('../models/clientes.model')
const TransaccionesModel = require('../models/transacciones.model')
const paginar       = require('../utils/paginar')

const ClientesController = {

  index(req, res) {
    try {
      const { nombre, dni, id, page } = req.query
      const todos = (nombre || dni || id) ? ClientesModel.buscar({ id, nombre, dni }) : ClientesModel.listar()
      const { items: clientes, total, page: pag, limit, totalPaginas } = paginar(todos, page, 15)
      res.render('pages/clientes/index', {
        titulo: 'Clientes', clientes, total, page: pag, limit, totalPaginas,
        filtros: { id: id||'', nombre: nombre||'', dni: dni||'' },
      })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('back')
    }
  },

  nuevo(req, res) {
    res.render('pages/clientes/form', { titulo: 'Nuevo Cliente', cliente: null })
  },

  crear(req, res) {
    try {
      const { nombre, apellido, domicilio_ppal, zona, tel_whatsapp, telefono, email, dni, tipo_cliente, cuentaCorriente } = req.body
      if (!nombre) { req.flash('error', 'El nombre es obligatorio.'); return res.redirect('/clientes/nuevo') }
      ClientesModel.crear({ nombre, apellido, domicilio_ppal, zona, tel_whatsapp, telefono, email, dni, tipo_cliente, cuenta_corriente: cuentaCorriente })
      req.flash('success', 'Cliente creado.')
      res.redirect('/clientes')
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/clientes/nuevo')
    }
  },

  detalle(req, res) {
    try {
      const cli = ClientesModel.obtener(req.params.id)
      if (!cli) { req.flash('error', 'No encontrado.'); return res.redirect('/clientes') }
      const cliente = { ...cli, cuentaCorriente: !!cli.cuenta_corriente, telefono: cli.telefono || cli.tel_whatsapp, direccion: cli.domicilio_ppal, saldo: cli.saldo ?? 0 }
      const movimientos   = ClientesModel.movimientos(cliente.id)
      const transacciones = TransaccionesModel.filtrar({ clienteId: cliente.id, limit: 1000 }).rows
      const alquileres    = []
      const deudasCC      = transacciones
        .filter(t => t.metodo_pago === 'cuenta_corriente')
        .map(t => ({ ...t, saldada: false }))
      res.render('pages/clientes/detalle', { titulo: `${cliente.nombre} ${cliente.apellido || ''}`.trim(), cliente, movimientos, transacciones, alquileres, deudasCC, filtros: req.query, scripts: ['/js/modalAbonar.js'] })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/clientes')
    }
  },

  editar(req, res) {
    try {
      const cliente = ClientesModel.obtener(req.params.id)
      if (!cliente) { req.flash('error', 'No encontrado.'); return res.redirect('/clientes') }
      res.render('pages/clientes/form', { titulo: 'Editar Cliente', cliente })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/clientes')
    }
  },

  actualizar(req, res) {
    try {
      const { nombre, apellido, domicilio_ppal, zona, tel_whatsapp, telefono, email, dni, tipo_cliente, cuentaCorriente } = req.body
      if (!nombre) { req.flash('error', 'El nombre es obligatorio.'); return res.redirect(`/clientes/${req.params.id}/editar`) }
      ClientesModel.actualizar(req.params.id, { nombre, apellido, domicilio_ppal, zona, tel_whatsapp, telefono, email, dni, tipo_cliente, cuenta_corriente: cuentaCorriente })
      req.flash('success', 'Cliente actualizado.')
      res.redirect('/clientes')
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/clientes')
    }
  },

  toggleActivo(req, res) {
    try {
      ClientesModel.toggleActivo(req.params.id)
      req.flash('success', 'Estado actualizado.')
    } catch (err) {
      console.error(err); req.flash('error', 'Error.')
    }
    res.redirect('/clientes')
  },

  habilitarCuenta(req, res) {
    try {
      ClientesModel.habilitarCuenta(req.params.id)
      req.flash('success', 'Cuenta corriente habilitada.')
    } catch (err) {
      console.error(err); req.flash('error', 'Error.')
    }
    res.redirect('/clientes')
  },

  abonar(req, res) {
    try {
      const monto = Number(req.body.monto)
      if (!monto || monto <= 0) { req.flash('error', 'Monto inválido.'); return res.redirect('/clientes') }
      ClientesModel.agregarMovimiento(req.params.id, { tipo: 'pago', descripcion: 'Pago / abono de deuda', monto })
      req.flash('success', `Abono de $${monto.toLocaleString('es-AR')} registrado.`)
    } catch (err) {
      console.error(err); req.flash('error', 'Error.')
    }
    res.redirect(`/clientes/${req.params.id}`)
  },

  // API JSON para buscar clientes desde el front (buscarCliente.js)
  buscarApi(req, res) {
    try {
      const { id, dni, nombre } = req.query
      if (!id && !dni && !nombre) return res.json([])
      const resultados = ClientesModel.buscar({ id, dni, nombre })
      res.json(resultados.map(c => ({
        id: c.id, numero: c.numero, nombre: c.nombre, apellido: c.apellido || '',
        nombreCompleto: ClientesModel.nombreCompleto(c),
        dni: c.dni, telefono: c.telefono || c.tel_whatsapp,
        email: c.email, cuentaCorriente: !!c.cuenta_corriente,
      })))
    } catch (err) {
      console.error(err); res.status(500).json({ error: 'Error.' })
    }
  },

  crearApi(req, res) {
    try {
      const { nombre, apellido, dni, telefono, email } = req.body
      if (!nombre || !apellido || !telefono) return res.status(400).json({ error: 'Nombre, apellido y teléfono son obligatorios.' })
      const id    = ClientesModel.crear({ nombre, apellido, dni, telefono, email })
      const nuevo = ClientesModel.obtener(id)
      res.json({
        id: nuevo.id, numero: nuevo.numero, nombre: nuevo.nombre, apellido: nuevo.apellido || '',
        nombreCompleto: ClientesModel.nombreCompleto(nuevo),
        dni: nuevo.dni, telefono: nuevo.telefono, email: nuevo.email,
        cuentaCorriente: !!nuevo.cuenta_corriente,
      })
    } catch (err) {
      console.error(err); res.status(500).json({ error: 'Error.' })
    }
  },
}

module.exports = ClientesController
