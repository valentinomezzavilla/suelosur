'use strict'
const FacturacionModel  = require('../models/facturacion.model')
const ConfigFacturacion = require('../models/config_facturacion.model')
const ClientesModel     = require('../models/clientes.model')
const Afip              = require('../services/afip.service')
const { registrarAuditoria } = require('../utils/auditoria')
const { fmtFecha } = require('../utils/fecha')

const ENTIDAD = 'operacion'
const volver = (tab, extra = '') => `/facturacion?tab=${tab}${extra}`
const RUTA_CONFIG = '/facturacion/configuracion'
const hoyISO = () => new Date().toISOString().slice(0, 10)
const fechaValida = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : hoyISO()
const errorUsuario = (msg) => Object.assign(new Error(msg), { usuario: true })
const nroOp = (n) => 'OP-' + String(n).padStart(4, '0')

// Solo se permite volver a rutas internas del sistema
const destinoSeguro = (v, porDefecto) => {
  const s = String(v || '')
  return s.startsWith('/') && !s.startsWith('//') ? s : porDefecto
}

const leerFiltros = (q) => ({
  q:     q.q || '',
  tipo:  FacturacionModel.TIPOS[q.tipo] ? q.tipo : '',
  desde: q.desde || '',
  hasta: q.hasta || '',
  nc:    q.nc === '1' ? '1' : '',
})

const mensajeError = (err, porDefecto) => {
  if (err.usuario || /^AFIP/.test(err.message)) return err.message
  console.error(err)
  return porDefecto
}

