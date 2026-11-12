'use strict'
// ═══════════════════════════════════════════════════════════════════
// liquidaciones.model.js — Operaciones de un cliente (o de todos) con su detalle,
// estado de pago y totales, y el SALDO DEL CLIENTE. La lógica de pago y totales está en
// utils/liquidaciones; la imputación de pagos, en utils/imputacion (la misma que usa la
// Cuenta corriente).
//
// Para que Liquidaciones y Cuenta corriente digan lo mismo:
//  · El importe de una operación ya cobrada / cargada es el REGISTRADO (lo que se cobró o
//    lo que figura en la cuenta del cliente), no el precio de alta: un alquiler de contenedor
//    se cobra a la tarifa por los días reales, o con el precio que se ajustó al cerrarlo.
//  · Lo pagado de una operación a cuenta corriente o pagada con saldo a favor sale de la
//    imputación de la cuenta (pagos a lo más viejo primero).
//  · saldoCliente() arma el saldo del cliente (cuenta corriente, sin cobrar, en curso) que
//    muestran igual la Cuenta corriente, la Liquidación y su PDF.
// ═══════════════════════════════════════════════════════════════════
const { query } = require('../config/db')
const { importesVenta } = require('./ventas.model')
const ClientesModel = require('./clientes.model')
const { SQL_FECHA_CIERRE_OP, SQL_MOV_ALQUILER_OP } = require('./alquileres.model')
const { nombreClienteSQL } = require('../utils/nombreCliente')
const { SQL_DESCRIPCION_DETALLE, SQL_UNIDAD_DETALLE } = require('../utils/contenedor')
const { nombreObra, claveObra } = require('../utils/obras')
const { fmtFecha } = require('../utils/fecha')
const L = require('../utils/liquidaciones')
const { ivaDe, sinIva, etiqueta: etiquetaIva } = require('../utils/iva')

// Fecha de la operación: regla única del sistema (venta = fecha de compra; alquiler = inicio).
// La misma que usan la cuenta corriente y el Libro de ventas: ver utils/fechaOperacion.
const { SQL_FECHA_OPERACION: FECHA, fechaDeOperacion } = require('../utils/fechaOperacion')
const TIPO_OP = { cantera: 'M', viaje: 'M', contenedor: 'C', maquinaria: 'MA' }
const redondear = (n) => Math.round((Number(n) || 0) * 100) / 100

async function operacionesBase({ clienteId, desde, hasta, tipos, opIds, conAnuladas = false }) {
  // Sin desde / hasta (búsqueda por id, o todo el historial del cliente): sin filtro de fecha
  const cond = [`op.id_cliente IS NOT NULL`, `op.tipo_op = ANY(?)`]
  const params = [[...new Set(tipos.map(t => TIPO_OP[t]))]]
  if (!conAnuladas) cond.push(`op.estado <> 'anulado'`)
  if (desde) { cond.push(`${FECHA} >= ?`); params.push(desde) }
  if (hasta) { cond.push(`${FECHA} <= ?`); params.push(hasta) }
  if (clienteId) { cond.push('op.id_cliente = ?'); params.push(clienteId) }
  if (opIds)     { cond.push('op.id = ANY(?::bigint[])'); params.push(opIds.map(Number)) }
  return (await query(`
    SELECT op.id, op.nro_op, op.nro_remito, op.tipo_op, op.modalidad, op.id_cliente, op.id_grupo, op.estado,
           ${FECHA} AS fecha, op.obra, op.domicilio_calle, op.domicilio_altura,
           op.precio_flete, op.monto_total, op.monto_facturar, op.iva_alicuota, op.para_facturar, op.facturado,
           COALESCE(op.metodo_pago, oc.metodo_pago, om.metodo_pago) AS metodo_pago,
           (ag.cobro_modo = 'alquiler') AS grupo_todo_junto,
           oc.id AS oc_id, oc.precio_alquiler, oc.domicilio_entrega AS cont_entrega,
           oc.domicilio_calle AS cont_calle, oc.domicilio_numero AS cont_numero, oc.plazo_alquiler,
           cont.numero_contenedor,
           COALESCE(NULLIF(LEFT(op.fecha_entrega_planificada, 10), ''), LEFT(ma.fecha_alquiler, 10)) AS cont_desde,
           LEFT(${SQL_FECHA_CIERRE_OP}, 10) AS cont_hasta,
           om.horas_pactadas, om.precio_por_hora, om.precio_total AS maq_total,
           om.domicilio_entrega AS maq_entrega, om.domicilio_calle AS maq_calle, om.domicilio_numero AS maq_numero,
           maq.nombre AS maquina
    FROM op_encabezado op
    LEFT JOIN LATERAL (SELECT * FROM op_detalle_contenedor d WHERE d.id_orden_pedido = op.id ORDER BY d.id LIMIT 1) oc ON TRUE
    LEFT JOIN contenedores cont ON cont.id = oc.id_contenedor
    LEFT JOIN (${SQL_MOV_ALQUILER_OP}) ma ON ma.id_op_contenedor = oc.id
    LEFT JOIN LATERAL (SELECT * FROM op_detalle_maquinaria d WHERE d.id_orden_pedido = op.id ORDER BY d.id LIMIT 1) om ON TRUE
    LEFT JOIN maquinaria maq ON maq.id = om.id_maquinaria
    LEFT JOIN alquiler_grupos ag ON ag.id = op.id_grupo
    WHERE ${cond.join(' AND ')}
    ORDER BY ${FECHA} ASC, op.nro_op ASC
  `, params)).rows
}

