'use strict'
const path = require('path')
const fs   = require('fs')
const RemitosModel = require('../models/remitos.model')
const { generarRemitoPDF } = require('../utils/pdfRemito')
const { DIR_REMITOS } = require('../middlewares/upload')
const { query } = require('../config/db')

// Si el usuario es chofer, verificar que la op esté asignada a él.
// Devuelve true si tiene permiso, false si no.
async function choferTieneAcceso(req, opId) {
  if (req.session.user?.rol !== 'chofer') return true
  const emp = (await query(`SELECT id FROM empleados WHERE id_usuario = ? AND activo = 1`, [req.session.user.id])).rows[0]
  if (!emp) return false
  const op = (await query(`SELECT id_chofer FROM op_encabezado WHERE id = ?`, [opId])).rows[0]
  return op && op.id_chofer === emp.id
}

const RemitosController = {

  // Remito en PDF (server-side, pdfkit)
  async pdf(req, res) {
    try {
      if (!(await choferTieneAcceso(req, req.params.id))) {
        req.flash('error', 'No tenés permiso para ver este remito.')
        return res.redirect('/hoja-de-ruta')
      }
      const r = await RemitosModel.obtener(req.params.id)
      if (!r) { req.flash('error', 'Operación no encontrada.'); return res.redirect('back') }
      generarRemitoPDF(res, r)
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al generar el PDF del remito.')
      res.redirect('back')
    }
  },

  // Guardar remito firmado subido (multer ya guardó el archivo)
  async subirFirmado(req, res) {
    const r = await RemitosModel.obtener(req.params.id)
    const back = r ? RemitosModel.urlOperacion(r) : '/ventas'
    try {
      if (!req.file) { req.flash('error', 'No se recibió ningún archivo.'); return res.redirect(back) }
      // Si ya había uno, borrar el anterior
      if (r && r.archivo_remito) {
        const prev = path.join(DIR_REMITOS, r.archivo_remito)
        if (fs.existsSync(prev)) { try { fs.unlinkSync(prev) } catch (_) {} }
      }
      await RemitosModel.guardarArchivo(req.params.id, req.file.filename)
      req.flash('success', 'Remito firmado adjuntado correctamente.')
    } catch (err) {
      console.error(err)
      req.flash('error', err.message || 'Error al adjuntar el remito firmado.')
    }
    res.redirect(back)
  },

  // Ver / descargar el remito firmado (archivo fuera de /public → auth)
  async verFirmado(req, res) {
    try {
      if (!(await choferTieneAcceso(req, req.params.id))) {
        req.flash('error', 'No tenés permiso para ver este remito firmado.')
        return res.redirect('/hoja-de-ruta')
      }
      const r = await RemitosModel.obtener(req.params.id)
      if (!r || !r.archivo_remito) { req.flash('error', 'No hay remito firmado adjunto.'); return res.redirect('back') }
      const file = path.join(DIR_REMITOS, r.archivo_remito)
      if (!fs.existsSync(file)) { req.flash('error', 'El archivo no se encuentra.'); return res.redirect('back') }
      res.sendFile(file)
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al abrir el remito firmado.')
      res.redirect('back')
    }
  },

  // Servir la imagen de la firma digital del cliente (PNG)
  async verFirmaCliente(req, res) {
    try {
      if (!(await choferTieneAcceso(req, req.params.id))) return res.status(403).end()
      const r = await RemitosModel.obtener(req.params.id)
      if (!r || !r.firma_cliente) return res.status(404).end()
      const s = String(r.firma_cliente)
      if (s.startsWith('data:image')) {
        // Firma guardada en BD como dataURL base64 (formato actual)
        const m = /base64,(.+)$/.exec(s)
        if (!m) return res.status(404).end()
        res.set('Content-Type', 'image/png')
        return res.send(Buffer.from(m[1], 'base64'))
      }
      // Compatibilidad con firmas viejas en disco
      const file = path.join(DIR_REMITOS, s)
      if (!fs.existsSync(file)) return res.status(404).end()
      res.sendFile(file)
    } catch (err) {
      console.error(err); res.status(500).end()
    }
  },

  // Eliminar el remito firmado adjunto
  async eliminarFirmado(req, res) {
    const r = await RemitosModel.obtener(req.params.id)
    const back = r ? RemitosModel.urlOperacion(r) : '/ventas'
    try {
      if (r && r.archivo_remito) {
        const file = path.join(DIR_REMITOS, r.archivo_remito)
        if (fs.existsSync(file)) { try { fs.unlinkSync(file) } catch (_) {} }
        await RemitosModel.guardarArchivo(req.params.id, null)
        req.flash('success', 'Remito firmado eliminado.')
      }
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al eliminar el remito firmado.')
    }
    res.redirect(back)
  },
}

module.exports = RemitosController
