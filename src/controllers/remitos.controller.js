'use strict'
const RemitosModel = require('../models/remitos.model')
const { generarRemitoPDF } = require('../utils/pdfRemito')
const { nombreArchivo } = require('../middlewares/upload')
const storage = require('../config/storage')
const { query } = require('../config/db')

// Si el usuario es chofer, verificar que la op esté asignada a él.
// Devuelve true si tiene permiso, false si no.
async function choferTieneAcceso(req, opId) {
  if (req.session.user?.rol !== 'chofer') return true
  const emp = (await query(`SELECT id FROM empleados WHERE id_usuario = ? AND activo = 1`, [req.session.user.id])).rows[0]
  if (!emp) return false
  const op = (await query(`SELECT id_chofer FROM op_encabezado WHERE id = ?`, [opId])).rows[0]
  return op && Number(op.id_chofer) === Number(emp.id)
}

const RemitosController = {

  // Remito en PDF (server-side, pdfkit)
  async pdf(req, res) {
    try {
      if (!(await choferTieneAcceso(req, req.params.id))) {
        req.flash('error', 'No tenés permiso para ver este remito.')
        return res.redirect('/hoja-de-ruta')
      }
      let r = await RemitosModel.obtener(req.params.id)
      if (!r) { req.flash('error', 'Operación no encontrada.'); return res.redirect('back') }
      if (req.query.tipo === 'retiro') r = RemitosModel.vistaRetiro(r)
      generarRemitoPDF(res, r)
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al generar el PDF del remito.')
      res.redirect('back')
    }
  },

  // Guardar foto del remito subida (buffer en memoria → storage)
  async subirFirmado(req, res) {
    const r = await RemitosModel.obtener(req.params.id)
    const back = r ? RemitosModel.urlOperacion(r) : '/ventas'
    const tipo = req.query.tipo === 'retiro' ? 'retiro' : 'entrega'
    try {
      if (!req.file) { req.flash('error', 'No se recibió ningún archivo.'); return res.redirect(back) }
      const anterior = r ? (tipo === 'retiro' ? r.archivo_remito_retiro : r.archivo_remito) : null
      if (anterior) await storage.borrar(anterior) // borrar el anterior
      const filename = nombreArchivo(tipo === 'retiro' ? 'remito-retiro' : 'remito', req.params.id, req.file.originalname)
      await storage.guardar(req.file.buffer, filename, req.file.mimetype)
      await RemitosModel.guardarArchivo(req.params.id, filename, tipo)
      req.flash('success', 'Foto del remito adjuntada correctamente.')
    } catch (err) {
      console.error(err)
      req.flash('error', err.message || 'Error al adjuntar la foto del remito.')
    }
    res.redirect(back)
  },

  // Ver / descargar la foto del remito (auth)
  async verFirmado(req, res) {
    try {
      if (!(await choferTieneAcceso(req, req.params.id))) {
        req.flash('error', 'No tenés permiso para ver este remito.')
        return res.redirect('/hoja-de-ruta')
      }
      const r = await RemitosModel.obtener(req.params.id)
      const archivo = req.query.tipo === 'retiro' ? r?.archivo_remito_retiro : r?.archivo_remito
      if (!r || !archivo) { req.flash('error', 'No hay foto del remito adjunta.'); return res.redirect('back') }
      const buf = await storage.leer(archivo)
      if (!buf) { req.flash('error', 'El archivo no se encuentra.'); return res.redirect('back') }
      const ext = (archivo.split('.').pop() || '').toLowerCase()
      const mime = ext === 'pdf' ? 'application/pdf' : ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
      res.set('Content-Type', mime)
      res.send(buf)
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al abrir la foto del remito.')
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
      // Compatibilidad con firmas viejas guardadas como archivo
      const buf = await storage.leer(s)
      if (!buf) return res.status(404).end()
      res.set('Content-Type', 'image/png')
      res.send(buf)
    } catch (err) {
      console.error(err); res.status(500).end()
    }
  },

  // Eliminar el remito firmado adjunto
  async eliminarFirmado(req, res) {
    const r = await RemitosModel.obtener(req.params.id)
    const back = r ? RemitosModel.urlOperacion(r) : '/ventas'
    const tipo = req.query.tipo === 'retiro' ? 'retiro' : 'entrega'
    try {
      const archivo = tipo === 'retiro' ? r?.archivo_remito_retiro : r?.archivo_remito
      if (r && archivo) {
        await storage.borrar(archivo)
        await RemitosModel.guardarArchivo(req.params.id, null, tipo)
        req.flash('success', 'Foto del remito eliminada.')
      }
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al eliminar el remito firmado.')
    }
    res.redirect(back)
  },
}

module.exports = RemitosController