async function renglonesMaterial(ids) {
  if (!ids.length) return {}
  const rows = (await query(`
    SELECT d.id_orden_pedido, ${SQL_DESCRIPCION_DETALLE} AS descripcion, ${SQL_UNIDAD_DETALLE} AS unidad,
           d.cantidad_pedida AS cantidad, d.precio_unitario AS precio_unit,
           (d.cantidad_pedida * d.precio_unitario) AS importe
    FROM op_detalle_material d JOIN productos p ON p.id = d.id_producto
    WHERE d.id_orden_pedido = ANY(?::bigint[])
    ORDER BY d.id
  `, [ids.map(Number)])).rows
  const porOp = {}
  rows.forEach(r => (porOp[r.id_orden_pedido] ||= []).push({
    descripcion: r.descripcion, unidad: r.unidad || '', cantidad: Number(r.cantidad) || 0,
    precio_unit: Number(r.precio_unit) || 0, importe: Number(r.importe) || 0,
  }))
  return porOp
}

// Cobros registrados de cada operación (transacciones): { [id]: { registrado, contado } }.
// registrado: todo lo cobrado (con cualquier método; es el importe cobrado de un alquiler);
// contado: solo la plata que entró en el momento. Cuenta corriente y saldo a favor no son
// plata (su pago está en la cuenta del cliente) y "a convenir" todavía no es un cobro.
async function cobrosRegistrados(ids) {
  if (!ids.length) return {}
  const rows = (await query(`
    SELECT id_op_encabezado AS id, SUM(monto) AS registrado,
           SUM(CASE WHEN metodo_pago = ANY(?) THEN 0 ELSE monto END) AS contado
    FROM transacciones
    WHERE id_op_encabezado = ANY(?::bigint[]) AND tipo <> 'Ajuste'
    GROUP BY id_op_encabezado
  `, [L.METODOS_SIN_COBRO, ids.map(Number)])).rows
  return Object.fromEntries(rows.map(r => [r.id, { registrado: Number(r.registrado) || 0, contado: Number(r.contado) || 0 }]))
}

