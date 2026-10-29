'use strict'
const { query, transaction } = require('../config/db')
const { ALICUOTA_FACTURAR, ivaDe, conIva, sinIva } = require('../utils/iva')

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

const ALICUOTAS = [ALICUOTA_FACTURAR]

const MESES       = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic']
const MESES_LARGO = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']

const esVerdadero = (v) => v === true || v === 1 || ['1', 'on', 'true'].includes(String(v))
const { hoyISO } = require('../utils/fecha')
const redondear = (n) => Math.round((Number(n) || 0) * 100) / 100
const tipoDe = (op) => op.tipo_op === 'C' ? 'contenedor'
  : op.tipo_op === 'MA' ? 'maquinaria'
  : (op.modalidad === 'flete' ? 'viaje' : 'cantera')

// RI factura A a inscriptos y monotributistas (RG 5003) y B al resto; un monotributista siempre C.
const tipoSugerido = (condCliente, empresa = 'RI') => empresa === 'MT' ? 'C'
  : (['RI', 'MT'].includes(condCliente) ? 'A' : 'B')

// Importe final (IVA incluido) → neto + IVA. Para las operaciones marcadas antes de que el
// IVA se sumara al neto (iva_alicuota NULL): su monto era el final.
function desglose(total, tipo, alicuota) {
  const t = redondear(total)
  if (tipo === 'C' || !Number(alicuota)) return { neto: t, iva: 0 }
  const neto = sinIva(t, alicuota)
  return { neto, iva: redondear(t - neto) }
}

