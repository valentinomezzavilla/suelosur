'use strict'
// Transacciones: todo el movimiento de plata (entradas y salidas) con botones por tipo.
// Ver MovimientosDineroModel para de dónde sale cada fila.
const TransaccionesModel = require('../models/transacciones.model')
const MovimientosDineroModel = require('../models/movimientosDinero.model')
const ClientesModel = require('../models/clientes.model')
const { resolverPeriodo, etiquetaPeriodo } = require('../utils/periodos')
const { fmtFecha, hoyISO } = require('../utils/fecha')
const { leerFechaPago } = require('../utils/fechaPago')

const POR_PAGINA = 20
const METODOS = {
  efectivo: 'Efectivo', transferencia: 'Transferencia', cheque: 'Cheque', echeq: 'Echeq',
  cuenta_corriente: 'Cuenta corriente', saldo_a_favor: 'Saldo a favor',
}
const SENTIDO = { entrada: 'Entrada', salida: 'Salida', a_cuenta: 'A cuenta corriente' }

// Los mismos filtros para el listado y para el reporte: lo que se ve es lo que se exporta.
function leerFiltros(q) {
  const periodo = resolverPeriodo({ preset: q.preset, desde: q.fechaDesde, hasta: q.fechaHasta, mes: q.mes })
  const categoria = MovimientosDineroModel.CLAVES.includes(q.categoria) ? q.categoria : 'todas'
  return {
    periodo,
    filtros: {
      categoria,
      id: q.id, tipo: q.tipo, clienteId: q.idCliente, cliente: q.cliente, remito: q.remito, nroOp: q.nroOp,
      fechaDesde: periodo.desde, fechaHasta: periodo.hasta,
      montoMin: q.montoMin, montoMax: q.montoMax,
    },
  }
}

