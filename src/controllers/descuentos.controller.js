'use strict'
// Descuentos a clientes (modales de Liquidaciones y Cuenta corriente). Ver
// docs/superpowers/specs/2026-11-19-descuentos-design.md
const DescuentosModel = require('../models/descuentos.model')
const { normalizarFiltros } = require('../utils/liquidaciones')
const { hoyISO } = require('../utils/fecha')
const { registrarAuditoria } = require('../utils/auditoria')
const { pesos } = require('../utils/descuentos')

const idValido = (v) => /^\d+$/.test(String(v || '').trim()) ? String(v).trim() : null
// Filtros de la pantalla desde donde se abrió el modal (la query string de la página)
function filtrosDe(qs, clienteId) {
  const p = new URLSearchParams(String(qs || '').replace(/^\?/, ''))
  const q = {}
  for (const k of new Set(p.keys())) { const vs = p.getAll(k); q[k] = vs.length > 1 ? vs : vs[0] }
  return normalizarFiltros({ ...q, clienteId: String(clienteId) }, hoyISO())
}
// Volver a la pantalla de donde vino (solo rutas internas)
const volver = (req) => {
  const v = String(req.body.volver || '')
  return /^\/(liquidaciones|clientes\/cuentas\/\d+)(\?|$)/.test(v) ? v : (req.get('Referer') || '/liquidaciones')
}

const DescuentosController = {
  async opciones(req, res) {
    const clienteId = idValido(req.query.clienteId)
    if (!clienteId) return res.status(400).json({ error: 'Falta el cliente.' })
    try {
      res.json(await DescuentosModel.opciones(clienteId, filtrosDe(req.query.filtros, clienteId)))
    } catch (err) {
      console.error(err); res.status(500).json({ error: 'No se pudieron cargar las operaciones del cliente.' })
    }
  },

  async vistaPrevia(req, res) {
    const clienteId = idValido(req.body.clienteId)
    if (!clienteId) return res.status(400).json({ error: 'Falta el cliente.' })
    try {
      res.json(await DescuentosModel.vistaPrevia(clienteId, req.body, filtrosDe(req.body.filtros, clienteId)))
    } catch (err) {
      // Los errores de validación / reparto son mensajes para la pantalla
      res.status(422).json({ error: err.message || 'No se pudo calcular el descuento.' })
    }
  },

  async crear(req, res) {
    const back = volver(req)
    const clienteId = idValido(req.body.clienteId)
    if (!clienteId) { req.flash('error', 'Falta el cliente.'); return res.redirect(back) }
    try {
      const totalEsperado = req.body.totalEsperado !== undefined && req.body.totalEsperado !== '' ? Number(req.body.totalEsperado) : null
      const r = await DescuentosModel.aplicar(clienteId, req.body, filtrosDe(req.body.filtros, clienteId),
        { usuario: req.session.user?.id, motivo: req.body.motivo, totalEsperado })
      await registrarAuditoria({ entidad_tipo: 'descuento', entidad_id: r.id, accion: 'crear', usuario: req.session.user?.id,
        detalle: { cliente_id: clienteId, tipo: req.body.tipo, valor: req.body.valor, alcance: req.body.alcance, referencia: req.body.referencia || null, total: r.total } })
      req.flash('success', `Descuento de ${pesos(r.total)} aplicado (${r.etiqueta} · ${r.alcanceTexto}). El saldo del cliente se actualizó.`)
    } catch (err) {
      console.error(err); req.flash('error', err.message || 'No se pudo aplicar el descuento.')
    }
    res.redirect(back)
  },

  async delCliente(req, res) {
    const clienteId = idValido(req.params.id)
    if (!clienteId) return res.status(400).json({ error: 'Cliente inválido.' })
    try {
      res.json({ descuentos: await DescuentosModel.delCliente(clienteId) })
    } catch (err) {
      console.error(err); res.status(500).json({ error: 'No se pudieron cargar los descuentos.' })
    }
  },

  async revertir(req, res) {
    const back = volver(req)
    const clienteId = idValido(req.body.clienteId)
    const id = idValido(req.params.id)
    if (!clienteId || !id) { req.flash('error', 'Descuento inválido.'); return res.redirect(back) }
    try {
      const motivo = String(req.body.motivo || '').trim().slice(0, 300)
      const d = await DescuentosModel.revertir(id, clienteId, { usuario: req.session.user?.id, motivo })
      await registrarAuditoria({ entidad_tipo: 'descuento', entidad_id: id, accion: 'revertir', usuario: req.session.user?.id,
        detalle: { cliente_id: clienteId, total: d.total, motivo } })
      req.flash('success', `Descuento de ${pesos(d.total)} revertido. Las operaciones vuelven a deber lo descontado.`)
    } catch (err) {
      console.error(err); req.flash('error', err.message || 'No se pudo revertir el descuento.')
    }
    res.redirect(back)
  },
}

module.exports = DescuentosController