// Renglón de un alquiler de contenedor por `neto`. diasReales: los que lleva uno en curso.
function renglonContenedor(r, neto, diasReales = null) {
  const desde = r.cont_desde, hasta = r.cont_hasta
  const dias = desde && hasta ? L.diasEntre(desde, hasta) : (diasReales > 0 ? diasReales : Number(r.plazo_alquiler) || 1)
  const periodo = !desde ? '' : hasta ? ` — ${fmtFecha(desde)} al ${fmtFecha(hasta)}` : ` — desde ${fmtFecha(desde)} (en curso)`
  const base = `Alquiler contenedor${r.numero_contenedor != null ? ' N° ' + r.numero_contenedor : ''}${periodo}`
  return { base, dias, renglon: { descripcion: base, unidad: 'días', cantidad: dias, precio_unit: Math.round(neto / dias * 100) / 100, importe: neto } }
}

// Agrega el IVA (para facturar) al neto de la operación: un renglón más del total
function cerrarTotales(op, alicuota) {
  op.renglones = op.renglones.filter(x => !x.esIva)
  op.neto = op.total = redondear(op.renglones.reduce((s, x) => s + x.importe, 0))
  op.iva = op.aConvenir ? 0 : ivaDe(op.neto, alicuota)
  if (op.iva) {
    op.renglones.push({ descripcion: etiquetaIva(alicuota), unidad: '', cantidad: 1, precio_unit: op.iva, importe: op.iva, esIva: true })
    op.total = redondear(op.neto + op.iva)
  }
}

// Arma una operación: detalle según el tipo y total. `cobro` (de cobrosRegistrados): un
// alquiler ya cobrado vale lo que se cobró (el neto guardado al cobrar, o lo cobrado sin IVA).
function armar(r, materiales, cobro) {
  const tipo = L.tipoDeOperacion(r)
  const op = {
    id: r.id, nro_op: r.nro_op, nro_remito: r.nro_remito, fecha: r.fecha, tipo, tipoTexto: L.TIPOS[tipo],
    obra: nombreObra(r), id_cliente: r.id_cliente, id_grupo: r.id_grupo, grupoTodoJunto: !!r.grupo_todo_junto,
    metodo_pago: r.metodo_pago, metodoTexto: L.METODOS[r.metodo_pago] || 'Sin definir', estadoOp: r.estado,
    aConvenir: false, renglones: [], total: 0, cobrado: false, estimado: false,
    enCurso: r.tipo_op === 'C' && r.estado === 'entregado' && !r.cont_hasta,
    paraFacturar: Number(r.para_facturar) === 1, facturado: Number(r.facturado) === 1,
  }
  const netoCobrado = () => r.monto_facturar != null ? Number(r.monto_facturar) : sinIva(cobro.registrado, r.iva_alicuota)
  if (r.tipo_op === 'M') {
    op.renglones = [...(materiales[r.id] || [])]
    const subtotal = op.renglones.reduce((s, x) => s + x.importe, 0)
    // Neto: el IVA (para facturar) se agrega abajo, igual que en los alquileres
    const { flete, ajuste } = importesVenta(r, subtotal)
    if (flete)  op.renglones.push({ descripcion: 'Flete', unidad: '', cantidad: 1, precio_unit: flete, importe: flete })
    if (ajuste) op.renglones.push({ descripcion: 'Ajuste de precio', unidad: '', cantidad: 1, precio_unit: ajuste, importe: ajuste })
  } else if (r.tipo_op === 'C') {
    if (cobro) {
      op.cobrado = true
      op.renglones = [renglonContenedor(r, netoCobrado()).renglon]
    } else if (r.precio_alquiler == null) {
      const { base, dias } = renglonContenedor(r, 0)
      op.aConvenir = true
      op.renglones = [{ descripcion: `${base} · Precio a convenir`, unidad: 'días', cantidad: dias, precio_unit: 0, importe: 0 }]
    } else {
      op.renglones = [renglonContenedor(r, Number(r.precio_alquiler) || 0).renglon]
    }
  } else if (r.tipo_op === 'MA') {
    const horas = Number(r.horas_pactadas) || 0
    const neto = cobro ? netoCobrado() : Number(r.maq_total) || 0
    op.cobrado = !!cobro
    op.renglones = [{ descripcion: r.maquina || 'Maquinaria', unidad: 'h', cantidad: horas,
      precio_unit: cobro ? (horas > 0 ? Math.round(neto / horas * 100) / 100 : neto) : Number(r.precio_por_hora) || 0, importe: neto }]
  }
  cerrarTotales(op, r.iva_alicuota)
  op._alicuota = r.iva_alicuota
  return op
}

