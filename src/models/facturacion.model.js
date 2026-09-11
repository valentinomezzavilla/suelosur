'use strict'
const { query, transaction } = require('../config/db')

const TIPOS = {
  cantera:    'Venta cantera',
  viaje:      'Venta viaje',
  contenedor: 'Alquiler contenedor',
  maquinaria: 'Alquiler maquinaria',
}

const CONDICIONES_IVA = {
  RI: 'Responsable Inscripto',
  MT: 'Monotributista',
  EX: 'Exento',
  CF: 'Consumidor final',
}

const ALICUOTAS = [21, 10.5, 27, 0]

const MESES       = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic']
const MESES_LARGO = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']

const esVerdadero = (v) => v === true || v === 1 || ['1', 'on', 'true'].includes(String(v))
const hoyISO = () => new Date().toISOString().slice(0, 10)
const redondear = (n) => Math.round((Number(n) || 0) * 100) / 100
const tipoDe = (op) => op.tipo_op === 'C' ? 'contenedor'
  : op.tipo_op === 'MA' ? 'maquinaria'
  : (op.modalidad === 'flete' ? 'viaje' : 'cantera')

// RI factura A a inscriptos y monotributistas (RG 5003) y B al resto; un monotributista siempre C.
const tipoSugerido = (condCliente, empresa = 'RI') => empresa === 'MT' ? 'C'
  : (['RI', 'MT'].includes(condCliente) ? 'A' : 'B')

// Los montos de las operaciones son finales (IVA incluido).
function desglose(total, tipo, alicuota) {
  const t = redondear(total)
  if (tipo === 'C' || !Number(alicuota)) return { neto: t, iva: 0 }
  const neto = redondear(t / (1 + Number(alicuota) / 100))
  return { neto, iva: redondear(t - neto) }
}

function cuitValido(valor) {
  const d = String(valor || '').replace(/\D/g, '')
  if (d.length !== 11) return false
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  const suma = pesos.reduce((a, p, i) => a + p * Number(d[i]), 0)
  let dv = 11 - (suma % 11)
  if (dv === 11) dv = 0
  if (dv === 10) return false
  return dv === Number(d[10])
}

// Documento del receptor para AFIP: 80 = CUIT, 96 = DNI, 99 = sin identificar
function documentoReceptor({ cuit, dni }) {
  if (cuitValido(cuit)) return { tipo: 80, nro: String(cuit).replace(/\D/g, '') }
  const d = String(dni || '').replace(/\D/g, '')
  if (d.length >= 7 && d.length <= 8) return { tipo: 96, nro: d }
  return { tipo: 99, nro: '0' }
}

// Concepto AFIP: 1 = productos (áridos), 2 = servicios (alquileres), 3 = ambos
function conceptoAfip(ops) {
  const prod = ops.some(o => o.tipo === 'cantera' || o.tipo === 'viaje')
  const serv = ops.some(o => o.tipo === 'contenedor' || o.tipo === 'maquinaria')
  return prod && serv ? 3 : serv ? 2 : 1
}

// Monto: lo cobrado (transacciones) si ya existe; si no, el total cargado al crear;
// si no, lo estimado desde el detalle de la operación.
const selectBase = (where) => `
  SELECT op.id, op.nro_op, op.tipo_op, op.modalidad, op.estado, op.metodo_pago, op.fecha_emision,
         op.para_facturar, op.facturado, op.nro_factura, op.fecha_factura, op.facturado_en, op.factura_id,
         op.nc_numero, op.nc_fecha, op.nc_cae,
         cli.id AS cliente_id, cli.dni, cli.cuit, cli.razon_social, cli.condicion_iva,
         TRIM(cli.nombre || ' ' || COALESCE(cli.apellido, '')) AS cliente,
         COALESCE(tx.monto, op.monto_facturar, mat.monto, dc.precio, dm.precio, 0) AS monto,
         f.tipo_comprobante, f.alicuota_iva, f.origen AS factura_origen, f.cae, f.cae_vto,
         f.punto_venta, f.nro_cbte, f.fecha AS factura_fecha,
         u.nombre AS facturado_por_nombre
  FROM op_encabezado op
  JOIN clientes cli ON cli.id = op.id_cliente
  LEFT JOIN (SELECT id_op_encabezado, SUM(monto) AS monto FROM transacciones GROUP BY id_op_encabezado) tx
         ON tx.id_op_encabezado = op.id
  LEFT JOIN (SELECT id_orden_pedido, SUM(cantidad_pedida * precio_unitario) AS monto FROM op_detalle_material GROUP BY id_orden_pedido) mat
         ON mat.id_orden_pedido = op.id
  LEFT JOIN (SELECT id_orden_pedido, MAX(precio_alquiler) AS precio FROM op_detalle_contenedor GROUP BY id_orden_pedido) dc
         ON dc.id_orden_pedido = op.id
  LEFT JOIN (SELECT id_orden_pedido, MAX(precio_total) AS precio FROM op_detalle_maquinaria GROUP BY id_orden_pedido) dm
         ON dm.id_orden_pedido = op.id
  LEFT JOIN facturas f ON f.id = op.factura_id
  LEFT JOIN users u ON u.id = op.facturado_por
  WHERE ${where}
  ORDER BY COALESCE(op.fecha_factura, op.fecha_emision) DESC, op.id DESC
`