module.exports = {
  async index(req, res) {
    try {
      const tab = req.query.tab === 'facturado' ? 'facturado' : 'pendiente'
      const filtros = leerFiltros(req.query)
      const cfg     = await ConfigFacturacion.obtener()
      const rows    = await FacturacionModel.todos()
      const resumen = FacturacionModel.resumen(rows)
      const lista   = FacturacionModel.filtrar(rows, { estado: tab, ...filtros })
      res.render('pages/facturacion/index', {
        titulo: 'Facturación',
        tab, filtros, lista, resumen,
        tipos: FacturacionModel.TIPOS,
        condiciones: FacturacionModel.CONDICIONES_IVA,
        alicuotas: FacturacionModel.ALICUOTAS,
        empresaCondicion: cfg.condicion_iva,
        afipHabilitado: await Afip.habilitado(),
        afipEntorno: cfg.entorno,
        hoy: hoyISO(),
        scripts: ['/js/facturacion.js'],
      })
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al cargar Facturación.')
      res.redirect('/')
    }
  },

  async facturar(req, res) {
    const ids = [].concat(req.body.op_ids || [])
      .flatMap(v => String(v).split(','))
      .map(v => parseInt(v, 10))
      .filter(Boolean)
    try {
      if (!ids.length) throw errorUsuario('Seleccioná al menos una operación.')
      const rows = await FacturacionModel.todos()
      const sel  = rows.filter(r => ids.includes(Number(r.id)))
      if (sel.length !== ids.length || sel.some(r => r.facturado || r.anulada)) {
        throw errorUsuario('Alguna operación ya no está pendiente de facturar. Actualizá la página.')
      }
      if (new Set(sel.map(r => r.cliente_id)).size > 1) {
        throw errorUsuario('Solo se pueden facturar juntas operaciones del mismo cliente.')
      }
      const cli = sel[0]

      const condicion = FacturacionModel.CONDICIONES_IVA[req.body.condicion_iva] ? req.body.condicion_iva : (cli.condicion_iva || 'CF')
      const cuit  = String(req.body.cuit || '').replace(/\D/g, '')
      const razon = String(req.body.razon_social || '').trim()
      const empresa = (await ConfigFacturacion.obtener()).condicion_iva
      const tipo = ['A', 'B', 'C'].includes(req.body.tipo_comprobante)
        ? req.body.tipo_comprobante : FacturacionModel.tipoSugerido(condicion, empresa)

      if (empresa === 'MT' && tipo !== 'C') throw errorUsuario('La empresa está configurada como monotributista: solo puede emitir factura C.')
      if (empresa === 'RI' && tipo === 'C') throw errorUsuario('La factura C es solo para emisores monotributistas. Elegí A o B.')
      if (cuit && !FacturacionModel.cuitValido(cuit)) throw errorUsuario('El CUIT ingresado no es válido.')
      if (tipo === 'A' && !cuit) throw errorUsuario('La factura A requiere el CUIT del cliente.')

      const alicuota = tipo === 'C' ? 0
        : (FacturacionModel.ALICUOTAS.includes(Number(req.body.alicuota)) ? Number(req.body.alicuota) : 21)
      const total = FacturacionModel.redondear(sel.reduce((a, r) => a + r.monto, 0))
      const { neto, iva } = FacturacionModel.desglose(total, tipo, alicuota)
      const fecha = fechaValida(req.body.fecha)

      // Los datos fiscales cargados al facturar quedan guardados en la ficha del cliente
      await ClientesModel.actualizar(cli.cliente_id, { cuit: cuit || null, razon_social: razon || null, condicion_iva: condicion })

      let emision = { origen: 'manual', numero: String(req.body.numero || '').trim() }
      if (req.body.modo === 'afip') {
        if (!(await Afip.habilitado())) throw errorUsuario('La facturación electrónica con AFIP no está configurada.')
        const doc = FacturacionModel.documentoReceptor({ cuit, dni: cli.dni })
        const r = await Afip.emitir({
          tipoLetra: tipo, concepto: FacturacionModel.conceptoAfip(sel),
          docTipo: doc.tipo, docNro: doc.nro, condicionIva: condicion,
          total, neto, iva, alicuota, fecha,
        })
        emision = { origen: 'afip', ...r }
      } else if (!emision.numero) {
        throw errorUsuario('Ingresá el N° de comprobante.')
      }

      try {
        await FacturacionModel.facturar({
          opIds: ids, clienteId: cli.cliente_id, tipo, ...emision, fecha, alicuota, neto, iva, total,
          receptor: { nombre: razon || cli.cliente, cuit: cuit || null, condicion },
          usuario: req.session.user.id,
        })
      } catch (err) {
        // Si AFIP ya otorgó el CAE, el comprobante existe aunque no se haya podido guardar: avisar para no perderlo.
        if (emision.origen === 'afip') {
          console.error('FACTURA AFIP EMITIDA SIN REGISTRAR', { ids, ...emision, err: err.message })
          throw errorUsuario(`AFIP emitió la factura ${tipo} ${emision.numero} (CAE ${emision.cae}) pero no se pudo guardar en el sistema: ${err.message}. Registrala manualmente con ese número.`)
        }
        throw err
      }

      for (const r of sel) {
        await registrarAuditoria({
          entidad_tipo: ENTIDAD, entidad_id: r.id, accion: 'facturar', usuario: req.session.user.id,
          detalle: { comprobante: `${tipo} ${emision.numero}`, origen: emision.origen, cae: emision.cae || null, total },
        })
      }
      const cantidad = ids.length === 1 ? '1 operación' : `${ids.length} operaciones`
      req.flash('success', `Factura ${tipo} ${emision.numero} registrada (${cantidad})${emision.cae ? ` · CAE ${emision.cae}` : ''}.`)
    } catch (err) {
      req.flash('error', mensajeError(err, 'Error al registrar la factura.'))
    }
    res.redirect(volver('pendiente'))
  },

  async revertir(req, res) {
    try {
      const afectadas = await FacturacionModel.revertir(req.params.id)
      for (const id of afectadas) {
        await registrarAuditoria({ entidad_tipo: ENTIDAD, entidad_id: id, accion: 'revertir_factura', usuario: req.session.user.id })
      }
      req.flash('success', afectadas.length > 1
        ? `Factura revertida: ${afectadas.length} operaciones volvieron a Pendiente Facturar.`
        : 'La operación volvió a Pendiente Facturar.')
    } catch (err) {
      req.flash('error', mensajeError(err, 'Error al revertir la factura.'))
    }
    res.redirect(volver('facturado'))
  },

  async marcar(req, res) {
    try {
      await FacturacionModel.marcar(req.params.id)
      await registrarAuditoria({ entidad_tipo: ENTIDAD, entidad_id: req.params.id, accion: 'marcar_facturar', usuario: req.session.user.id })
      req.flash('success', 'La operación quedó marcada para facturar.')
    } catch (err) {
      req.flash('error', mensajeError(err, 'Error al marcar la operación.'))
    }
    res.redirect(destinoSeguro(req.body.volver, volver('pendiente')))
  },

  async quitar(req, res) {
    try {
      await FacturacionModel.quitar(req.params.id)
      await registrarAuditoria({ entidad_tipo: ENTIDAD, entidad_id: req.params.id, accion: 'quitar_facturar', usuario: req.session.user.id })
      req.flash('success', 'La operación se quitó de la lista para facturar.')
    } catch (err) {
      req.flash('error', mensajeError(err, 'Error al quitar la operación.'))
    }
    res.redirect(destinoSeguro(req.body.volver, volver('pendiente')))
  },

  async notaCredito(req, res) {
    try {
      const op = await FacturacionModel.estadoOp(req.params.id)
      if (!op || !op.requiereNC) throw errorUsuario('Esta operación no requiere nota de crédito.')
      const fecha = fechaValida(req.body.fecha)
      let numero = String(req.body.numero || '').trim()
      let cae = null
      if (req.body.modo === 'afip') {
        if (op.factura_origen !== 'afip') throw errorUsuario('La factura original no se emitió con AFIP: registrá la nota de crédito manualmente.')
        if (!(await Afip.habilitado())) throw errorUsuario('La facturación electrónica con AFIP no está configurada.')
        const alicuota = Number(op.alicuota_iva) || 0
        const { neto, iva } = FacturacionModel.desglose(op.monto, op.tipo_comprobante, alicuota)
        const doc = FacturacionModel.documentoReceptor({ cuit: op.cuit, dni: op.dni })
        const r = await Afip.emitir({
          tipoLetra: op.tipo_comprobante, notaCredito: true, concepto: FacturacionModel.conceptoAfip([op]),
          docTipo: doc.tipo, docNro: doc.nro, condicionIva: op.condicion_iva || 'CF',
          total: op.monto, neto, iva, alicuota, fecha,
          asociado: { tipoLetra: op.tipo_comprobante, ptoVta: op.punto_venta, nro: op.nro_cbte, fecha: op.factura_fecha },
        })
        numero = r.numero
        cae = r.cae
      } else if (!numero) {
        throw errorUsuario('Ingresá el N° de la nota de crédito.')
      }
      await FacturacionModel.registrarNC(op.id, { numero, fecha, cae })
      await registrarAuditoria({
        entidad_tipo: ENTIDAD, entidad_id: op.id, accion: 'nota_credito', usuario: req.session.user.id,
        detalle: { numero, cae, factura: op.comprobante },
      })
      req.flash('success', `Nota de crédito ${numero} registrada para ${nroOp(op.nro_op)}${cae ? ` · CAE ${cae}` : ''}.`)
    } catch (err) {
      req.flash('error', mensajeError(err, 'Error al registrar la nota de crédito.'))
    }
    res.redirect(volver('facturado'))
  },

  async exportar(req, res) {
    try {
      const formato = req.params.formato === 'pdf' ? 'pdf' : 'excel'
      const tab = req.query.tab === 'facturado' ? 'facturado' : 'pendiente'
      const filtros = leerFiltros(req.query)
      const lista = FacturacionModel.filtrar(await FacturacionModel.todos(), { estado: tab, ...filtros })
      const esFact = tab === 'facturado'
      const titulo = esFact ? 'Operaciones facturadas' : 'Operaciones pendientes de facturar'
      const estadoFact = (r) => r.requiereNC ? 'Anulada — requiere NC' : (r.nc_numero ? `Anulada — NC ${r.nc_numero}` : 'Vigente')

      const columnas = esFact
        ? [
            { header: 'OP', key: 'op', width: 10 },
            { header: 'Comprobante', key: 'comprobante', width: 20 },
            { header: 'Fecha', key: 'fecha', width: 12 },
            { header: 'Cliente', key: 'cliente', width: 28 },
            { header: 'CUIT', key: 'cuit', width: 14 },
            { header: 'Tipo', key: 'tipo', width: 18 },
            { header: 'Neto', key: 'neto', width: 14, money: true, align: 'right' },
            { header: 'IVA', key: 'iva', width: 12, money: true, align: 'right' },
            { header: 'Total', key: 'total', width: 14, money: true, align: 'right' },
            { header: 'CAE', key: 'cae', width: 16 },
            { header: 'Estado', key: 'estado', width: 20 },
          ]
        : [
            { header: 'OP', key: 'op', width: 10 },
            { header: 'Fecha', key: 'fecha', width: 12 },
            { header: 'Cliente', key: 'cliente', width: 28 },
            { header: 'DNI / CUIT', key: 'cuit', width: 14 },
            { header: 'Tipo', key: 'tipo', width: 18 },
            { header: 'Estado', key: 'estado', width: 12 },
            { header: 'Días', key: 'dias', width: 8, align: 'right' },
            { header: 'Monto', key: 'total', width: 14, money: true, align: 'right' },
          ]
      const filas = lista.map(r => ({
        op: nroOp(r.nro_op),
        comprobante: r.comprobante,
        fecha: fmtFecha(esFact ? r.fecha_factura : r.fecha_emision),
        cliente: r.razon_social || r.cliente,
        cuit: r.cuit || r.dni || '',
        tipo: r.tipo_label,
        neto: r.neto, iva: r.iva, total: r.monto,
        cae: r.cae || '',
        estado: esFact ? estadoFact(r) : r.estado,
        dias: r.dias,
      }))
      const sum = (k) => FacturacionModel.redondear(filas.reduce((a, f) => a + (Number(f[k]) || 0), 0))
      filas.push(esFact
        ? { cliente: 'TOTAL', neto: sum('neto'), iva: sum('iva'), total: sum('total') }
        : { cliente: 'TOTAL', total: sum('total') })

      const nombreArchivo = `facturacion-${tab}-${hoyISO()}`
      if (formato === 'pdf') {
        const { generarTablaPDF } = require('../utils/pdfTabla')
        const pdfCols = columnas.map(c => ({ ...c, width: undefined }))
        return generarTablaPDF(res, { titulo, subtitulo: `${lista.length} operación(es) · ${fmtFecha(hoyISO())}`, columnas: pdfCols, filas, nombreArchivo })
      }
      const { generarExcel } = require('../utils/excel')
      return generarExcel(res, { titulo, columnas, filas, nombreArchivo })
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al exportar.')
      res.redirect(volver('pendiente'))
    }
  },

  // ── Configuración de facturación (solo Dueño) ──────────────────
  async configuracion(req, res) {
    try {
      res.render('pages/facturacion/configuracion', {
        titulo: 'Configuración de facturación',
        estado: await ConfigFacturacion.estado(),
        condicionesEmpresa: ConfigFacturacion.CONDICIONES_EMPRESA,
      })
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al cargar la configuración.')
      res.redirect('/facturacion')
    }
  },

  async guardarConfiguracion(req, res) {
    try {
      const b = req.body
      const actual = await ConfigFacturacion.obtener()
      const cuit = String(b.cuit || '').replace(/\D/g, '')
      if (cuit && !FacturacionModel.cuitValido(cuit)) throw errorUsuario('El CUIT de la empresa no es válido.')
      const pto = b.pto_vta ? parseInt(b.pto_vta, 10) : null
      if (b.pto_vta && !(pto >= 1 && pto <= 99998)) throw errorUsuario('El punto de venta debe ser un número entre 1 y 99998.')
      const condicion = b.condicion_iva === 'MT' ? 'MT' : 'RI'
      const entorno = b.entorno === 'produccion' ? 'produccion' : 'homologacion'
      const quitar = b.quitar_credenciales === '1'

      const certIn = req.files?.cert_file?.[0]?.buffer || String(b.cert_texto || '').trim()
      const keyIn  = req.files?.key_file?.[0]?.buffer || String(b.key_texto || '').trim()
      const certPem = !quitar && certIn.length ? ConfigFacturacion.leerCertificado(certIn) : null
      const keyPem  = !quitar && keyIn.length ? ConfigFacturacion.leerClave(keyIn) : null

      if (!quitar) {
        const certFinal = certPem || actual.cert
        const keyFinal = keyPem || actual.key
        if (certFinal && keyFinal && !ConfigFacturacion.coinciden(certFinal, keyFinal)) {
          throw errorUsuario('La clave privada no corresponde al certificado. Subí el par que generaste junto.')
        }
      }

      const { huella } = await ConfigFacturacion.guardar({
        cuit, condicion_iva: condicion, pto_vta: pto, entorno, certPem, keyPem, quitarCredenciales: quitar,
      }, req.session.user.id)

      // El ticket de AFIP está atado al certificado, al CUIT y al entorno
      if (quitar || cuit !== (actual.cuit || '') || entorno !== actual.entorno || (huella && huella !== actual.cert_huella)) {
        await Afip.invalidarTA()
      }

      await registrarAuditoria({
        entidad_tipo: 'config_facturacion', entidad_id: 1, accion: 'modificar', usuario: req.session.user.id,
        detalle: { cuit, pto_vta: pto, entorno, condicion_iva: condicion, certificado: !!certPem, clave: !!keyPem, quitar },
      })

      if (certPem) {
        const info = ConfigFacturacion.infoCertificado(certPem)
        if (info?.vencido) req.flash('warning', `El certificado venció el ${fmtFecha(info.hasta)}. Generá uno nuevo en AFIP.`)
        if (info?.cuit && cuit && info.cuit !== cuit) req.flash('warning', `El certificado es del CUIT ${info.cuit} y el CUIT cargado es ${cuit}.`)
      }
      req.flash('success', quitar ? 'Se borraron el certificado y la clave privada.' : 'Configuración de facturación guardada.')
    } catch (err) {
      req.flash('error', mensajeError(err, 'Error al guardar la configuración.'))
    }
    res.redirect(RUTA_CONFIG)
  },

  async probarConexion(req, res) {
    try {
      const r = await Afip.probarConexion()
      req.flash('success', `Conexión con AFIP correcta (${r.entorno === 'produccion' ? 'producción' : 'homologación'}). `
        + `Último comprobante ${r.letra} del punto de venta ${r.ptoVta}: N° ${r.ultimo}.`)
    } catch (err) {
      req.flash('error', err.usuario || /^AFIP|Completá/.test(err.message) ? err.message : `No se pudo probar la conexión: ${err.message}`)
    }
    res.redirect(RUTA_CONFIG)
  },
}
