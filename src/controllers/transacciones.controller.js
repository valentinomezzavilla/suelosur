'use strict'
const TransaccionesModel = require('../models/transacciones.model')
const ClientesModel = require('../models/clientes.model')
const { resolverPeriodo, etiquetaPeriodo } = require('../utils/periodos')

const TIPOS = ['Venta Cantera', 'Venta Viaje', 'Alquiler', 'Maquinaria', 'Ajuste']
const POR_PAGINA = 20

const TransaccionesController = {
  async index(req, res) {
    try {
      const { id, tipo, idCliente, cliente, fechaDesde, fechaHasta, montoMin, montoMax, mes, preset, sortBy, sortDir } = req.query

      // Período: presets (hoy/semana/mes/rango). Default = mes en curso.
      const periodo = resolverPeriodo({ preset, desde: fechaDesde, hasta: fechaHasta, mes })

      const baseFiltros = {
        id, tipo, clienteId: idCliente, cliente,
        fechaDesde: periodo.desde, fechaHasta: periodo.hasta,
        montoMin, montoMax,
      }

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
}

module.exports = TransaccionesController