function mapear(r, hoy) {
  const tipo = tipoDe(r)
  const facturado = Number(r.facturado) === 1
  const anulada = r.estado === 'anulado'
  const monto = Number(r.monto) || 0
  const emision = String(r.fecha_emision || '').slice(0, 10)
  const { neto, iva } = facturado
    ? desglose(monto, r.tipo_comprobante, Number(r.alicuota_iva) || 0)
    : { neto: null, iva: null }
  return {
    ...r,
    tipo,
    tipo_label: TIPOS[tipo],
    para_facturar: Number(r.para_facturar) === 1,
    facturado,
    anulada,
    monto,
    neto,
    iva,
    comprobante: r.nro_factura ? `${r.tipo_comprobante ? r.tipo_comprobante + ' ' : ''}${r.nro_factura}` : null,
    requiereNC: anulada && facturado && !r.nc_numero,
    condicion_iva_label: CONDICIONES_IVA[r.condicion_iva] || null,
    dias: emision ? Math.floor((Date.parse(hoy) - Date.parse(emision)) / 86400000) : 0,
  }
}

const errorUsuario = (msg) => Object.assign(new Error(msg), { usuario: true })

module.exports = {
  TIPOS, CONDICIONES_IVA, ALICUOTAS,
  tipoSugerido, desglose, cuitValido, documentoReceptor, conceptoAfip, redondear,

  // Se llama al crear cualquier venta/alquiler: marca la OP si se tildó "Operación para Facturar".
  async marcarAlCrear(id_op, flag, monto) {
    if (!id_op || !esVerdadero(flag)) return
    await query(`UPDATE op_encabezado SET para_facturar = 1, monto_facturar = ? WHERE id = ?`,
      [Number(monto) || 0, id_op])
  },

  // Marcar una OP ya existente (desde su detalle)
  async marcar(id) {
    await query(`UPDATE op_encabezado SET para_facturar = 1 WHERE id = ? AND estado <> 'anulado'`, [id])
  },

  // Saca una OP pendiente de la lista (tildada por error). Las ya facturadas no se tocan.
  async quitar(id) {
    await query(`UPDATE op_encabezado SET para_facturar = 0 WHERE id = ? AND COALESCE(facturado, 0) = 0`, [id])
  },

  // Todas las OP para facturar; las anuladas solo si ya estaban facturadas (necesitan nota de crédito).
  async todos() {
    const hoy = hoyISO()
    const { rows } = await query(selectBase(
      `op.para_facturar = 1 AND (op.estado <> 'anulado' OR COALESCE(op.facturado, 0) = 1)`))
    return rows.map(r => mapear(r, hoy))
  },

  async estadoOp(id) {
    const { rows } = await query(selectBase('op.id = ?'), [id])
    return rows[0] ? mapear(rows[0], hoyISO()) : null
  },

  filtrar(rows, { estado, q, tipo, desde, hasta, nc }) {
    const facturado = estado === 'facturado'
    const texto = String(q || '').trim().toLowerCase()
    return rows.filter(r => {
      if (facturado ? !r.facturado : (r.facturado || r.anulada)) return false
      if (facturado && nc && !r.requiereNC) return false
      if (tipo && r.tipo !== tipo) return false
      const fecha = String((facturado ? r.fecha_factura : r.fecha_emision) || '').slice(0, 10)
      if (desde && fecha < desde) return false
      if (hasta && fecha > hasta) return false
      if (texto) {
        const nroOp = 'op-' + String(r.nro_op).padStart(4, '0')
        const hay = [r.cliente, r.razon_social, nroOp, String(r.nro_op), r.nro_factura, r.dni, r.cuit, r.cae]
          .some(v => String(v || '').toLowerCase().includes(texto))
        if (!hay) return false
      }
      return true
    })
  },

  resumen(rows) {
    const hoy  = hoyISO()
    const mes  = hoy.slice(0, 7)
    const anio = hoy.slice(0, 4)
    const suma = (lista) => ({ count: lista.length, total: redondear(lista.reduce((a, r) => a + r.monto, 0)) })
    const pend = rows.filter(r => !r.facturado && !r.anulada)
    // Lo acreditado con nota de crédito ya no cuenta como facturado.
    const fact = rows.filter(r => r.facturado && !r.nc_numero)
    const mesDe = (r) => String(r.fecha_factura || '').slice(0, 7)

    const [y, m] = hoy.split('-').map(Number)
    const porMes = []
    for (let i = 5; i >= 0; i--) {
      const d = new Date(Date.UTC(y, m - 1 - i, 1))
      const key = d.toISOString().slice(0, 7)
      porMes.push({
        key,
        label: MESES[d.getUTCMonth()],
        labelLargo: `${MESES_LARGO[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
        ...suma(fact.filter(r => mesDe(r) === key)),
      })
    }

    const porTipo = Object.entries(TIPOS).map(([key, label]) => ({
      key, label, ...suma(pend.filter(r => r.tipo === key)),
    }))

    const porCliente = new Map()
    pend.forEach(r => {
      const c = porCliente.get(r.cliente_id) || { cliente: r.cliente, total: 0, count: 0 }
      c.total += r.monto
      c.count += 1
      porCliente.set(r.cliente_id, c)
    })
    const topClientes = [...porCliente.values()].sort((a, b) => b.total - a.total).slice(0, 5)

    return {
      mesLabel: `${MESES_LARGO[m - 1]} ${y}`,
      pendiente: suma(pend),
      facturado: { count: rows.filter(r => r.facturado).length },
      facturadoMes: suma(fact.filter(r => mesDe(r) === mes)),
      facturadoAnio: suma(fact.filter(r => mesDe(r).slice(0, 4) === anio)),
      pendientesViejos: suma(pend.filter(r => r.dias > 30)),
      requiereNC: suma(rows.filter(r => r.requiereNC)),
      porMes,
      porTipo,
      topClientes,
    }
  },

  // Registra una factura (manual o con CAE) para una o varias OP del mismo cliente.
  async facturar({ opIds, clienteId, tipo, origen, puntoVenta, nroCbte, numero, cae, caeVto, fecha,
                   alicuota, neto, iva, total, receptor, usuario }) {
    return transaction(async (q) => {
      const { rows } = await q(`
        SELECT id, id_cliente, estado, para_facturar, facturado
        FROM op_encabezado WHERE id = ANY(?::bigint[]) FOR UPDATE
      `, [opIds])
      const ok = rows.length === opIds.length && rows.every(r =>
        Number(r.para_facturar) === 1 && !Number(r.facturado) && r.estado !== 'anulado'
        && Number(r.id_cliente) === Number(clienteId))
      if (!ok) throw errorUsuario('Alguna operación ya no está pendiente de facturar. Actualizá la página.')

      const { rows: fac } = await q(`
        INSERT INTO facturas (cliente_id, tipo_comprobante, punto_venta, nro_cbte, numero, fecha,
                              receptor_nombre, receptor_cuit, receptor_condicion_iva,
                              alicuota_iva, neto, iva, total, origen, cae, cae_vto, id_usuario)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `, [clienteId, tipo, puntoVenta || null, nroCbte || null, numero, fecha,
          receptor.nombre || null, receptor.cuit || null, receptor.condicion || null,
          alicuota, neto, iva, total, origen, cae || null, caeVto || null, usuario || null])
      const facturaId = fac[0].id

      await q(`
        UPDATE op_encabezado
           SET facturado = 1, factura_id = ?, nro_factura = ?, fecha_factura = ?, facturado_por = ?,
               facturado_en = to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
         WHERE id = ANY(?::bigint[])
      `, [facturaId, numero, fecha, usuario || null, opIds])
      return facturaId
    })
  },

  // Revierte una factura manual: todas las OP que cubría vuelven a Pendiente Facturar.
  async revertir(opId) {
    return transaction(async (q) => {
      const { rows } = await q(`
        SELECT op.id, op.factura_id, f.origen
        FROM op_encabezado op LEFT JOIN facturas f ON f.id = op.factura_id
        WHERE op.id = ? FOR UPDATE OF op
      `, [opId])
      const op = rows[0]
      if (!op) throw errorUsuario('Operación no encontrada.')
      if (op.origen === 'afip') throw errorUsuario('Una factura electrónica con CAE no se puede revertir: hay que emitir una nota de crédito.')
      const { rows: afectadas } = await q(`
        UPDATE op_encabezado
           SET facturado = 0, nro_factura = NULL, fecha_factura = NULL, facturado_por = NULL,
               facturado_en = NULL, factura_id = NULL
         WHERE ${op.factura_id ? 'factura_id = ?' : 'id = ?'}
         RETURNING id
      `, [op.factura_id || op.id])
      if (op.factura_id) await q(`UPDATE facturas SET estado = 'revertida' WHERE id = ?`, [op.factura_id])
      return afectadas.map(r => r.id)
    })
  },

  async registrarNC(opId, { numero, fecha, cae }) {
    await query(`
      UPDATE op_encabezado SET nc_numero = ?, nc_fecha = ?, nc_cae = ?
       WHERE id = ? AND facturado = 1 AND estado = 'anulado'
    `, [numero, fecha, cae || null, opId])
  },
}
