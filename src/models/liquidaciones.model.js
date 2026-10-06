'use strict'
// ═══════════════════════════════════════════════════════════════════
// liquidaciones.model.js — Operaciones de un cliente (o de todos) con su detalle,
// estado de pago y totales. La lógica de pago y totales está en utils/liquidaciones.
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

// Fecha de la operación: la de entrega planificada; si falta, la de emisión (= Libro de ventas)
const FECHA = `LEFT(COALESCE(op.fecha_entrega_planificada, op.fecha_emision), 10)`
const TIPO_OP = { cantera: 'M', viaje: 'M', contenedor: 'C', maquinaria: 'MA' }

async function operacionesBase({ clienteId, desde, hasta, tipos, opIds }) {
  const cond = [`op.estado <> 'anulado'`, `op.id_cliente IS NOT NULL`, `${FECHA} >= ?`, `${FECHA} <= ?`,
    `op.tipo_op = ANY(?)`]
  const params = [desde, hasta, [...new Set(tipos.map(t => TIPO_OP[t]))]]
  if (clienteId) { cond.push('op.id_cliente = ?'); params.push(clienteId) }
  if (opIds)     { cond.push('op.id = ANY(?::bigint[])'); params.push(opIds.map(Number)) }
  return (await query(`
    SELECT op.id, op.nro_op, op.nro_remito, op.tipo_op, op.modalidad, op.id_cliente, op.id_grupo,
           ${FECHA} AS fecha, op.obra, op.domicilio_calle, op.domicilio_altura,
           op.precio_flete, op.monto_total,
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

// Cobrado por transacciones de contado (las de método cuenta_corriente son cargos, no plata)
async function cobradoContado(ids) {
  if (!ids.length) return {}
  const rows = (await query(`
    SELECT id_op_encabezado AS id, SUM(monto) AS cobrado FROM transacciones
    WHERE id_op_encabezado = ANY(?::bigint[]) AND metodo_pago <> 'cuenta_corriente' AND tipo <> 'Ajuste'
    GROUP BY id_op_encabezado
  `, [ids.map(Number)])).rows
  return Object.fromEntries(rows.map(r => [r.id, Number(r.cobrado) || 0]))
}

// Arma una operación: detalle según el tipo y total
function armar(r, materiales) {
  const tipo = L.tipoDeOperacion(r)
  const op = {
    id: r.id, nro_op: r.nro_op, nro_remito: r.nro_remito, fecha: r.fecha, tipo, tipoTexto: L.TIPOS[tipo],
    obra: nombreObra(r), id_cliente: r.id_cliente, id_grupo: r.id_grupo, grupoTodoJunto: !!r.grupo_todo_junto,
    metodo_pago: r.metodo_pago, metodoTexto: L.METODOS[r.metodo_pago] || 'Sin definir',
    aConvenir: false, renglones: [], total: 0,
  }
  if (r.tipo_op === 'M') {
    op.renglones = [...(materiales[r.id] || [])]
    const subtotal = op.renglones.reduce((s, x) => s + x.importe, 0)
    const { flete, ajuste, total } = importesVenta(r, subtotal)
    if (flete)  op.renglones.push({ descripcion: 'Flete', unidad: '', cantidad: 1, precio_unit: flete, importe: flete })
    if (ajuste) op.renglones.push({ descripcion: 'Ajuste de precio', unidad: '', cantidad: 1, precio_unit: ajuste, importe: ajuste })
    op.total = total
  } else if (r.tipo_op === 'C') {
    const desde = r.cont_desde, hasta = r.cont_hasta
    const dias = desde && hasta ? L.diasEntre(desde, hasta) : Number(r.plazo_alquiler) || 1
    const periodo = !desde ? '' : hasta ? ` — ${fmtFecha(desde)} al ${fmtFecha(hasta)}` : ` — desde ${fmtFecha(desde)} (en curso)`
    const base = `Alquiler contenedor${r.numero_contenedor != null ? ' N° ' + r.numero_contenedor : ''}${periodo}`
    if (r.precio_alquiler == null) {
      op.aConvenir = true
      op.renglones = [{ descripcion: `${base} · Precio a convenir`, unidad: 'días', cantidad: dias, precio_unit: 0, importe: 0 }]
    } else {
      const total = Number(r.precio_alquiler) || 0
      op.renglones = [{ descripcion: base, unidad: 'días', cantidad: dias, precio_unit: Math.round(total / dias * 100) / 100, importe: total }]
      op.total = total
    }
  } else if (r.tipo_op === 'MA') {
    const total = Number(r.maq_total) || 0
    op.renglones = [{ descripcion: r.maquina || 'Maquinaria', unidad: 'h', cantidad: Number(r.horas_pactadas) || 0,
      precio_unit: Number(r.precio_por_hora) || 0, importe: total }]
    op.total = total
  }
  return op
}

async function pagosDelCliente(clienteId, { desde, hasta }) {
  const cc = (await query(`
    SELECT LEFT(created_at, 10) AS fecha, metodo_pago, descripcion, monto FROM movimientos_cuenta
    WHERE cliente_id = ? AND tipo = 'pago' AND LEFT(created_at, 10) BETWEEN ? AND ?
  `, [clienteId, desde, hasta])).rows
  const contado = (await query(`
    SELECT LEFT(fecha, 10) AS fecha, metodo_pago, descripcion, monto FROM transacciones
    WHERE cliente_id = ? AND metodo_pago <> 'cuenta_corriente' AND tipo <> 'Ajuste' AND LEFT(fecha, 10) BETWEEN ? AND ?
  `, [clienteId, desde, hasta])).rows
  return [...cc, ...contado]
    .map(p => ({ fecha: p.fecha, metodoTexto: L.METODOS[p.metodo_pago] || '—', descripcion: p.descripcion || '', monto: Number(p.monto) || 0 }))
    .sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)))
}

async function datosClientes(ids) {
  if (!ids.length) return {}
  const rows = (await query(`
    SELECT id, numero, dni, email, COALESCE(telefono, tel_whatsapp) AS telefono, domicilio_ppal AS direccion,
           COALESCE(${nombreClienteSQL('c')}, 'Particular') AS nombre_completo
    FROM clientes c WHERE id = ANY(?::bigint[])
  `, [ids.map(Number)])).rows
  return Object.fromEntries(rows.map(r => [r.id, {
    id: r.id, numero: r.numero, nombreCompleto: r.nombre_completo, dni: r.dni || '', telefono: r.telefono || '',
    direccion: r.direccion || '', email: r.email || '',
  }]))
}

const LiquidacionesModel = {
  // filtros: salida de normalizarFiltros (utils/liquidaciones)
  async liquidacion({ clienteId, obra, desde, hasta, tipos, estadoPago }) {
    if (clienteId) {
      const existe = (await query(`SELECT 1 FROM clientes WHERE id = ?`, [clienteId])).rowCount
      if (!existe) return { clientes: [], resumen: L.resumir([]), clienteInexistente: true }
    }
    const obraElegida = clienteId && obra ? await ClientesModel.obraPorClave(clienteId, obra) : null

    const filas = await operacionesBase({ clienteId, desde, hasta, tipos, opIds: obraElegida ? obraElegida.opIds : null })
    // cantera y viaje comparten tipo_op 'M': se separan acá
    const pedidas = filas.filter(r => tipos.includes(L.tipoDeOperacion(r)))
    const ids = pedidas.map(r => r.id)
    // En secuencia (no Promise.all): el arnés de pruebas corre todo en una sola conexión
    const materiales = await renglonesMaterial(pedidas.filter(r => r.tipo_op === 'M').map(r => r.id))
    const cobrado = await cobradoContado(ids)
    const cc = await ClientesModel.pagadoPorOperacion(ids)

    let ops = pedidas.map(r => {
      const op = armar(r, materiales)
      Object.assign(op, L.estadoPago({ total: op.total, aConvenir: op.aConvenir, metodoPago: op.metodo_pago, cobrado: cobrado[op.id], cc: cc[op.id] }))
      // Grupo "todo junto": la OP que tiene el cargo / cobro del grupo es el ancla del reparto
      const registro = op.metodo_pago === 'cuenta_corriente' ? cc[op.id] : (cobrado[op.id] != null ? { total: null, pagado: cobrado[op.id] } : null)
      op._sinRegistroPago = !registro
      if (op.grupoTodoJunto && registro) {
        op._pagadoGrupo = registro.pagado
        op._totalGrupo = registro.total != null ? registro.total : pedidas.filter(x => String(x.id_grupo) === String(op.id_grupo)).reduce((s, x) => s + (Number(x.precio_alquiler) || 0), 0)
      }
      return op
    })
    L.repartirGrupos(ops)
    ops.forEach(o => { delete o._sinRegistroPago; delete o._pagadoGrupo; delete o._totalGrupo })
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
    return { clientes, resumen: L.resumir(ops), obra: obraElegida ? obraElegida.nombre : null }
  },
}

module.exports = LiquidacionesModel
