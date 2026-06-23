'use strict'
const path = require('path')
const fs   = require('fs')
const RemitosModel = require('../models/remitos.model')
const { generarRemitoPDF } = require('../utils/pdfRemito')
const { DIR_REMITOS } = require('../middlewares/upload')

const RemitosController = {

  // Remito en PDF (server-side, pdfkit)
  pdf(req, res) {
    try {
      const r = RemitosModel.obtener(req.params.id)
      if (!r) { req.flash('error', 'Operación no encontrada.'); return res.redirect('/ventas') }
      generarRemitoPDF(res, r)
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al generar el PDF del remito.')
      res.redirect('back')
    }
  },

  // Guardar remito firmado subido (multer ya guardó el archivo)
  subirFirmado(req, res) {
    const r = RemitosModel.obtener(req.params.id)
    const back = r ? RemitosModel.urlOperacion(r) : '/ventas'
    try {
      if (!req.file) { req.flash('error', 'No se recibió ningún archivo.'); return res.redirect(back) }
      // Si ya había uno, borrar el anterior
      if (r && r.archivo_remito) {
        const prev = path.join(DIR_REMITOS, r.archivo_remito)
        if (fs.existsSync(prev)) { try { fs.unlinkSync(prev) } catch (_) {} }
      }
      RemitosModel.guardarArchivo(req.params.id, req.file.filename)
      req.flash('success', 'Remito firmado adjuntado correctamente.')
    } catch (err) {
      console.error(err)
      req.flash('error', err.message || 'Error al adjuntar el remito firmado.')
    }
    res.redirect(back)
  },

  // Ver / descargar el remito firmado (archivo fuera de /public → auth)
  verFirmado(req, res) {
    try {
      const r = RemitosModel.obtener(req.params.id)
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

  // Eliminar el remito firmado adjunto
  eliminarFirmado(req, res) {
    const r = RemitosModel.obtener(req.params.id)
    const back = r ? RemitosModel.urlOperacion(r) : '/ventas'
    try {
      if (r && r.archivo_remito) {
        const file = path.join(DIR_REMITOS, r.archivo_remito)
        if (fs.existsSync(file)) { try { fs.unlinkSync(file) } catch (_) {} }
        RemitosModel.guardarArchivo(req.params.id, null)
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
