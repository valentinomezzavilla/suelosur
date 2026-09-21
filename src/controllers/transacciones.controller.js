'use strict'
const TransaccionesModel = require('../models/transacciones.model')
const ClientesModel = require('../models/clientes.model')
const { resolverPeriodo, etiquetaPeriodo } = require('../utils/periodos')
const { fmtFecha } = require('../utils/fecha')

const TIPOS = ['Venta Cantera', 'Venta Viaje', 'Alquiler', 'Maquinaria', 'Ajuste']
const POR_PAGINA = 20
const METODOS = { efectivo: 'Efectivo', transferencia: 'Transferencia', cheque: 'Cheque', cuenta_corriente: 'Cuenta corriente' }

// Los mismos filtros para el listado y para el reporte: lo que se ve es lo que se exporta.
function leerFiltros(q) {
  const periodo = resolverPeriodo({ preset: q.preset, desde: q.fechaDesde, hasta: q.fechaHasta, mes: q.mes })
  return {
    periodo,
    filtros: {
      id: q.id, tipo: q.tipo, clienteId: q.idCliente, cliente: q.cliente,
      fechaDesde: periodo.desde, fechaHasta: periodo.hasta,
      montoMin: q.montoMin, montoMax: q.montoMax,
    },
  }
}

const TransaccionesController = {
  async index(req, res) {
    try {
      const { id, tipo, idCliente, cliente, montoMin, montoMax, sortBy, sortDir } = req.query

      // Período: presets (hoy/semana/mes/rango). Default = mes en curso.
      const { periodo, filtros: baseFiltros } = leerFiltros(req.query)

      const pagina = Math.max(1, Number(req.query.page) || 1)
      const resultado = await TransaccionesModel.filtrar({
        ...baseFiltros,
        page: pagina, limit: POR_PAGINA,
        sortBy: sortBy || 'created_at', sortDir: sortDir || 'DESC',
      })
      const metricas = await TransaccionesModel.resumen(baseFiltros)

      const filtros = {
        id: id||'', tipo: tipo||'', idCliente: idCliente||'', cliente: cliente||'',
        fechaDesde: periodo.desde||'', fechaHasta: periodo.hasta||'', montoMin: montoMin||'',
        montoMax: montoMax||'', mes: periodo.mes||'', preset: periodo.preset||'',
        sortBy: sortBy||'created_at', sortDir: sortDir||'DESC',
      }

      res.render('pages/transacciones/index', {
        titulo: 'Transacciones',
        transacciones: resultado.rows,
        filtros,
        tipos: TIPOS,
        clientesLista: await ClientesModel.listar(),
        metricas,
        periodoLabel: etiquetaPeriodo(periodo),
        totalMes: resultado.sumaTotal,
        pagina: resultado.page,
        totalPaginas: resultado.totalPaginas,
        totalTransacciones: resultado.total,
        scripts: ['/js/transacciones.js'],
      })
    } catch (err) {
      console.error(err); req.flash('error', 'Error al cargar transacciones.'); res.redirect('back')
    }
  },

  // Reporte de las transacciones filtradas (sin paginar): detalle, total y subtotales
  // por tipo y por método de pago. formato = pdf | excel.
  async exportar(req, res) {
    try {
      const formato = req.params.formato === 'pdf' ? 'pdf' : 'excel'
      const { periodo, filtros } = leerFiltros(req.query)
      const lista = await TransaccionesModel.paraReporte(filtros)

      const metodo = (t) => {
        const m = METODOS[t.metodo_pago] || t.metodo_pago || ''
        if (t.metodo_pago !== 'cuenta_corriente' || t.saldada == null) return m
        return `Cta. cte. · ${t.saldada ? 'saldada' : 'sin saldar'}`
      }
      // La descripción guardada en la transacción mezcla, según el tipo, qué se vendió,
      // la obra y las observaciones en un solo texto libre. Para el reporte se separan:
      // "Descripción" = qué se vendió (viene de la operación, no del texto guardado),
      // "Obra" y "Observaciones" aparte, cada una en su columna.
      const descripcionVenta = (t) => {
        if (t.productos_str) return t.productos_str
        if (t.tipo === 'Alquiler')   return t.numero_contenedor ? `Contenedor N° ${t.numero_contenedor}` : 'Alquiler de contenedor'
        if (t.tipo === 'Maquinaria') return t.maquinaria_nombre || 'Alquiler de maquinaria'
        return t.descripcion || ''
      }
      // La venta en cantera guarda la observación del usuario ya pegada al listado de
      // productos en el mismo campo ("Arena Gruesa x3 — anotación"), así que hay que
      // sacarle el listado de productos (que ya va en su propia columna) para que quede
      // solo la anotación.
      const observacionesLimpias = (t) => {
        let obs = t.obs_operacion || ''
        if (t.productos_str && obs.startsWith(t.productos_str)) {
          obs = obs.slice(t.productos_str.length).replace(/^\s*—\s*/, '')
        }
        return obs.trim()
      }
      const filas = lista.map(t => ({
        codigo: TransaccionesModel.codigo(t),
        fecha: fmtFecha(t.fecha),
        tipo: t.tipo,
        cliente: t.cliente,
        descripcion: descripcionVenta(t),
        obra: t.obra || '',
        observaciones: observacionesLimpias(t),
        metodo: metodo(t),
        remito: t.nro_remito ? String(t.nro_remito).padStart(8, '0') : '',
        monto: Number(t.monto) || 0,
      }))

      const redondear = (n) => Math.round(n * 100) / 100
      const total = redondear(filas.reduce((a, f) => a + f.monto, 0))
      const subtotales = (clave, etiqueta) => {
        const grupos = new Map()
        lista.forEach(t => {
          const k = etiqueta(t)
          const g = grupos.get(k) || { count: 0, monto: 0 }
          g.count++; g.monto += Number(t.monto) || 0
          grupos.set(k, g)
        })
        return [...grupos.entries()]
          .sort((a, b) => b[1].monto - a[1].monto)
          .map(([k, g]) => ({ descripcion: `${clave}: ${k}`, cliente: `${g.count} transacción(es)`, monto: redondear(g.monto) }))
      }

      if (filas.length) {
        filas.push({ descripcion: 'TOTAL', cliente: `${filas.length} transacción(es)`, monto: total, _destacar: true })
        filas.push({})
        filas.push({ descripcion: 'Por tipo', _destacar: true })
        filas.push(...subtotales('Tipo', t => t.tipo))
        filas.push({})
        filas.push({ descripcion: 'Por método de pago', _destacar: true })
        filas.push(...subtotales('Método', t => METODOS[t.metodo_pago] || t.metodo_pago || 'Sin dato'))
      }

      // Qué filtros se aplicaron, para que el reporte se entienda solo
      const detalleFiltros = [
        etiquetaPeriodo(periodo),
        filtros.tipo && filtros.tipo !== 'todos' ? `Tipo: ${filtros.tipo}` : null,
        filtros.cliente ? `Cliente: ${filtros.cliente}` : null,
        filtros.montoMin ? `Monto desde $${Number(filtros.montoMin).toLocaleString('es-AR')}` : null,
        filtros.montoMax ? `Monto hasta $${Number(filtros.montoMax).toLocaleString('es-AR')}` : null,
      ].filter(Boolean).join(' · ')
      const titulo = 'Reporte de transacciones'
      const hoy = new Date().toISOString().slice(0, 10)
      const nombreArchivo = `transacciones-${periodo.desde || 'inicio'}-a-${periodo.hasta || hoy}`

      if (formato === 'pdf') {
        const { generarTablaPDF } = require('../utils/pdfTabla')
        return generarTablaPDF(res, {
          titulo,
          subtitulo: detalleFiltros,
          columnas: [
            { header: 'Código', key: 'codigo', width: 0.080 },
            { header: 'Fecha', key: 'fecha', width: 0.072 },
            { header: 'Tipo', key: 'tipo', width: 0.087 },
            { header: 'Cliente', key: 'cliente', width: 0.130 },
            { header: 'Descripción', key: 'descripcion', width: 0.125 },
            { header: 'Obra', key: 'obra', width: 0.095 },
            { header: 'Observaciones', key: 'observaciones', width: 0.125 },
            { header: 'Método de pago', key: 'metodo', width: 0.113 },
            { header: 'Remito', key: 'remito', width: 0.065 },
            { header: 'Monto', key: 'monto', width: 0.108, money: true, align: 'right' },
          ],
          filas: filas.length ? filas : [{ descripcion: 'No hay transacciones que coincidan con los filtros' }],
          registros: lista.length,
          nombreArchivo,
        })
      }
      const { generarExcel } = require('../utils/excel')
      return generarExcel(res, {
        titulo: `${titulo} — ${detalleFiltros}`,
        columnas: [
          { header: 'Código', key: 'codigo', width: 13 },
          { header: 'Fecha', key: 'fecha', width: 12 },
          { header: 'Tipo', key: 'tipo', width: 15 },
          { header: 'Cliente', key: 'cliente', width: 28 },
          { header: 'Descripción', key: 'descripcion', width: 32 },
          { header: 'Obra', key: 'obra', width: 24 },
          { header: 'Observaciones', key: 'observaciones', width: 30 },
          { header: 'Método de pago', key: 'metodo', width: 28 },
          { header: 'Remito', key: 'remito', width: 12 },
          { header: 'Monto', key: 'monto', width: 16, money: true },
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
      await TransaccionesModel.cambiarMetodoPago(req.params.id, req.body.metodo_pago)
      req.flash('success', `Método de pago de ${TransaccionesModel.codigo(tx)} actualizado.`)
    } catch (err) {
      console.error(err)
      req.flash('error', err.message || 'Error al actualizar el método de pago.')
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
