'use strict'
// ═══════════════════════════════════════════════════════════════════
// descuentos.model.js — Descuentos a clientes desde Liquidaciones y Cuenta corriente.
// Ver docs/superpowers/specs/2026-11-19-descuentos-design.md
//
//  · Cada descuento (tabla descuentos) y cuánto le tocó a cada operación
//    (descuento_operaciones). Lógica de reparto en utils/descuentos.
//  · Operación en la cuenta corriente: además, un ajuste a favor atado a la operación
//    (movimientos_cuenta tipo 'ajuste', id_op_encabezado): la imputación lo trata como rebaja de
//    esa operación y el saldo del cliente baja solo. De contado: no hay movimiento; Liquidaciones
//    resta el descuento del total al armar la operación (renglón "Descuento …").
//  · "Sobre el saldo total": un ajuste a favor sin operación (crédito que va a lo más viejo).
//  · Revertir: anula los ajustes y marca el descuento revertido (queda el historial).
// ═══════════════════════════════════════════════════════════════════
const { query, transaction } = require('../config/db')
const D = require('../utils/descuentos')
const { fmtFecha } = require('../utils/fecha')

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100
const nroOp = (n) => `OP-${String(n).padStart(4, '0')}`
const nombreOp = (o) => `${nroOp(o.nro_op)}${o.nro_remito ? ' · Remito ' + o.nro_remito : ''}`
const Liq = () => require('./liquidaciones.model')
const Clientes = () => require('./clientes.model')

// Ficha corta de una operación para el modal
const ficha = (o) => ({
  id: o.id, nro_op: o.nro_op, nombre: nombreOp(o), nro_remito: o.nro_remito || null, fecha: o.fecha, tipoTexto: o.tipoTexto,
  obra: o.obra || null, resta: r2(o.resta), nroFactura: o.nroFactura || null, facturada: D.facturaEmitida(o),
  aviso: D.facturaEmitida(o) ? D.avisoFactura(o.nroFactura) : null,
})

// Agrupa las descontables por un número (remito / factura): [{ numero, cantidad, resta }]
function numeros(ops, campo) {
  const m = new Map()
  for (const o of ops) {
    const n = o[campo] ? String(o[campo]).trim() : ''
    if (!n) continue
    const g = m.get(n) || { numero: n, cantidad: 0, resta: 0 }
    g.cantidad++; g.resta = r2(g.resta + Number(o.resta))
    m.set(n, g)
  }
  return [...m.values()].sort((a, b) => a.numero.localeCompare(b.numero, 'es', { numeric: true }))
}

async function operacionesEnPantalla(clienteId, filtros) {
  const liq = await Liq().liquidacion({ ...filtros, clienteId: String(clienteId) })
  return liq.clientes[0] ? liq.clientes[0].operaciones : []
}