// Alquileres de contenedor entregados que todavía no se cobraron (en curso, o retirados
// esperando el método de pago): el importe es lo que se cobraría hoy (tarifa por los días
// reales, o el precio asignado), igual que el "importe estimado" de la Cuenta corriente.
async function estimarSinCobrar(ops, filas) {
  const AlquileresModel = require('./alquileres.model')
  const porId = new Map(filas.map(r => [String(r.id), r]))
  for (const op of ops) {
    if (op.tipo !== 'contenedor' || op.cobrado || op.aConvenir || op.estadoOp !== 'entregado') continue
    const cierre = await AlquileresModel.datosCierre(op.id, { alRetiro: true })
    if (!cierre || cierre.sinPrecio) continue
    op.renglones = [renglonContenedor(porId.get(String(op.id)), cierre.precioACobrar, cierre.dias).renglon]
    cerrarTotales(op, op._alicuota)
    op.estimado = true
  }
}

// Lo que figura en la cuenta corriente manda: si la operación tiene allí otro importe (un
// dato viejo), el total pasa a ser ese y la diferencia se ve como un renglón.
function igualarACuenta(op, totalCuenta) {
  const diferencia = redondear(totalCuenta - op.total)
  if (Math.abs(diferencia) < 0.005) return
  if (Math.abs(diferencia) <= 0.02) {
    // Redondeo del IVA: el centavo va al último renglón
    const ultimo = op.renglones[op.renglones.length - 1]
    if (ultimo) { ultimo.importe = redondear(ultimo.importe + diferencia); ultimo.precio_unit = redondear(ultimo.precio_unit + diferencia / (ultimo.cantidad || 1)) }
  } else {
    op.renglones.push({ descripcion: 'Diferencia con lo cargado en la cuenta corriente', unidad: '', cantidad: 1, precio_unit: diferencia, importe: diferencia })
  }
  op.total = redondear(totalCuenta)
}

// Operaciones armadas con su estado de pago (sin filtrar por estado). filtros: los de
// operacionesBase. Devuelve { ops, filas }.
async function calcularOperaciones({ clienteId, desde, hasta, tipos, opIds }) {
  const filas = await operacionesBase({ clienteId, desde, hasta, tipos, opIds })
  // cantera y viaje comparten tipo_op 'M': se separan acá
  const pedidas = filas.filter(r => tipos.includes(L.tipoDeOperacion(r)))
  const ids = pedidas.map(r => r.id)
  // En secuencia (no Promise.all): el arnés de pruebas corre todo en una sola conexión
  const materiales = await renglonesMaterial(pedidas.filter(r => r.tipo_op === 'M').map(r => r.id))
  const cobros = await cobrosRegistrados(ids)
  const cc = await ClientesModel.pagadoPorOperacion(ids)

  const ops = pedidas.map(r => armar(r, materiales, cobros[r.id]))
  await estimarSinCobrar(ops, pedidas)
  for (const op of ops) {
    const enCuentaMetodo = L.METODOS_EN_CUENTA.includes(op.metodo_pago)
    const ccOp = enCuentaMetodo ? cc[op.id] : null
    if (ccOp && !op.grupoTodoJunto && !op.aConvenir) igualarACuenta(op, ccOp.total)
    Object.assign(op, L.estadoPago({ total: op.total, aConvenir: op.aConvenir, metodoPago: op.metodo_pago, cobrado: (cobros[op.id] || {}).contado, cc: ccOp }))
    // Grupo "todo junto": la OP que tiene el cargo / cobro del grupo es el ancla del reparto
    const registro = enCuentaMetodo ? ccOp : (cobros[op.id] ? { total: null, pagado: cobros[op.id].contado } : null)
    if (op.grupoTodoJunto && registro) {
      op._pagadoGrupo = registro.pagado
      op._totalGrupo = registro.total != null ? registro.total
        : ops.filter(x => String(x.id_grupo) === String(op.id_grupo)).reduce((s, x) => s + x.total, 0)
    }
  }
  L.repartirGrupos(ops)
  // ¿La operación ya está en la cuenta corriente (tiene su cargo, propio o el del grupo)?
  const gruposConCargo = new Set(ops.filter(o => L.METODOS_EN_CUENTA.includes(o.metodo_pago) && cc[o.id] && o.id_grupo != null).map(o => String(o.id_grupo)))
  ops.forEach(o => {
    o.enCuenta = L.METODOS_EN_CUENTA.includes(o.metodo_pago) && (!!cc[o.id] || (o.grupoTodoJunto && gruposConCargo.has(String(o.id_grupo))))
    delete o._pagadoGrupo; delete o._totalGrupo; delete o._alicuota
  })
  return { ops, filas: pedidas }
}

