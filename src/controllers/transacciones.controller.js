'use strict'
const TransaccionesModel = require('../models/transacciones.model')

const TIPOS = ['Venta Cantera', 'Venta Viaje', 'Alquiler', 'Maquinaria', 'Ajuste']
const POR_PAGINA = 20

const TransaccionesController = {
  index(req, res) {
    try {
      const { id, tipo, idCliente, cliente, fechaDesde, fechaHasta, montoMin, montoMax, mes, sortBy, sortDir } = req.query
      let fDesde = fechaDesde, fHasta = fechaHasta
      if (mes && /^\d{4}-\d{2}$/.test(mes)) {
        const [anio, mm] = mes.split('-').map(Number)
        const ultimo = new Date(anio, mm, 0).getDate()
        fDesde = `${mes}-01`; fHasta = `${mes}-${String(ultimo).padStart(2,'0')}`
      }

      const pagina = Math.max(1, Number(req.query.page) || 1)
      const resultado = TransaccionesModel.filtrar({
        id, tipo, clienteId: idCliente, cliente,
        fechaDesde: fDesde, fechaHasta: fHasta,
        montoMin, montoMax,
        page: pagina, limit: POR_PAGINA,
        sortBy: sortBy || 'created_at', sortDir: sortDir || 'DESC',
      })

      const filtros = {
        id: id||'', tipo: tipo||'', idCliente: idCliente||'', cliente: cliente||'',
        fechaDesde: fechaDesde||'', fechaHasta: fechaHasta||'', montoMin: montoMin||'',
        montoMax: montoMax||'', mes: mes||'', sortBy: sortBy||'created_at', sortDir: sortDir||'DESC',
      }

      res.render('pages/transacciones/index', {
        titulo: 'Transacciones',
        transacciones: resultado.rows,
        filtros,
        tipos: TIPOS,
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