const DescuentosModel = {
  // Lo que necesita el modal: las descontables de la pantalla, los remitos / facturas del
  // cliente con algo para descontar, lo que debe en total y las que quedan afuera (y por qué).
  async opciones(clienteId, filtros) {
    const enPantalla = await operacionesEnPantalla(clienteId, filtros)
    const todas = await Liq().operacionesCliente(clienteId)
    const descontables = todas.filter(D.esDescontable)
    const saldo = await Liq().saldoCliente(clienteId)
    const excluidas = enPantalla
      .filter(o => !D.esDescontable(o) && (Number(o.resta) || 0) > 0.01)
      .map(o => ({ nombre: nombreOp(o), motivo: D.porQueNo(o) }))
    return {
      enPantalla: enPantalla.filter(D.esDescontable).map(ficha),
      todas: descontables.map(ficha),
      remitos: numeros(descontables, 'nro_remito'),
      facturas: numeros(descontables, 'nroFactura'),
      saldoTotal: saldo ? r2(Math.max(0, saldo.total)) : 0,
      excluidas,
    }
  },

  // Qué se descontaría: { pedido, lineas: [{ ...ficha, monto, queda }], total, etiqueta, alcanceTexto }.
  // Tira Error con un mensaje para la pantalla si no se puede.
  async vistaPrevia(clienteId, body, filtros) {
    const pedido = D.validar(body)
    if (pedido.error) throw new Error(pedido.error)
    const etiqueta = D.etiqueta(pedido)
    if (pedido.alcance === 'saldo') {
      const saldo = await Liq().saldoCliente(clienteId)
      const debe = saldo ? r2(Math.max(0, saldo.total)) : 0
      const monto = D.montoSobre(debe, pedido)
      return { pedido, etiqueta, alcanceTexto: D.ALCANCE_TEXTO.saldo, lineas: [], debe, total: monto, queda: r2(debe - monto) }
    }
    let ops
    if (pedido.alcance === 'todas') {
      ops = (await operacionesEnPantalla(clienteId, filtros)).filter(D.esDescontable)
    } else {
      const todas = await Liq().operacionesCliente(clienteId)
      if (pedido.alcance === 'operacion') {
        const o = todas.find(x => String(x.id) === pedido.referencia)
        if (!o) throw new Error('La operación no es de este cliente.')
        const no = D.porQueNo(o)
        if (no) throw new Error(`${nombreOp(o)} no se puede descontar: ${no}`)
        ops = [o]
      } else {
        const campo = pedido.alcance === 'remito' ? 'nro_remito' : 'nroFactura'
        ops = todas.filter(o => D.esDescontable(o) && String(o[campo] || '').trim() === pedido.referencia)
        if (!ops.length) throw new Error(`No hay operaciones con saldo pendiente con ${pedido.alcance === 'remito' ? 'el remito' : 'la factura'} ${pedido.referencia}.`)
      }
    }
    const reparto = D.repartir(ops, pedido)
    const porId = new Map(ops.map(o => [String(o.id), o]))
    const lineas = reparto.map(x => ({ ...ficha(porId.get(String(x.id))), monto: x.monto, queda: x.queda, enCuenta: !!porId.get(String(x.id)).enCuenta }))
    const total = r2(lineas.reduce((s, l) => s + l.monto, 0))
    const alcanceTexto = pedido.alcance === 'remito' ? `Remito ${pedido.referencia}`
      : pedido.alcance === 'factura' ? `Factura ${pedido.referencia}`
      : pedido.alcance === 'operacion' ? lineas[0].nombre : D.ALCANCE_TEXTO.todas
    return { pedido, etiqueta, alcanceTexto, lineas, debe: r2(lineas.reduce((s, l) => s + l.resta, 0)), total, queda: r2(lineas.reduce((s, l) => s + l.queda, 0)) }
  },

  // Aplica el descuento. totalEsperado: el total que mostró la vista previa (si cambió en el
  // medio, por un cobro, se rechaza para que se revise). Devuelve { id, total }.
  async aplicar(clienteId, body, filtros, { usuario = null, motivo = '', totalEsperado = null } = {}) {
    const vista = await DescuentosModel.vistaPrevia(clienteId, body, filtros)
    if (totalEsperado != null && Math.abs(r2(totalEsperado) - vista.total) > 0.005) {
      throw new Error('Los importes cambiaron desde la vista previa (¿se registró un cobro?). Revisá la vista previa y volvé a aplicar.')
    }
    const { pedido, etiqueta } = vista
    const texto = String(motivo || '').trim().slice(0, 300) || null
    return await transaction(async (q) => {
      await q(`SELECT id FROM clientes WHERE id = ? FOR UPDATE`, [clienteId])
      const id = (await q(`
        INSERT INTO descuentos (cliente_id, tipo, valor, alcance, referencia, total, motivo, id_usuario)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [clienteId, pedido.tipo, pedido.valor, pedido.alcance, pedido.referencia, vista.total, texto, usuario])).rows[0].id
      if (pedido.alcance === 'saldo') {
        const mov = await Clientes().agregarMovimiento(clienteId, { tipo: 'ajuste', descripcion: `Descuento ${etiqueta} sobre el saldo`, monto: vista.total }, q)
        await q(`INSERT INTO descuento_operaciones (id_descuento, id_op_encabezado, monto, id_movimiento) VALUES (?, NULL, ?, ?)`, [id, vista.total, mov])
      } else {
        for (const l of vista.lineas) {
          const mov = l.enCuenta
            ? await Clientes().agregarMovimiento(clienteId, { tipo: 'ajuste', descripcion: `Descuento ${etiqueta} — ${nroOp(l.nro_op)}`, monto: l.monto, id_op_encabezado: l.id }, q)
            : null
          await q(`INSERT INTO descuento_operaciones (id_descuento, id_op_encabezado, monto, id_movimiento, factura_emitida, nro_factura) VALUES (?, ?, ?, ?, ?, ?)`,
            [id, l.id, l.monto, mov, l.facturada ? 1 : 0, l.nroFactura])
        }
      }
      return { id, total: vista.total, etiqueta, alcanceTexto: vista.alcanceTexto }
    })
  },

  // Revierte el descuento entero: anula sus ajustes de la cuenta y lo marca revertido.
  async revertir(idDescuento, clienteId, { usuario = null, motivo }) {
    const texto = String(motivo || '').trim().slice(0, 300)
    if (!texto) throw new Error('Indicá el motivo para revertir el descuento.')
    return await transaction(async (q) => {
      const d = (await q(`SELECT * FROM descuentos WHERE id = ? AND cliente_id = ? FOR UPDATE`, [idDescuento, clienteId])).rows[0]
      if (!d) throw new Error('El descuento no existe.')
      if (Number(d.revertido)) throw new Error('Ese descuento ya estaba revertido.')
      await q(`
        UPDATE movimientos_cuenta SET anulado = 1, anulado_en = ahora_local(), anulado_por = ?, anulado_motivo = ?
        WHERE COALESCE(anulado, 0) = 0 AND id IN (SELECT id_movimiento FROM descuento_operaciones WHERE id_descuento = ? AND id_movimiento IS NOT NULL)`,
        [usuario, `Descuento revertido: ${texto}`, idDescuento])
      await q(`UPDATE descuentos SET revertido = 1, revertido_en = ahora_local(), revertido_por = ?, revertido_motivo = ? WHERE id = ?`,
        [usuario, texto, idDescuento])
      return { ...d, total: Number(d.total), etiqueta: D.etiqueta({ tipo: d.tipo, valor: Number(d.valor) }) }
    })
  },

  // Los descuentos del cliente, del más nuevo al más viejo, con sus operaciones
  async delCliente(clienteId) {
    const filas = (await query(`
      SELECT d.*, u.nombre AS usuario_nombre, ur.nombre AS revertido_por_nombre
      FROM descuentos d
      LEFT JOIN users u ON u.id = d.id_usuario
      LEFT JOIN users ur ON ur.id = d.revertido_por
      WHERE d.cliente_id = ? ORDER BY d.created_at DESC, d.id DESC`, [clienteId])).rows
    if (!filas.length) return []
    const ops = (await query(`
      SELECT dop.id_descuento, dop.id_op_encabezado, dop.monto, dop.factura_emitida, dop.nro_factura, op.nro_op, op.nro_remito
      FROM descuento_operaciones dop LEFT JOIN op_encabezado op ON op.id = dop.id_op_encabezado
      WHERE dop.id_descuento = ANY(?::bigint[]) ORDER BY dop.id`, [filas.map(f => Number(f.id))])).rows
    return filas.map(f => {
      const suyas = ops.filter(o => String(o.id_descuento) === String(f.id) && o.id_op_encabezado)
      const alcanceTexto = f.alcance === 'remito' ? `Remito ${f.referencia}` : f.alcance === 'factura' ? `Factura ${f.referencia}`
        : f.alcance === 'operacion' && suyas[0] ? nombreOp(suyas[0]) : D.ALCANCE_TEXTO[f.alcance]
      const facturadas = suyas.filter(o => Number(o.factura_emitida))
      return {
        id: f.id, fecha: String(f.created_at || '').slice(0, 10), tipo: f.tipo, valor: Number(f.valor), etiqueta: D.etiqueta({ tipo: f.tipo, valor: Number(f.valor) }),
        alcance: f.alcance, alcanceTexto, total: r2(f.total), motivo: f.motivo || '', usuario: f.usuario_nombre || '',
        revertido: !!Number(f.revertido), revertidoEn: f.revertido_en ? String(f.revertido_en).slice(0, 10) : null,
        revertidoPor: f.revertido_por_nombre || '', revertidoMotivo: f.revertido_motivo || '',
        operaciones: suyas.map(o => ({ id: o.id_op_encabezado, nombre: nombreOp(o), monto: r2(o.monto), facturada: !!Number(o.factura_emitida), nroFactura: o.nro_factura || null })),
        aviso: facturadas.length ? D.avisoFactura(facturadas.length === 1 ? facturadas[0].nro_factura : null) : null,
      }
    })
  },

  async cantidadVigentes(clienteId) {
    return Number((await query(`SELECT COUNT(*) AS n FROM descuentos WHERE cliente_id = ? AND revertido = 0`, [clienteId])).rows[0].n) || 0
  },

  // Descuentos vigentes por operación (para el renglón de Liquidaciones):
  // { [idOp]: [{ descripcion, monto }] }
  async vigentesPorOperacion(ids) {
    const lista = [...new Set((ids || []).filter(Boolean).map(Number))]
    if (!lista.length) return {}
    const rows = (await query(`
      SELECT dop.id_op_encabezado AS id, dop.monto, d.tipo, d.valor, d.created_at
      FROM descuento_operaciones dop JOIN descuentos d ON d.id = dop.id_descuento
      WHERE d.revertido = 0 AND dop.id_op_encabezado = ANY(?::bigint[]) ORDER BY d.created_at, dop.id`, [lista])).rows
    const res = {}
    for (const r of rows) {
      (res[r.id] ||= []).push({ descripcion: `Descuento ${D.etiqueta({ tipo: r.tipo, valor: Number(r.valor) })} (${fmtFecha(String(r.created_at).slice(0, 10))})`, monto: r2(r.monto) })
    }
    return res
  },

  // Descuentos "sobre el saldo" vigentes del cliente (para el PDF): [{ fecha, etiqueta, monto }]
  async sobreElSaldo(clienteId) {
    return (await query(`SELECT tipo, valor, total, created_at FROM descuentos WHERE cliente_id = ? AND alcance = 'saldo' AND revertido = 0 ORDER BY created_at`, [clienteId]))
      .rows.map(r => ({ fecha: String(r.created_at).slice(0, 10), etiqueta: D.etiqueta({ tipo: r.tipo, valor: Number(r.valor) }), monto: r2(r.total) }))
  },

  // El ajuste de un descuento acompaña al cargo de la operación en la cuenta corriente: si la
  // operación tiene cargo (y no está anulada), su descuento vigente tiene su ajuste; si no
  // (se anuló, pasó a contado), el ajuste se anula y el descuento queda como rebaja del total.
  // Lo llaman los sincronizarCargoCC de ventas y alquileres.
  async sincronizarAjustes(idOp, q = query) {
    const filas = (await q(`
      SELECT dop.id, dop.monto, dop.id_movimiento, d.cliente_id, d.tipo, d.valor, op.nro_op, op.estado, op.id_cliente,
             COALESCE(mv.anulado, 1) AS mov_anulado,
             EXISTS (SELECT 1 FROM movimientos_cuenta m WHERE m.id_op_encabezado = op.id AND m.tipo IN ('deuda', 'uso_saldo_favor')
                     AND COALESCE(m.anulado, 0) = 0 AND m.cliente_id = d.cliente_id) AS con_cargo
      FROM descuento_operaciones dop
      JOIN descuentos d ON d.id = dop.id_descuento AND d.revertido = 0
      JOIN op_encabezado op ON op.id = dop.id_op_encabezado
      LEFT JOIN movimientos_cuenta mv ON mv.id = dop.id_movimiento
      WHERE dop.id_op_encabezado = ?`, [idOp])).rows
    for (const f of filas) {
      const debe = f.estado !== 'anulado' && (f.con_cargo === true || f.con_cargo === 't' || Number(f.con_cargo) === 1)
      const tiene = f.id_movimiento != null && !Number(f.mov_anulado)
      if (debe && !tiene) {
        const mov = await Clientes().agregarMovimiento(f.cliente_id, {
          tipo: 'ajuste', descripcion: `Descuento ${D.etiqueta({ tipo: f.tipo, valor: Number(f.valor) })} — ${nroOp(f.nro_op)}`, monto: Number(f.monto), id_op_encabezado: idOp }, q)
        await q(`UPDATE descuento_operaciones SET id_movimiento = ? WHERE id = ?`, [mov, f.id])
      } else if (!debe && tiene) {
        await q(`UPDATE movimientos_cuenta SET anulado = 1, anulado_en = ahora_local(), anulado_motivo = ? WHERE id = ?`,
          ['Descuento: la operación ya no tiene cargo en la cuenta corriente', f.id_movimiento])
      }
    }
  },
}

module.exports = DescuentosModel