async function pagosDelCliente(clienteId, { desde, hasta }) {
  const cc = (await query(`
    SELECT LEFT(created_at, 10) AS fecha, metodo_pago, descripcion, monto FROM movimientos_cuenta
    WHERE cliente_id = ? AND tipo = 'pago' AND COALESCE(anulado, 0) = 0 AND LEFT(created_at, 10) BETWEEN ? AND ?
  `, [clienteId, desde, hasta])).rows
  // Cobros de contado: los de cuenta corriente y saldo a favor no son plata que entró (el pago
  // ya está en la cuenta: contarlos sería contarlo dos veces) y "a convenir" no es un cobro
  const contado = (await query(`
    SELECT LEFT(fecha, 10) AS fecha, metodo_pago, descripcion, monto FROM transacciones
    WHERE cliente_id = ? AND NOT (metodo_pago = ANY(?)) AND tipo <> 'Ajuste' AND LEFT(fecha, 10) BETWEEN ? AND ?
  `, [clienteId, L.METODOS_SIN_COBRO, desde, hasta])).rows
  return [...cc, ...contado]
    .map(p => ({ fecha: p.fecha, metodoTexto: L.METODOS[p.metodo_pago] || '—', descripcion: p.descripcion || '', monto: Number(p.monto) || 0 }))
    .sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)))
}

async function datosClientes(ids) {
  if (!ids.length) return {}
  const rows = (await query(`
    SELECT id, numero, dni, email, saldo, COALESCE(telefono, tel_whatsapp) AS telefono, domicilio_ppal AS direccion,
           COALESCE(${nombreClienteSQL('c')}, 'Particular') AS nombre_completo
    FROM clientes c WHERE id = ANY(?::bigint[])
  `, [ids.map(Number)])).rows
  return Object.fromEntries(rows.map(r => [r.id, {
    id: r.id, numero: r.numero, nombreCompleto: r.nombre_completo, dni: r.dni || '', telefono: r.telefono || '',
    direccion: r.direccion || '', email: r.email || '', saldoCuenta: redondear(r.saldo),
  }]))
}