// Neto e IVA de una operación para el comprobante `tipo` (A/B/C). Las que llevan el IVA
// sumado (con_iva) ya traen su neto e IVA; las viejas se desglosan de su monto final.
function desgloseOp(op, tipo) {
  if (tipo === 'C') return { neto: redondear(op.monto), iva: 0 }
  if (op.con_iva) return { neto: op.neto_op, iva: op.iva_op }
  return desglose(op.monto, tipo, ALICUOTA_FACTURAR)
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

// Monto (operaciones viejas, sin IVA sumado): lo cobrado (transacciones) si ya existe; si no,
// el total pactado de la venta o el cargado al crear; si no, lo estimado desde el detalle.
// Neto (con IVA sumado): venta → el total pactado (o productos + flete); alquiler → el neto
// cobrado (monto_facturar, se guarda al cobrar) o el precio. NULL = alquiler sin precio todavía.
const selectBase = (where) => `
  SELECT op.id, op.nro_op, op.tipo_op, op.modalidad, op.estado, op.metodo_pago, op.fecha_emision,
         op.para_facturar, op.facturado, op.nro_factura, op.fecha_factura, op.facturado_en, op.factura_id,
         op.nc_numero, op.nc_fecha, op.nc_cae, op.iva_alicuota,
         cli.id AS cliente_id, cli.dni, cli.cuit, cli.razon_social, cli.condicion_iva, cli.domicilio_ppal,
         TRIM(cli.nombre || ' ' || COALESCE(cli.apellido, '')) AS cliente,
         COALESCE(tx.monto, op.monto_total, op.monto_facturar, mat.monto + COALESCE(op.precio_flete, 0), dc.precio, dm.precio, 0) AS monto_final,
         CASE op.tipo_op
           WHEN 'M' THEN COALESCE(op.monto_total, mat.monto + COALESCE(op.precio_flete, 0), 0)
           WHEN 'C' THEN COALESCE(op.monto_facturar, dc.precio)
           ELSE COALESCE(op.monto_facturar, dm.precio, 0)
         END AS neto_base,
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
  const alicuota = Number(r.iva_alicuota) || 0
  const con_iva = alicuota > 0
  const sin_precio = con_iva && r.neto_base == null
  const neto_op = con_iva ? redondear(r.neto_base) : null
  const iva_op = con_iva ? ivaDe(neto_op, alicuota) : null
  const monto = con_iva ? conIva(neto_op, alicuota) : (Number(r.monto_final) || 0)
  const emision = String(r.fecha_emision || '').slice(0, 10)
  const op = { con_iva, neto_op, iva_op, monto }
  // Facturada: según su comprobante (las viejas, con la alícuota con que se facturaron);
  // pendiente: como factura A/B (neto + IVA)
  const { neto, iva } = facturado && !con_iva
    ? desglose(op.monto, r.tipo_comprobante, Number(r.alicuota_iva) || 0)
    : desgloseOp(op, facturado ? r.tipo_comprobante : 'A')
  return {
    ...r,
    tipo,
    tipo_label: TIPOS[tipo],
    para_facturar: Number(r.para_facturar) === 1,
    facturado,
    anulada,
    ...op,
    alicuota: con_iva ? alicuota : ALICUOTA_FACTURAR,
    sin_precio,
    neto,
    iva,
    comprobante: r.nro_factura ? `${r.tipo_comprobante ? r.tipo_comprobante + ' ' : ''}${r.nro_factura}` : null,
    requiereNC: anulada && facturado && !r.nc_numero,
    condicion_iva_label: CONDICIONES_IVA[r.condicion_iva] || null,
    dias: emision ? Math.floor((Date.parse(hoy) - Date.parse(emision)) / 86400000) : 0,
  }
}

const errorUsuario = (msg) => Object.assign(new Error(msg), { usuario: true })

// Se sumó o se quitó el IVA de una OP ya creada (marcar / quitar "para facturar"): lo que
// debe el cliente acompaña.
//  - Venta: el cargo en cuenta corriente se recalcula con la regla única (sincronizarCargoCC).
//    Si ya se cobró de contado, la diferencia queda como saldo de la operación.
//  - Alquiler ya cobrado: el cobro registrado pasa a neto + IVA nuevo. A cuenta corriente o
//    con saldo a favor, la diferencia va como movimiento en la cuenta del cliente y la
//    transacción (que no es plata cobrada) se ajusta. De contado no se toca lo cobrado: la
//    diferencia queda como saldo. Sin cobro todavía no hay nada que ajustar: el cobro se
//    genera después con el IVA que tenga.
async function ajustarDeudaIva(q, id, alicAnterior, alicNueva) {
  const op = (await q(`SELECT id, nro_op, tipo_op, metodo_pago, id_cliente FROM op_encabezado WHERE id = ?`, [id])).rows[0]
  if (!op) return
  if (op.tipo_op === 'M') {
    await require('./ventas.model').sincronizarCargoCC(id, q)
    return
  }
  const txs = (await q(`SELECT id, monto, metodo_pago FROM transacciones WHERE id_op_encabezado = ? ORDER BY id`, [id])).rows
  if (!txs.length) return
  const registrado = redondear(txs.reduce((a, t) => a + (Number(t.monto) || 0), 0))
  const neto = sinIva(registrado, alicAnterior)
  const diff = redondear(conIva(neto, alicNueva) - registrado)
  await q(`UPDATE op_encabezado SET monto_facturar = ? WHERE id = ?`, [neto, id])
  if (Math.abs(diff) < 0.005) return

  const ultima = txs[txs.length - 1]
  const metodo = ultima.metodo_pago || op.metodo_pago
  const enCuenta = { cuenta_corriente: 'deuda', saldo_a_favor: 'uso_saldo_favor' }[metodo]
  if (!enCuenta || !op.id_cliente) return
  const nro = `OP-${String(op.nro_op).padStart(4, '0')}`
  const tipo = diff > 0 ? enCuenta : 'ajuste'
  const descripcion = diff > 0 ? `IVA ${ALICUOTA_FACTURAR}% ${nro} (para facturar)` : `Se quita el IVA de ${nro} (no se factura)`
  // El IVA de una operación vieja va en el día de la operación, no en el de hoy
  await require('./clientes.model').agregarMovimiento(op.id_cliente, { tipo, descripcion, monto: -diff, id_op_encabezado: id }, q)
  await q(`UPDATE transacciones SET monto = ? WHERE id = ?`, [redondear(Number(ultima.monto) + diff), ultima.id])
}

// Marca una OP para facturar y le suma el IVA a lo que debe. false si no cambió nada
// (no existe, anulada o ya marcada).
async function marcarEn(q, id) {
  const op = (await q(`SELECT id, estado, para_facturar, iva_alicuota FROM op_encabezado WHERE id = ? FOR UPDATE`, [id])).rows[0]
  if (!op || op.estado === 'anulado' || Number(op.para_facturar) === 1) return false
  await q(`UPDATE op_encabezado SET para_facturar = 1, iva_alicuota = ? WHERE id = ?`, [ALICUOTA_FACTURAR, id])
  await ajustarDeudaIva(q, id, Number(op.iva_alicuota) || 0, ALICUOTA_FACTURAR)
  return true
}

// La saca de la lista para facturar y le descuenta el IVA sumado. false si no cambió nada
// (no existe, ya facturada o no estaba marcada).
async function quitarEn(q, id) {
  const op = (await q(`SELECT id, facturado, para_facturar, iva_alicuota FROM op_encabezado WHERE id = ? FOR UPDATE`, [id])).rows[0]
  if (!op || Number(op.facturado) === 1) return false
  if (Number(op.para_facturar) !== 1 && !Number(op.iva_alicuota)) return false
  await q(`UPDATE op_encabezado SET para_facturar = 0, iva_alicuota = NULL WHERE id = ?`, [id])
  if (Number(op.iva_alicuota)) await ajustarDeudaIva(q, id, Number(op.iva_alicuota), 0)
  return true
}

module.exports = {
  TIPOS, CONDICIONES_IVA, ALICUOTAS, ALICUOTA_FACTURAR,
  tipoSugerido, desglose, desgloseOp, cuitValido, documentoReceptor, conceptoAfip, redondear, mapear,

  // Se llama al crear cualquier venta/alquiler: marca la OP si se tildó "Operación para Facturar"
  // y le suma el IVA al neto cargado. Devuelve la alícuota sumada (0 si no es para facturar):
  // quien crea el cobro en el alta lo hace por conIva(neto, alícuota).
  // `monto` null = todavía sin importe (un alquiler sin precio): se guarda NULL, no 0, para
  // que el monto salga del precio que se le asigne después en vez de quedar tapado por un 0.
  async marcarAlCrear(id_op, flag, monto) {
    if (!id_op || !esVerdadero(flag)) return 0
    const sinMonto = monto === null || monto === undefined || String(monto).trim() === ''
    await query(`UPDATE op_encabezado SET para_facturar = 1, monto_facturar = ?, iva_alicuota = ? WHERE id = ?`,
      [sinMonto ? null : (Number(monto) || 0), ALICUOTA_FACTURAR, id_op])
    return ALICUOTA_FACTURAR
  },

  // Marcar una OP ya existente (desde su detalle): también se le suma el IVA a lo que debe.
  async marcar(id) {
    return transaction((q) => marcarEn(q, id))
  },

  // Marcar / quitar varias OP de una vez (desde Liquidaciones), todas en la misma
  // transacción: o se marcan todas o ninguna. Devuelve los id que cambiaron; las que ya
  // estaban así (o no se pueden: anuladas, facturadas) se saltean.
  async marcarVarias(ids) {
    return transaction(async (q) => {
      const cambiadas = []
      for (const id of ids) if (await marcarEn(q, id)) cambiadas.push(id)
      return cambiadas
    })
  },

  async quitarVarias(ids) {
    return transaction(async (q) => {
      const cambiadas = []
      for (const id of ids) if (await quitarEn(q, id)) cambiadas.push(id)
      return cambiadas
    })
  },

  // Una sola vez (migraciones_aplicadas): las OP marcadas para facturar antes de que el IVA
  // se sumara al neto, y todavía sin facturar, pasan al criterio nuevo: su importe se toma
  // como neto y se les suma el 21% a lo que debe el cliente (igual que marcarlas hoy). Las
  // ya facturadas no se tocan: su comprobante salió con el IVA incluido. Guarda en
  // bkp_iva_sobre_neto cada OP con su importe anterior. Devuelve los N° de OP o null si ya corrió.
  async sumarIvaAPendientesViejas() {
    return transaction(async (q) => {
      await q(`CREATE TABLE IF NOT EXISTS migraciones_aplicadas (nombre TEXT PRIMARY KEY, aplicada_en TEXT DEFAULT ahora_local())`)
      const r = await q(`INSERT INTO migraciones_aplicadas (nombre) VALUES ('iva_sobre_neto_pendientes') ON CONFLICT DO NOTHING RETURNING nombre`)
      if (!r.rows.length) return null
      await q(`CREATE TABLE IF NOT EXISTS bkp_iva_sobre_neto (op_id BIGINT, nro_op BIGINT, monto_facturar REAL, cobrado REAL, cargo REAL, migrado_en TEXT DEFAULT ahora_local())`)
      const ops = (await q(`
        SELECT op.id, op.nro_op, op.monto_facturar,
               (SELECT SUM(monto) FROM transacciones t WHERE t.id_op_encabezado = op.id) AS cobrado,
               (SELECT SUM(monto) FROM movimientos_cuenta m WHERE m.id_op_encabezado = op.id AND m.tipo IN ('deuda','uso_saldo_favor') AND COALESCE(m.anulado, 0) = 0) AS cargo
        FROM op_encabezado op
        WHERE op.para_facturar = 1 AND COALESCE(op.facturado, 0) = 0 AND op.estado <> 'anulado' AND op.iva_alicuota IS NULL
        ORDER BY op.id FOR UPDATE
      `)).rows
      for (const op of ops) {
        await q(`INSERT INTO bkp_iva_sobre_neto (op_id, nro_op, monto_facturar, cobrado, cargo) VALUES (?, ?, ?, ?, ?)`,
          [op.id, op.nro_op, op.monto_facturar, op.cobrado, op.cargo])
        await q(`UPDATE op_encabezado SET iva_alicuota = ? WHERE id = ?`, [ALICUOTA_FACTURAR, op.id])
        await ajustarDeudaIva(q, op.id, 0, ALICUOTA_FACTURAR)
      }
      return ops.map(o => o.nro_op)
    })
  },

  // Saca una OP pendiente de la lista (tildada por error) y le descuenta el IVA sumado.
  // Las ya facturadas no se tocan.
  async quitar(id) {
    return transaction((q) => quitarEn(q, id))
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

  // Operaciones para el PDF de detalle (las anuladas también: una facturada puede estarlo)
  async porIds(ids) {
    if (!ids.length) return []
    const hoy = hoyISO()
    const { rows } = await query(selectBase('op.id = ANY(?::bigint[])'), [ids.map(Number)])
    return rows.map(r => mapear(r, hoy)).sort((a, b) => Number(a.nro_op) - Number(b.nro_op))
  },

  // Factura registrada de una OP: la factura y todas las OP que cubre. null si no está facturada.
  async deFactura(opId) {
    const op = await this.estadoOp(opId)
    if (!op || !op.facturado) return null
    if (!op.factura_id) return { factura: null, ops: [op] }
    const hoy = hoyISO()
    const { rows } = await query(selectBase('op.factura_id = ?'), [op.factura_id])
    const factura = (await query(`SELECT * FROM facturas WHERE id = ?`, [op.factura_id])).rows[0] || null
    return { factura, ops: rows.map(r => mapear(r, hoy)).sort((a, b) => Number(a.nro_op) - Number(b.nro_op)) }
  },

  // clienteId: solo ese cliente; opIds: solo esas operaciones (las de una obra, ver
  // ClientesModel.obraPorClave)
  filtrar(rows, { estado, q, tipo, desde, hasta, nc, clienteId, opIds }) {
    const facturado = estado === 'facturado'
    const texto = String(q || '').trim().toLowerCase()
    const deLaObra = opIds ? new Set(opIds.map(String)) : null
    return rows.filter(r => {
      if (facturado ? !r.facturado : (r.facturado || r.anulada)) return false
      if (clienteId && String(r.cliente_id) !== String(clienteId)) return false
      if (deLaObra && !deLaObra.has(String(r.id))) return false
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
               facturado_en = ahora_local()
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