const TransaccionesController = {
  async index(req, res) {
    try {
      const { id, tipo, idCliente, cliente, remito, nroOp, montoMin, montoMax, sortBy, sortDir } = req.query
      // Período: presets (hoy/semana/mes/rango). Default = mes en curso.
      const { periodo, filtros: baseFiltros } = leerFiltros(req.query)

      const pagina = Math.max(1, Number(req.query.page) || 1)
      const resultado = await MovimientosDineroModel.listar({
        ...baseFiltros,
        page: pagina, limit: POR_PAGINA,
        sortBy: sortBy || 'fecha', sortDir: sortDir || 'DESC',
      })
      const metricas = await MovimientosDineroModel.resumen(baseFiltros)

      const filtros = {
        categoria: baseFiltros.categoria,
        id: id||'', tipo: tipo||'', idCliente: idCliente||'', cliente: cliente||'', remito: remito||'', nroOp: nroOp||'',
        fechaDesde: periodo.desde||'', fechaHasta: periodo.hasta||'', montoMin: montoMin||'',
        montoMax: montoMax||'', mes: periodo.mes||'', preset: periodo.preset||'',
        sortBy: sortBy||'fecha', sortDir: sortDir||'DESC',
      }

      res.render('pages/transacciones/index', {
        titulo: 'Transacciones',
        movimientos: resultado.rows,
        filtros,
        categorias: MovimientosDineroModel.CATEGORIAS,
        codigoMov: MovimientosDineroModel.codigo,
        clientesLista: await ClientesModel.listar(),
        metricas,
        periodoLabel: etiquetaPeriodo(periodo),
        pagina: resultado.page,
        totalPaginas: resultado.totalPaginas,
        totalTransacciones: resultado.total,
        scripts: ['/js/transacciones.js'],
      })
    } catch (err) {
      console.error(err); req.flash('error', 'Error al cargar transacciones.'); res.redirect('back')
    }
  },

  // Reporte de lo filtrado (sin paginar): detalle con entradas y salidas, totales y subtotales
  // por tipo y por método de pago. formato = pdf | excel.
  async exportar(req, res) {
    try {
      const formato = req.params.formato === 'pdf' ? 'pdf' : 'excel'
      const { periodo, filtros } = leerFiltros(req.query)
      const lista = await MovimientosDineroModel.todos(filtros)
      const ops = await MovimientosDineroModel.detalleOperaciones(lista.filter(t => t.origen === 'transaccion').map(t => t.id_op_encabezado))

      const metodo = (t) => {
        const m = METODOS[t.metodo_pago] || t.metodo_pago || ''
        if (t.metodo_pago !== 'cuenta_corriente' || t.saldada == null) return m
        return `Cta. cte. · ${t.saldada ? 'saldada' : 'sin saldar'}`
      }
      // Cobros: "Descripción" = qué se vendió (sale de la operación, no del texto libre
      // guardado), con obra y observaciones en sus columnas. Pagos y egresos: su descripción.
      const descripcionDe = (t) => {
        if (t.origen !== 'transaccion') return t.descripcion || ''
        const op = ops[t.id_op_encabezado] || {}
        if (op.productos_str) return op.productos_str
        if (t.tipo === 'Alquiler')   return op.numero_contenedor ? `Contenedor N° ${op.numero_contenedor}` : 'Alquiler de contenedor'
        if (t.tipo === 'Maquinaria') return op.maquinaria_nombre || 'Alquiler de maquinaria'
        return t.descripcion || ''
      }
      // La venta en cantera guarda la observación pegada al listado de productos: se le saca
      const observacionesDe = (t) => {
        if (t.origen !== 'transaccion') return ''
        const op = ops[t.id_op_encabezado] || {}
        let obs = op.obs_operacion || ''
        if (op.productos_str && obs.startsWith(op.productos_str)) obs = obs.slice(op.productos_str.length).replace(/^\s*—\s*/, '')
        return obs.trim()
      }
      const redondear = (n) => Math.round(n * 100) / 100
      const filas = lista.map(t => ({
        codigo: MovimientosDineroModel.codigo(t),
        fecha: fmtFecha(t.fecha),
        cargado: fmtFecha(t.cargado_en),
        tipo: t.origen === 'transaccion' ? t.tipo : (t.origen === 'pago_cliente' ? 'Pago de cliente' : t.tipo),
        cliente: t.persona || '',
        descripcion: descripcionDe(t),
        obra: t.origen === 'transaccion' ? (ops[t.id_op_encabezado]?.obra || '') : '',
        observaciones: observacionesDe(t),
        metodo: metodo(t),
        remito: t.nro_remito ? String(t.nro_remito).padStart(8, '0') : '',
        entrada: t.sentido === 'entrada' ? redondear(Number(t.monto) || 0) : '',
        salida: t.sentido === 'salida' ? redondear(Number(t.monto) || 0) : '',
        aCuenta: t.sentido === 'a_cuenta' ? redondear(Number(t.monto) || 0) : '',
      }))

      const tot = MovimientosDineroModel.totalesDe(lista)
      const subtotales = (clave, etiqueta) => {
        const grupos = new Map()
        lista.forEach(t => {
          const k = etiqueta(t)
          const g = grupos.get(k) || { count: 0, entrada: 0, salida: 0, aCuenta: 0 }
          g.count++
          const m = Number(t.monto) || 0
          if (t.sentido === 'entrada') g.entrada += m; else if (t.sentido === 'salida') g.salida += m; else g.aCuenta += m
          grupos.set(k, g)
        })
        return [...grupos.entries()]
          .sort((a, b) => (b[1].entrada + b[1].salida + b[1].aCuenta) - (a[1].entrada + a[1].salida + a[1].aCuenta))
          .map(([k, g]) => ({
            descripcion: `${clave}: ${k}`, cliente: `${g.count} movimiento(s)`,
            entrada: g.entrada ? redondear(g.entrada) : '', salida: g.salida ? redondear(g.salida) : '', aCuenta: g.aCuenta ? redondear(g.aCuenta) : '',
          }))
      }

      if (filas.length) {
        filas.push({ descripcion: 'TOTAL', cliente: `${filas.length} movimiento(s)`, entrada: tot.entradas, salida: tot.salidas, aCuenta: tot.aCuenta || '', _destacar: true })
        filas.push({ descripcion: 'NETO (entradas − salidas)', entrada: tot.neto, _destacar: true })
        filas.push({})
        filas.push({ descripcion: 'Por tipo', _destacar: true })
        filas.push(...subtotales('Tipo', t => t.origen === 'pago_cliente' ? 'Pago de cliente' : t.tipo))
        filas.push({})
        filas.push({ descripcion: 'Por método de pago', _destacar: true })
        filas.push(...subtotales('Método', t => METODOS[t.metodo_pago] || t.metodo_pago || 'Sin dato'))
      }

      // Qué filtros se aplicaron, para que el reporte se entienda solo
      const cat = MovimientosDineroModel.CATEGORIAS.find(c => c.clave === filtros.categoria)
      const detalleFiltros = [
        etiquetaPeriodo(periodo),
        filtros.categoria !== 'todas' && cat ? `Mostrando: ${cat.etiqueta}` : null,
        filtros.tipo && filtros.tipo !== 'todos' ? `Tipo: ${filtros.tipo}` : null,
        filtros.cliente ? `Cliente / persona: ${filtros.cliente}` : null,
        filtros.montoMin ? `Monto desde $${Number(filtros.montoMin).toLocaleString('es-AR')}` : null,
        filtros.montoMax ? `Monto hasta $${Number(filtros.montoMax).toLocaleString('es-AR')}` : null,
        'Fecha = fecha de pago',
      ].filter(Boolean).join(' · ')
      const titulo = 'Reporte de transacciones'
      const hoy = hoyISO()
      const nombreArchivo = `transacciones-${periodo.desde || 'inicio'}-a-${periodo.hasta || hoy}`

      if (formato === 'pdf') {
        const { generarTablaPDF } = require('../utils/pdfTabla')
        return generarTablaPDF(res, {
          titulo,
          subtitulo: detalleFiltros,
          columnas: [
            { header: 'Código', key: 'codigo', width: 0.075 },
            { header: 'Fecha de pago', key: 'fecha', width: 0.07 },
            { header: 'Tipo', key: 'tipo', width: 0.08 },
            { header: 'Cliente / persona', key: 'cliente', width: 0.12 },
            { header: 'Descripción', key: 'descripcion', width: 0.15 },
            { header: 'Obra', key: 'obra', width: 0.08 },
            { header: 'Método de pago', key: 'metodo', width: 0.10 },
            { header: 'Remito', key: 'remito', width: 0.06 },
            { header: 'Entrada', key: 'entrada', width: 0.09, money: true, align: 'right' },
            { header: 'Salida', key: 'salida', width: 0.09, money: true, align: 'right' },
            { header: 'A cta. cte.', key: 'aCuenta', width: 0.085, money: true, align: 'right' },
          ],
          filas: filas.length ? filas : [{ descripcion: 'No hay movimientos que coincidan con los filtros' }],
          registros: lista.length,
          nombreArchivo,
        })
      }
      const { generarExcel } = require('../utils/excel')
      return generarExcel(res, {
        titulo: `${titulo} — ${detalleFiltros}`,
        columnas: [
          { header: 'Código', key: 'codigo', width: 13 },
          { header: 'Fecha de pago', key: 'fecha', width: 13 },
          { header: 'Cargado el', key: 'cargado', width: 12 },
          { header: 'Tipo', key: 'tipo', width: 18 },
          { header: 'Cliente / persona', key: 'cliente', width: 28 },
          { header: 'Descripción', key: 'descripcion', width: 32 },
          { header: 'Obra', key: 'obra', width: 24 },
          { header: 'Observaciones', key: 'observaciones', width: 30 },
          { header: 'Método de pago', key: 'metodo', width: 28 },
          { header: 'Remito', key: 'remito', width: 12 },
          { header: 'Entrada', key: 'entrada', width: 16, money: true },
          { header: 'Salida', key: 'salida', width: 16, money: true },
          { header: 'A cuenta corriente', key: 'aCuenta', width: 18, money: true },
        ],
        filas,
        nombreArchivo,
      })
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al generar el reporte de transacciones.')
      res.redirect('/transacciones')
    }
  },

  // Corrige el método de pago de una transacción ya cargada (p.ej. se finalizó como
  // "efectivo" y en realidad era "cuenta corriente"). Ver TransaccionesModel.cambiarMetodoPago.
  async cambiarMetodoPago(req, res) {
    try {
      const tx = await TransaccionesModel.obtener(req.params.id)
      if (!tx) throw new Error('La transacción no existe.')
      const tercero = await require('../services/tercero.service').leer(req.body, req.body.metodo_pago)
      await TransaccionesModel.cambiarMetodoPago(req.params.id, req.body.metodo_pago, tercero)
      req.flash('success', `Método de pago de ${TransaccionesModel.codigo(tx)} actualizado.`)
    } catch (err) {
      console.error(err)
      req.flash('error', err.message || 'Error al actualizar el método de pago.')
    }
    res.redirect('back')
  },

  // Corrige la fecha de pago de un cobro (se cobró otro día del que se cargó)
  async cambiarFechaPago(req, res) {
    try {
      const tx = await TransaccionesModel.obtener(req.params.id)
      if (!tx) throw new Error('La transacción no existe.')
      if (!String(req.body.fecha || '').trim()) throw new Error('Elegí la fecha de pago.')
      const { fecha, error } = leerFechaPago(req.body.fecha)
      if (error) throw new Error(error)
      await TransaccionesModel.cambiarFechaPago(req.params.id, fecha)
      req.flash('success', `Fecha de pago de ${TransaccionesModel.codigo(tx)} cambiada al ${fmtFecha(fecha)}.`)
    } catch (err) {
      console.error(err)
      req.flash('error', err.message || 'Error al cambiar la fecha de pago.')
    }
    res.redirect('back')
  },

  // Borra la transacción junto con su operación. Es irreversible: la confirmación
  // se pide en el modal de la vista.
  async eliminar(req, res) {
    try {
      const tx = await TransaccionesModel.obtener(req.params.id)
      if (!tx) throw new Error('La transacción no existe.')
      const codigo = TransaccionesModel.codigo(tx)
      const { id_op_encabezado } = await TransaccionesModel.eliminar(req.params.id)
      const avisoCC = tx.metodo_pago === 'cuenta_corriente' ? ' Se revirtió el cargo en la cuenta corriente del cliente.' : ''
      req.flash('success', (id_op_encabezado
        ? `Transacción ${codigo} y su operación eliminadas.`
        : `Transacción ${codigo} eliminada.`) + avisoCC)
    } catch (err) {
      console.error(err)
      req.flash('error', err.message || 'Error al eliminar la transacción.')
    }
    res.redirect('back')
  },
}

module.exports = TransaccionesController
