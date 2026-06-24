'use strict'
const ClientesModel = require('../models/clientes.model')
const TransaccionesModel = require('../models/transacciones.model')
const paginar       = require('../utils/paginar')
const { resolverPeriodo, etiquetaPeriodo } = require('../utils/periodos')

const ClientesController = {

  async index(req, res) {
    try {
      const { nombre, dni, id, q, page } = req.query
      let todos
      if (q && q.trim())                todos = await ClientesModel.buscarLive(q, 500)
      else if (nombre || dni || id)     todos = await ClientesModel.buscar({ id, nombre, dni })
      else                              todos = await ClientesModel.listar()
      const { items: clientes, total, page: pag, limit, totalPaginas } = paginar(todos, page, 15)
      res.render('pages/clientes/index', {
        titulo: 'Clientes', clientes, total, page: pag, limit, totalPaginas,
        filtros: { id: id||'', nombre: nombre||'', dni: dni||'', q: q||'' },
      })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('back')
    }
  },

  // ── Submódulo Cuenta Corriente ────────────────────────────────
  async cuentas(req, res) {
    try {
      const cuentasRaw = await ClientesModel.listarCuentas()
      const conCuenta = await Promise.all(cuentasRaw.map(async c => ({
        ...c,
        telefono: c.telefono || c.tel_whatsapp,
        saldo: c.saldo ?? 0,
        movimientos: await ClientesModel.movimientos(c.id),
      })))
      const sinCuentaRaw = await ClientesModel.sinCuenta()
      const sinCuenta = sinCuentaRaw.map(c => ({ ...c, telefono: c.telefono || c.tel_whatsapp }))
      res.render('pages/clientes/cuentas', {
        titulo: 'Cuentas corrientes', conCuenta, sinCuenta, scripts: ['/js/modalAbonar.js'],
      })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/clientes')
    }
  },

  async cuentaDetalle(req, res) {
    try {
      const cli = await ClientesModel.obtener(req.params.id)
      if (!cli) { req.flash('error', 'Cliente no encontrado.'); return res.redirect('/clientes/cuentas') }
      const periodo = resolverPeriodo({
        preset: req.query.preset, desde: req.query.fechaDesde, hasta: req.query.fechaHasta, mes: req.query.mes,
      })
      const estado = await ClientesModel.estadoCuenta(cli.id, { desde: periodo.desde, hasta: periodo.hasta })
      const cliente = { ...cli, telefono: cli.telefono || cli.tel_whatsapp, saldo: cli.saldo ?? 0 }
      res.render('pages/clientes/cuenta_detalle', {
        titulo: `Cuenta corriente — ${ClientesModel.nombreCompleto(cliente)}`,
        cliente, estado,
        periodoLabel: etiquetaPeriodo(periodo),
        filtros: { ...req.query, fechaDesde: periodo.desde || '', fechaHasta: periodo.hasta || '', preset: periodo.preset || '' },
        scripts: ['/js/modalAbonar.js'],
      })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/clientes/cuentas')
    }
  },

  async cuentaPdf(req, res) {
    try {
      const cli = await ClientesModel.obtener(req.params.id)
      if (!cli) { req.flash('error', 'Cliente no encontrado.'); return res.redirect('/clientes/cuentas') }
      const periodo = resolverPeriodo({
        preset: req.query.preset, desde: req.query.fechaDesde, hasta: req.query.fechaHasta, mes: req.query.mes,
      })
      const estado = await ClientesModel.estadoCuenta(cli.id, { desde: periodo.desde, hasta: periodo.hasta })
      const { generarEstadoCuentaPDF } = require('../utils/pdfEstadoCuenta')
      generarEstadoCuentaPDF(res, { cliente: cli, estado, periodoLabel: etiquetaPeriodo(periodo) })
    } catch (err) {
      console.error(err); req.flash('error', 'Error al generar el PDF.'); res.redirect('back')
    }
  },

  async registrarMovimiento(req, res) {
    const back = `/clientes/cuentas/${req.params.id}`
    try {
      const { clase, monto, descripcion, signo } = req.body
      const m = Number(monto)
      if (!m || m <= 0) { req.flash('error', 'Ingresá un monto válido.'); return res.redirect(back) }
      let tipo, signed, desc
      if (clase === 'pago')       { tipo = 'pago';   signed =  m; desc = descripcion || 'Pago / abono de deuda' }
      else if (clase === 'cargo') { tipo = 'deuda';  signed = -m; desc = descripcion || 'Cargo manual' }
      else                        { tipo = 'ajuste'; signed = (signo === 'neg' ? -m : m); desc = descripcion || 'Ajuste de saldo' }
      await ClientesModel.agregarMovimiento(req.params.id, { tipo, descripcion: desc, monto: signed })
      req.flash('success', 'Movimiento registrado.')
    } catch (err) {
      console.error(err); req.flash('error', 'Error al registrar el movimiento.')
    }
    res.redirect(back)
  },

  async deshabilitarCuenta(req, res) {
    try {
      await ClientesModel.deshabilitarCuenta(req.params.id)
      req.flash('success', 'Cuenta corriente deshabilitada.')
    } catch (err) {
      console.error(err); req.flash('error', 'Error.')
    }
    res.redirect('back')
  },

  async nuevo(req, res) {
    res.render('pages/clientes/form', { titulo: 'Nuevo Cliente', cliente: null })
  },

  async crear(req, res) {
    try {
      const { nombre, apellido, domicilio_ppal, zona, tel_whatsapp, telefono, email, dni, tipo_cliente, cuentaCorriente } = req.body
      if (!nombre) { req.flash('error', 'El nombre es obligatorio.'); return res.redirect('/clientes/nuevo') }
      await ClientesModel.crear({ nombre, apellido, domicilio_ppal, zona, tel_whatsapp, telefono, email, dni, tipo_cliente, cuenta_corriente: cuentaCorriente })
      req.flash('success', 'Cliente creado.')
      res.redirect('/clientes')
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/clientes/nuevo')
    }
  },

  async detalle(req, res) {
    try {
      const cli = await ClientesModel.obtener(req.params.id)
      if (!cli) { req.flash('error', 'No encontrado.'); return res.redirect('/clientes') }
      const cliente = { ...cli, cuentaCorriente: !!cli.cuenta_corriente, telefono: cli.telefono || cli.tel_whatsapp, direccion: cli.domicilio_ppal, saldo: cli.saldo ?? 0 }
      const movimientos   = await ClientesModel.movimientos(cliente.id)
      const transacciones = (await TransaccionesModel.filtrar({ clienteId: cliente.id, limit: 1000 })).rows
      const alquileres    = []
      const deudasCC      = transacciones
        .filter(t => t.metodo_pago === 'cuenta_corriente')
        .map(t => ({ ...t, saldada: false }))
      res.render('pages/clientes/detalle', { titulo: `${cliente.nombre} ${cliente.apellido || ''}`.trim(), cliente, movimientos, transacciones, alquileres, deudasCC, filtros: req.query, scripts: ['/js/modalAbonar.js'] })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/clientes')
    }
  },

  async editar(req, res) {
    try {
      const cliente = await ClientesModel.obtener(req.params.id)
      if (!cliente) { req.flash('error', 'No encontrado.'); return res.redirect('/clientes') }
      res.render('pages/clientes/form', { titulo: 'Editar Cliente', cliente })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/clientes')
    }
  },

  async actualizar(req, res) {
    try {
      const { nombre, apellido, domicilio_ppal, zona, tel_whatsapp, telefono, email, dni, tipo_cliente, cuentaCorriente } = req.body
      if (!nombre) { req.flash('error', 'El nombre es obligatorio.'); return res.redirect(`/clientes/${req.params.id}/editar`) }
      await ClientesModel.actualizar(req.params.id, { nombre, apellido, domicilio_ppal, zona, tel_whatsapp, telefono, email, dni, tipo_cliente, cuenta_corriente: cuentaCorriente })
      req.flash('success', 'Cliente actualizado.')
      res.redirect('/clientes')
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/clientes')
    }
  },

  async toggleActivo(req, res) {
    try {
      await ClientesModel.toggleActivo(req.params.id)
      req.flash('success', 'Estado actualizado.')
    } catch (err) {
      console.error(err); req.flash('error', 'Error.')
    }
    res.redirect('/clientes')
  },

  async eliminar(req, res) {
    try {
      const chk = await ClientesModel.puedeEliminar(req.params.id)
      if (!chk.ok) { req.flash('error', `No se puede eliminar: ${chk.motivo}`); return res.redirect('back') }
      await ClientesModel.eliminar(req.params.id)
      req.flash('success', 'Cliente eliminado (baja lógica). Se conserva el historial.')
    } catch (err) {
      console.error(err); req.flash('error', 'Error al eliminar el cliente.')
    }
    res.redirect('/clientes')
  },

  async habilitarCuenta(req, res) {
    try {
      await ClientesModel.habilitarCuenta(req.params.id)
      req.flash('success', 'Cuenta corriente habilitada.')
    } catch (err) {
      console.error(err); req.flash('error', 'Error.')
    }
    res.redirect('/clientes')
  },

  async abonar(req, res) {
    try {
      const monto = Number(req.body.monto)
      if (!monto || monto <= 0) { req.flash('error', 'Monto inválido.'); return res.redirect('/clientes') }
      await ClientesModel.agregarMovimiento(req.params.id, { tipo: 'pago', descripcion: 'Pago / abono de deuda', monto })
      req.flash('success', `Abono de $${monto.toLocaleString('es-AR')} registrado.`)
    } catch (err) {
      console.error(err); req.flash('error', 'Error.')
    }
    res.redirect('back')
  },

  // API JSON para buscar clientes desde el front (buscarCliente.js)
  async buscarApi(req, res) {
    try {
      const { id, dni, nombre, q } = req.query
      let resultados
      if (q && q.trim())            resultados = await ClientesModel.buscarLive(q)
      else if (id || dni || nombre) resultados = await ClientesModel.buscar({ id, dni, nombre })
      else return res.json([])
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

  async crearApi(req, res) {
    try {
      const { nombre, apellido, dni, telefono, email } = req.body
      if (!nombre || !apellido || !telefono) return res.status(400).json({ error: 'Nombre, apellido y teléfono son obligatorios.' })
      const id    = await ClientesModel.crear({ nombre, apellido, dni, telefono, email })
      const nuevo = await ClientesModel.obtener(id)
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