const LiquidacionesModel = {
  // Operaciones armadas (detalle, neto, IVA y total) por id, sin filtro de fecha ni de
  // estado de pago. Lo usa el PDF de Facturación. Devuelve { [id]: op }.
  async operacionesPorIds(ids) {
    if (!ids || !ids.length) return {}
    const filas = await operacionesBase({ tipos: Object.keys(L.TIPOS), opIds: ids, conAnuladas: true })
    const materiales = await renglonesMaterial(filas.filter(r => r.tipo_op === 'M').map(r => r.id))
    const cobros = await cobrosRegistrados(filas.map(r => r.id))
    const ops = filas.map(r => armar(r, materiales, cobros[r.id]))
    ops.forEach(o => { delete o._alicuota })
    return Object.fromEntries(ops.map(o => [o.id, o]))
  },

  // Una operación armada con su estado de pago (o null si no existe). Sin filtros de fecha.
  async operacion(idOp) {
    const { ops } = await calcularOperaciones({ tipos: Object.keys(L.TIPOS), opIds: [idOp] })
    return ops[0] || null
  },

  // filtros: salida de normalizarFiltros (utils/liquidaciones)
  async liquidacion({ clienteId, obra, desde, hasta, tipos, estadoPago }) {
    if (clienteId) {
      const existe = (await query(`SELECT 1 FROM clientes WHERE id = ?`, [clienteId])).rowCount
      if (!existe) return { clientes: [], resumen: L.resumir([]), clienteInexistente: true }
    }
    const obraElegida = clienteId && obra ? await ClientesModel.obraPorClave(clienteId, obra) : null

    let { ops } = await calcularOperaciones({ clienteId, desde, hasta, tipos, opIds: obraElegida ? obraElegida.opIds : null })
    ops = L.filtrarPorEstado(ops, estadoPago)

    const fichas = await datosClientes(clienteId ? [clienteId] : [...new Set(ops.map(o => o.id_cliente))])
    const grupos = clienteId
      ? [{ clave: String(clienteId), operaciones: ops }]
      : L.agruparPor(ops, o => String(o.id_cliente), o => fichas[o.id_cliente]?.nombreCompleto || '')

    const clientes = []
    for (const g of grupos) {
      const id = clienteId || g.operaciones[0].id_cliente
      const porObra = L.agruparPor(g.operaciones.filter(o => o.obra), o => claveObra(o.obra), o => o.obra)
      clientes.push({
        cliente: fichas[id],
        operaciones: g.operaciones,
        pagos: clienteId && !obraElegida ? await pagosDelCliente(clienteId, { desde, hasta }) : null,
        resumen: L.resumir(g.operaciones),
        porObra: !obraElegida && porObra.length > 1 ? porObra.map(o => ({ nombre: o.nombre, resumen: o.resumen })) : [],
      })
    }
    // Con un cliente: su saldo (el mismo que muestra la Cuenta corriente), con el detalle de
    // cuánto es de este período, de otros, sin cobrar y en curso
    const saldo = clienteId ? await LiquidacionesModel.saldoCliente(clienteId, { desde, hasta }) : null
    return { clientes, resumen: L.resumir(ops), obra: obraElegida ? obraElegida.nombre : null, saldo }
  },

  // Saldo del cliente (utils/liquidaciones.saldoDelCliente): la cuenta corriente (igual a
  // clientes.saldo, el número de Cuentas corrientes), qué se debe de cada período, de dónde
  // sale el saldo a favor, lo que falta cobrar fuera de la cuenta y lo que está en curso.
  // desde / hasta (opcionales): el período que se está mirando, para separar la deuda.
  async saldoCliente(clienteId, { desde = null, hasta = null } = {}) {
    const cliente = (await query(`SELECT saldo FROM clientes WHERE id = ?`, [clienteId])).rows[0]
    if (!cliente) return null
    const { ops } = await calcularOperaciones({ clienteId, tipos: Object.keys(L.TIPOS) })
    const { movs, cargos, aFavor, creditos } = await ClientesModel.imputacionDe(clienteId)
    // Fecha de la operación de cada cargo (para separar la deuda por período)
    const idsOp = [...new Set(Object.values(cargos).map(c => c.idOp).filter(Boolean).map(Number))]
    const datosOp = idsOp.length ? Object.fromEntries((await query(
      `SELECT id, nro_op, tipo_op, fecha_emision, fecha_entrega_planificada FROM op_encabezado WHERE id = ANY(?::bigint[])`, [idsOp]
    )).rows.map(r => [String(r.id), r])) : {}
    for (const c of Object.values(cargos)) {
      const op = c.idOp ? datosOp[String(c.idOp)] : null
      c.fechaOp = op ? fechaDeOperacion(op) : null
      c.nroOp = op ? op.nro_op : null
    }
    return L.saldoDelCliente({
      cargos, aFavor, creditos, ops, desde, hasta,
      saldoCuenta: redondear(cliente.saldo),
      saldoMovimientos: redondear(movs.reduce((s, m) => s + (Number(m.monto) || 0), 0)),
    })
  },
}

module.exports = LiquidacionesModel
