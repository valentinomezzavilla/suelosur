'use strict'
const ClientesModel = require('../models/clientes.model')
const TransaccionesModel = require('../models/transacciones.model')
const Tercero = require('../services/tercero.service')
const paginar       = require('../utils/paginar')
const { etiquetaPeriodo } = require('../utils/periodos')
const { generarTablaPDF } = require('../utils/pdfTabla')
const { fmtFecha, hoyISO } = require('../utils/fecha')
const { normalizarFiltros, TIPOS } = require('../utils/liquidaciones')

// Fecha YYYY-MM-DD válida, o null (lo mal formado se ignora)
const fechaISO = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(new Date(v + 'T00:00:00').getTime())
  && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v ? v : null

// Pago de cuenta corriente por transferencia a un tercero: el egreso por el mismo monto
async function egresoPagoCC(req, tercero, { monto, movId }) {
  const cli = await ClientesModel.obtener(req.params.id)
  await Tercero.crearEgreso(tercero, {
    monto, id_movimiento_cuenta: movId, id_usuario: req.session.user?.id,
    descripcion: `Transferencia de ${ClientesModel.nombreCompleto(cli)} a tercero (pago de cuenta corriente)`,
  })
}

const ClientesController = {

  async index(req, res) {
    try {
      const { nombre, dni, id, q, page, sort, dir, tipo, cuentaCorriente } = req.query
      let todos
      if (q && q.trim())                todos = await ClientesModel.buscarLive(q, 500)
      else if (nombre || dni || id)     todos = await ClientesModel.buscar({ id, nombre, dni })
      else                              todos = await ClientesModel.listar()

      // Filtros adicionales
      if (tipo && tipo !== '')          todos = todos.filter(c => (c.tipo_cliente || '').toLowerCase() === String(tipo).toLowerCase())
      if (cuentaCorriente === 'si')     todos = todos.filter(c => !!c.cuenta_corriente)
      if (cuentaCorriente === 'no')     todos = todos.filter(c => !c.cuenta_corriente)

      // Ordenamiento dinámico (sort)
      const sortMap = {
        numero:   (c) => c.numero || 0,
        nombre:   (c) => (c.nombre || '').toLowerCase(),
        apellido: (c) => (c.apellido || '').toLowerCase(),
        dni:      (c) => (c.dni || ''),
        telefono: (c) => (c.telefono || c.tel_whatsapp || ''),
        saldo:    (c) => Number(c.saldo || 0),
      }
      const sortKey = sortMap[sort] ? sort : 'numero'
      const dirNorm = String(dir || '').toUpperCase() === 'DESC' ? 'DESC' : 'ASC'
      const getter = sortMap[sortKey]
      todos = [...todos].sort((a, b) => {
        const va = getter(a), vb = getter(b)
        if (va < vb) return dirNorm === 'ASC' ? -1 : 1
        if (va > vb) return dirNorm === 'ASC' ?  1 : -1
        return 0
      })

      const { items: clientes, total, page: pag, limit, totalPaginas } = paginar(todos, page, 20)
      res.render('pages/clientes/index', {
        titulo: 'Clientes', clientes, total, page: pag, limit, totalPaginas,
        filtros: { id: id||'', nombre: nombre||'', dni: dni||'', q: q||'', tipo: tipo||'', cuentaCorriente: cuentaCorriente||'', sort: sortKey, dir: dirNorm },
      })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('back')
    }
  },

  // ── Submódulo Cuenta Corriente ────────────────────────────────
  async cuentas(req, res) {
    try {
      const cuentasRaw = await ClientesModel.listarCuentas()
      const conCuenta = cuentasRaw.map(c => ({
        ...c,
        telefono: c.telefono || c.tel_whatsapp,
        saldo: c.saldo ?? 0,
      }))
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
      // Mismos filtros que Liquidaciones (el cliente es este): los movimientos de la
      // pantalla usan fechas y obra; el PDF es la liquidación del cliente con todos.
      const filtros = normalizarFiltros({ ...req.query, clienteId: String(cli.id) }, hoyISO())
      const obra = await ClientesModel.obraPorClave(cli.id, filtros.obra)
      const estado = await ClientesModel.estadoCuenta(cli.id, { desde: filtros.desde, hasta: filtros.hasta, obra })
      const obras = await ClientesModel.obras(cli.id)
      const cliente = { ...cli, telefono: cli.telefono || cli.tel_whatsapp, saldo: cli.saldo ?? 0 }
      // Cuánto falta de cada cargo: "Saldar" solo en los que todavía deben algo
      const pendientes = await ClientesModel.pendientePorCargo(cli.id)
      // Operaciones a cta. cte. que todavía no generaron cargo (alquileres en curso),
      // con el importe estimado a hoy
      const AlquileresModel = require('../models/alquileres.model')
      const sinCargo = await Promise.all((await ClientesModel.operacionesSinCargo(cli.id)).map(async o => {
        let estimado = null
        if (o.tipo_op === 'C') estimado = (await AlquileresModel.datosCierre(o.id))?.precioACobrar ?? (Number(o.precio_alquiler) || null)
        else if (o.tipo_op === 'MA') estimado = Number(o.precio_maquinaria) || null
        return { ...o, estimado }
      }))
      res.render('pages/clientes/cuenta_detalle', {
        titulo: `Cuenta corriente — ${ClientesModel.nombreCompleto(cliente)}`,
        cliente, estado, pendientes, sinCargo, obras, obra, TIPOS,
        periodoLabel: etiquetaPeriodo({ preset: 'rango', desde: filtros.desde, hasta: filtros.hasta }),
        filtros: { ...filtros, obra: obra ? obra.clave : null },
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
      // El reporte de la cuenta corriente es la liquidación del cliente (mismo PDF que Liquidaciones)
      const filtros = normalizarFiltros({ ...req.query, clienteId: String(cli.id) }, hoyISO())
      const liquidacion = await require('../models/liquidaciones.model').liquidacion(filtros)
      const { generarLiquidacionPDF } = require('../utils/pdfLiquidacion')
      generarLiquidacionPDF(res, { liquidacion, filtros, general: false })
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
      const tercero = clase === 'pago' ? await Tercero.leer(req.body, req.body.metodo_pago) : null
      const movId = await ClientesModel.agregarMovimiento(req.params.id, { tipo, descripcion: desc, monto: signed, metodo_pago: clase === 'pago' ? (req.body.metodo_pago || null) : null })
      if (tercero) await egresoPagoCC(req, tercero, { monto: m, movId })
      req.flash('success', 'Movimiento registrado.')
    } catch (err) {
      console.error(err); req.flash('error', err.message || 'Error al registrar el movimiento.')
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
    const zonas = await require('../models/zonas.model').listarActivas()
    res.render('pages/clientes/form', { titulo: 'Nuevo Cliente', cliente: null, zonas })
  },

  async crear(req, res) {
    try {
      const { nombre, apellido, domicilio_ppal, zona, tel_whatsapp, telefono, email, dni, tipo_cliente, cuentaCorriente } = req.body
      const fiscal = {
        cuit:          String(req.body.cuit || '').replace(/\D/g, '') || null,
        razon_social:  String(req.body.razon_social || '').trim() || null,
        condicion_iva: ['RI', 'MT', 'EX', 'CF'].includes(req.body.condicion_iva) ? req.body.condicion_iva : null,
      }
      if (!nombre) { req.flash('error', 'El nombre es obligatorio.'); return res.redirect('/clientes/nuevo') }
      await ClientesModel.crear({ nombre, apellido, domicilio_ppal, zona, tel_whatsapp, telefono, email, dni, tipo_cliente, cuenta_corriente: cuentaCorriente, ...fiscal })
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
      // Desde / Hasta filtran alquileres y transacciones; sin fechas, todo el histórico
      const desde = fechaISO(req.query.fechaDesde)
      const hasta = fechaISO(req.query.fechaHasta)
      const transacciones = (await TransaccionesModel.filtrar({ clienteId: cliente.id, fechaDesde: desde, fechaHasta: hasta, limit: 1000 })).rows
      // Alquileres (contenedor y maquinaria) con detalle y estado de pago: misma consulta que Liquidaciones
      const LiquidacionesModel = require('../models/liquidaciones.model')
      const liq = await LiquidacionesModel.liquidacion({
        clienteId: cliente.id, obra: null, desde: desde || '0000-01-01', hasta: hasta || '9999-12-31',
        tipos: ['contenedor', 'maquinaria'], estadoPago: 'todas',
      })
      const alquileres    = liq.clientes[0] ? liq.clientes[0].operaciones.slice().reverse() : []
      // Consumos en cta. cte. = los cargos de la cuenta (existen desde que se registra la
      // venta, entregada o no), con lo que falta pagar de cada uno
      const pendientes    = await ClientesModel.pendientePorCargo(cliente.id)
      const deudasCC      = movimientos
        .filter(m => m.tipo === 'deuda' && Math.abs(Number(m.monto)) > 0.005)
        .map(m => ({ ...m, resta: pendientes[m.id] ?? Math.abs(Number(m.monto)) }))
      res.render('pages/clientes/detalle', { titulo: `${cliente.nombre} ${cliente.apellido || ''}`.trim(), cliente, movimientos, transacciones, alquileres, deudasCC, filtros: { ...req.query, fechaDesde: desde || '', fechaHasta: hasta || '' }, scripts: ['/js/modalAbonar.js'] })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/clientes')
    }
  },

  async editar(req, res) {
    try {
      const cliente = await ClientesModel.obtener(req.params.id)
      if (!cliente) { req.flash('error', 'No encontrado.'); return res.redirect('/clientes') }
      const zonas = await require('../models/zonas.model').listarActivas()
      res.render('pages/clientes/form', { titulo: 'Editar Cliente', cliente, zonas })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/clientes')
    }
  },

  async actualizar(req, res) {
    try {
      const { nombre, apellido, domicilio_ppal, zona, tel_whatsapp, telefono, email, dni, tipo_cliente, cuentaCorriente } = req.body
      const fiscal = {
        cuit:          String(req.body.cuit || '').replace(/\D/g, '') || null,
        razon_social:  String(req.body.razon_social || '').trim() || null,
        condicion_iva: ['RI', 'MT', 'EX', 'CF'].includes(req.body.condicion_iva) ? req.body.condicion_iva : null,
      }
      if (!nombre) { req.flash('error', 'El nombre es obligatorio.'); return res.redirect(`/clientes/${req.params.id}/editar`) }
      await ClientesModel.actualizar(req.params.id, { nombre, apellido, domicilio_ppal, zona, tel_whatsapp, telefono, email, dni, tipo_cliente, cuenta_corriente: cuentaCorriente, ...fiscal })
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
    res.redirect('back')
  },

  async abonar(req, res) {
    try {
      const monto = Number(req.body.monto)
      if (!monto || monto <= 0) { req.flash('error', 'Monto inválido.'); return res.redirect('/clientes') }
      // Si viene de "Saldar" en una fila puntual del ledger, la descripción hace
      // referencia a esa operación; si no, queda el genérico de siempre.
      const concepto = (req.body.descripcion || '').trim()
      const descripcion = concepto ? `Pago — ${concepto}` : 'Pago / abono de deuda'
      const tercero = await Tercero.leer(req.body, req.body.metodo_pago)
      const movId = await ClientesModel.agregarMovimiento(req.params.id, { tipo: 'pago', descripcion, monto, metodo_pago: req.body.metodo_pago || null })
      if (tercero) await egresoPagoCC(req, tercero, { monto, movId })
      req.flash('success', `Abono de $${monto.toLocaleString('es-AR')} registrado.`)
    } catch (err) {
      console.error(err); req.flash('error', err.message || 'Error.')
    }
    res.redirect('back')
  },

  // API JSON: obras del cliente para el filtro por obra (libro de ventas)
  async obrasApi(req, res) {
    try {
      const obras = await ClientesModel.obras(req.params.id)
      res.json(obras.map(o => ({ clave: o.clave, nombre: o.nombre })))
    } catch (err) {
      console.error(err); res.status(500).json({ error: 'Error.' })
    }
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
        email: c.email, zona: c.zona || '', domicilio: c.domicilio_ppal || '',
        cuentaCorriente: !!c.cuenta_corriente,
        saldoFavor: Math.max(0, Number(c.saldo) || 0),
      })))
    } catch (err) {
      console.error(err); res.status(500).json({ error: 'Error.' })
    }
  },

  async crearApi(req, res) {
    try {
      const { nombre, apellido, dni, telefono, email, cuenta_corriente } = req.body
      if (!nombre || !String(nombre).trim()) return res.status(400).json({ error: 'El nombre es obligatorio.' })
      const id    = await ClientesModel.crear({ nombre, apellido, dni, telefono, email, cuenta_corriente: !!cuenta_corriente })
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

  // ── Reportes por cliente ──────────────────────────────────────
  // Página con form de filtros
  async reporteForm(req, res) {
    try {
      const cliente = await ClientesModel.obtener(req.params.id)
      if (!cliente) { req.flash('error', 'Cliente no encontrado.'); return res.redirect('/clientes') }
      res.render('pages/clientes/reporte', {
        titulo: `Reporte — ${ClientesModel.nombreCompleto(cliente)}`,
        cliente,
        obras: await ClientesModel.obras(cliente.id),
        filtros: { fechaDesde: '', fechaHasta: '', tipo: 'todos', incluir: ['transacciones','movimientos'] },
      })
    } catch (err) { console.error(err); req.flash('error', 'Error.'); res.redirect('/clientes') }
  },

  // POST: genera y descarga el PDF
  async reportePDF(req, res) {
    try {
      const cliente = await ClientesModel.obtener(req.params.id)
      if (!cliente) { req.flash('error', 'Cliente no encontrado.'); return res.redirect('/clientes') }

      const { fechaDesde, fechaHasta, tipo } = req.body
      const incluir = Array.isArray(req.body.incluir) ? req.body.incluir : (req.body.incluir ? [req.body.incluir] : [])
      const desdeISO = fechaDesde || null
      const hastaISO = fechaHasta || null

      // Transacciones
      const txAll = await TransaccionesModel.filtrar({
        clienteId: cliente.id,
        tipo: tipo && tipo !== 'todos' ? tipo : null,
        fechaDesde: desdeISO, fechaHasta: hastaISO,
        page: 1, limit: 9999,
      })
      const transacciones = txAll.rows || []
      const totalTransacciones = transacciones.reduce((acc, t) => acc + Number(t.monto || 0), 0)

      // Movimientos de cuenta corriente
      const movs = await ClientesModel.movimientosFiltrados(cliente.id, { fechaDesde: desdeISO, fechaHasta: hastaISO })
      const totalDeuda = movs.filter(m => m.tipo === 'deuda').reduce((a, m) => a + Number(m.monto || 0), 0)
      const totalPagos = movs.filter(m => m.tipo === 'pago').reduce((a, m) => a + Number(m.monto || 0), 0)

      // Construir las filas de movimientos (transacciones y/o cuenta corriente)
      const filas = []
      if (incluir.includes('transacciones')) {
        transacciones.forEach(t => filas.push({
          fechaISO: t.fecha || t.created_at,
          fecha: fmtFecha(t.fecha || t.created_at),
          tipo:  t.tipo || '—',
          desc:  t.descripcion || `Remito ${t.nro_remito || '—'}`,
          // Las transacciones (ventas/alquileres) representan cargos → débito
          monto: -Math.abs(Number(t.monto || 0)),
        }))
      }
      if (incluir.includes('movimientos')) {
        movs.forEach(m => filas.push({
          fechaISO: m.created_at,
          fecha: fmtFecha(m.created_at),
          tipo:  m.tipo === 'pago' ? 'Pago' : m.tipo === 'deuda' ? 'Deuda' : 'Ajuste',
          desc:  m.descripcion || '—',
          monto: Number(m.monto || 0),
        }))
      }
      // Ordenar cronológicamente
      filas.sort((a, b) => String(a.fechaISO || '').localeCompare(String(b.fechaISO || '')))

      const periodoLabel = [desdeISO && `desde ${fmtFecha(desdeISO)}`, hastaISO && `hasta ${fmtFecha(hastaISO)}`]
        .filter(Boolean).join(' ') || 'Histórico completo'

      const { generarReporteClientePDF } = require('../utils/pdfReporteCliente')
      return generarReporteClientePDF(res, {
        cliente: {
          ...cliente,
          nombreCompleto: ClientesModel.nombreCompleto(cliente),
        },
        periodoLabel,
        resumen: {
          totalTransacciones,
          totalDeuda,
          totalPagos,
          saldo: Number(cliente.saldo || 0),
        },
        filas,
        nombreArchivo: `reporte-cliente-${cliente.numero || cliente.id}`,
      })
    } catch (err) {
      console.error(err); req.flash('error', 'Error al generar el reporte.')
      res.redirect(`/clientes/${req.params.id}/reporte`)
    }
  },
}

module.exports = ClientesController
