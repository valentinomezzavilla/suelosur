'use strict'
const crypto = require('crypto')
const { query, transaction } = require('../config/db')

// Operación a cuenta corriente, no anulada, que todavía no tiene su cargo (op = op_encabezado)
const SQL_OP_SIN_CARGO = `op.metodo_pago = 'cuenta_corriente' AND op.estado <> 'anulado'
  AND NOT EXISTS (SELECT 1 FROM movimientos_cuenta m WHERE m.id_op_encabezado = op.id AND m.tipo = 'deuda')`
const SQL_PENDIENTES_CC = `SELECT COUNT(*) FROM op_encabezado op WHERE op.id_cliente = c.id AND ${SQL_OP_SIN_CARGO}`

const ClientesModel = {

  async listar() {
    return (await query(`SELECT * FROM clientes WHERE activo = 1 ORDER BY numero ASC NULLS LAST, apellido, nombre`)).rows
  },

  async obtener(id) {
    return (await query(`SELECT * FROM clientes WHERE id = ?`, [id])).rows[0]
  },

  // Autocomplete: un único término busca en numero/dni/nombre/apellido/razón social.
  // Prioriza coincidencias exactas (N°, DNI, nombre/apellido) y luego orden alfabético.
  async buscarLive(q, limit = 8) {
    const s = String(q || '').trim()
    if (!s) return []
    // Quitar acentos del término para hacer la búsqueda accent-insensitive
    const sinAcentos = (str) => String(str || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    const termPlain = sinAcentos(s)
    const term = `%${termPlain}%`
    const exact = termPlain.toLowerCase()

    // translate() reemplaza acentos en el campo para que matchee con el término sin acentos.
    // No depende de la extensión unaccent (que puede no estar disponible en planes free).
    const SIN_ACENTOS = `translate(COALESCE({col}, ''), 'áéíóúÁÉÍÓÚñÑüÜ', 'aeiouAEIOUnNuU')`
    const sa = (col) => SIN_ACENTOS.replace('{col}', col)

    return (await query(`
      SELECT * FROM clientes
      WHERE activo = 1 AND (
        ${sa('nombre')}   ILIKE ?
        OR ${sa('apellido')} ILIKE ?
        OR ${sa("nombre || ' ' || apellido")} ILIKE ?
        OR COALESCE(dni, '') ILIKE ?
        OR CAST(COALESCE(numero, 0) AS TEXT) ILIKE ?
      )
      ORDER BY
        CASE WHEN CAST(COALESCE(numero, 0) AS TEXT) = ?
                  OR lower(COALESCE(dni, '')) = ?
                  OR lower(${sa('nombre')}) = ?
                  OR lower(${sa('apellido')}) = ?
                  OR lower(${sa("nombre || ' ' || apellido")}) = ? THEN 0 ELSE 1 END,
        apellido, nombre
      LIMIT ?
    `, [term, term, term, term, term, exact, exact, exact, exact, exact, limit])).rows
  },

  // Búsqueda estricta: si vienen varios criterios, TODOS deben corresponder al mismo cliente (AND).
  async buscar({ id, dni, nombre, numero } = {}) {
    const wheres = []
    const params = []

    const sId = id != null ? String(id).trim() : ''
    const numId = (numero != null && numero !== '') ? numero
                : (sId && /^\d+$/.test(sId)) ? sId : null
    const uuid = (sId && !/^\d+$/.test(sId)) ? sId : null

    if (numId != null) { wheres.push('numero = ?'); params.push(Number(numId)) }
    if (uuid)          { wheres.push('id = ?');     params.push(uuid) }
    if (dni)           { wheres.push('dni = ?');    params.push(String(dni).trim()) }
    if (nombre)        { wheres.push('(nombre ILIKE ? OR apellido ILIKE ?)'); params.push(`%${nombre}%`, `%${nombre}%`) }

    if (!wheres.length) {
      return (await query(`SELECT * FROM clientes WHERE activo = 1 ORDER BY apellido, nombre`)).rows
    }
    return (await query(`SELECT * FROM clientes WHERE ${wheres.join(' AND ')} ORDER BY apellido, nombre`, params)).rows
  },

  async proximoNumero() {
    const r = (await query(`SELECT COALESCE(MAX(numero), 0) AS m FROM clientes`)).rows[0]
    return (r.m || 0) + 1
  },

  async crear({ nombre, apellido, domicilio_ppal, zona, tel_whatsapp, telefono, email, dni, tipo_cliente, cuenta_corriente, cuit, razon_social, condicion_iva }) {
    const numero = await this.proximoNumero()
    const { rows } = await query(`
      INSERT INTO clientes (numero, nombre, apellido, domicilio_ppal, zona, tel_whatsapp, telefono, email, dni, tipo_cliente, cuenta_corriente, cuit, razon_social, condicion_iva)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `, [numero, nombre, apellido || '', domicilio_ppal || null, zona || null,
        tel_whatsapp || null, telefono || null, email || null, dni || null,
        tipo_cliente || null, cuenta_corriente ? 1 : 0,
        cuit || null, razon_social || null, condicion_iva || null])
    return rows[0].id
  },

  async actualizar(id, datos) {
    const fields = []
    const values = []
    const map = { nombre:1, apellido:1, domicilio_ppal:1, zona:1, tel_whatsapp:1, telefono:1, email:1, dni:1, tipo_cliente:1, cuit:1, razon_social:1, condicion_iva:1 }
    for (const [k, v] of Object.entries(datos)) {
      if (map[k]) { fields.push(`${k} = ?`); values.push(v ?? null) }
    }
    if (datos.cuenta_corriente !== undefined) {
      fields.push('cuenta_corriente = ?')
      values.push(datos.cuenta_corriente === true || datos.cuenta_corriente === 'true' ? 1 : 0)
    }
    if (!fields.length) return
    values.push(id)
    await query(`UPDATE clientes SET ${fields.join(', ')} WHERE id = ?`, values)
  },

  async toggleActivo(id) {
    await query(`UPDATE clientes SET activo = 1 - activo WHERE id = ?`, [id])
  },

  // ¿Se puede dar de baja? Revisa operaciones activas, alquileres vigentes y saldo CC.
  async puedeEliminar(id) {
    const cli = await this.obtener(id)
    if (!cli) return { ok: false, motivo: 'Cliente no encontrado.' }
    if (Math.abs(cli.saldo || 0) > 0.009) {
      return { ok: false, motivo: `Tiene saldo pendiente en cuenta corriente (${cli.saldo < 0 ? 'debe' : 'a favor'} $${Math.abs(cli.saldo).toLocaleString('es-AR')}).` }
    }
    const opsActivas = (await query(`
      SELECT COUNT(*) AS n FROM op_encabezado
      WHERE id_cliente = ? AND (estado IN ('pendiente','despachado')
            OR (tipo_op IN ('C','MA') AND estado = 'entregado'))
    `, [id])).rows[0]?.n || 0
    if (opsActivas > 0) {
      return { ok: false, motivo: `Tiene ${opsActivas} operación(es) activa(s) o alquiler(es) vigente(s).` }
    }
    return { ok: true }
  },

  async eliminar(id) {
    // Baja lógica: conserva historial transaccional
    await query(`UPDATE clientes SET activo = 0 WHERE id = ?`, [id])
  },

  // Una operación a cuenta corriente necesita un cliente real con la cuenta habilitada
  // (la UI solo ofrece la opción en ese caso, pero el servidor no puede confiar en eso).
  // Devuelve null si está todo bien, o el mensaje de error.
  async errorCuentaCorriente(clienteId) {
    if (!clienteId) return 'Para vender a cuenta corriente hay que elegir un cliente (no puede ser "particular").'
    const c = (await query(`SELECT nombre, cuenta_corriente, activo FROM clientes WHERE id = ?`, [clienteId])).rows[0]
    if (!c) return 'El cliente no existe.'
    if (!c.cuenta_corriente) return `${c.nombre} no tiene la cuenta corriente habilitada. Habilitala en Clientes → Cuentas corrientes o elegí otro método de pago.`
    return null
  },

  async habilitarCuenta(id) {
    await query(`UPDATE clientes SET cuenta_corriente = 1 WHERE id = ?`, [id])
  },

  async agregarMovimiento(id, { tipo, descripcion, monto, metodo_pago, id_op_encabezado }) {
    const { rows } = await query(`INSERT INTO movimientos_cuenta (cliente_id, tipo, descripcion, monto, metodo_pago, id_op_encabezado) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      [id, tipo, descripcion, Number(monto), metodo_pago || null, id_op_encabezado || null])
    await query(`UPDATE clientes SET saldo = saldo + ? WHERE id = ?`, [Number(monto), id])
    return rows[0].id
  },

  // Elimina un movimiento y revierte su efecto en el saldo (usado para deshacer
  // el crédito de un cheque cuando se deshabilita).
  async eliminarMovimiento(movId) {
    const m = (await query(`SELECT cliente_id, monto FROM movimientos_cuenta WHERE id = ?`, [movId])).rows[0]
    if (!m) return
    await query(`DELETE FROM movimientos_cuenta WHERE id = ?`, [movId])
    await query(`UPDATE clientes SET saldo = saldo - ? WHERE id = ?`, [Number(m.monto), m.cliente_id])
  },

  async movimientos(clienteId) {
    return (await query(`SELECT * FROM movimientos_cuenta WHERE cliente_id = ? ORDER BY created_at DESC`, [clienteId])).rows
  },

  async movimientosFiltrados(clienteId, { fechaDesde, fechaHasta } = {}) {
    const wheres = ['cliente_id = ?']
    const params = [clienteId]
    if (fechaDesde) { wheres.push('LEFT(created_at, 10) >= ?'); params.push(fechaDesde) }
    if (fechaHasta) { wheres.push('LEFT(created_at, 10) <= ?'); params.push(fechaHasta) }
    return (await query(`SELECT * FROM movimientos_cuenta WHERE ${wheres.join(' AND ')} ORDER BY created_at ASC, id ASC`, params)).rows
  },

  // Saldo pendiente de ventas puntuales a cuenta corriente (venta por venta, no el
  // saldo global del cliente). No hay un vínculo pago↔venta explícito: los pagos se
  // aplican en orden FIFO contra las deudas más antiguas del cliente, igual que ya
  // refleja el saldo corrido de estadoCuenta(). Devuelve { [id_op_encabezado]: boolean saldada }.
  async saldadaPorOperacion(opIds) {
    const ids = [...new Set((opIds || []).filter(Boolean))]
    if (!ids.length) return {}
    const ph = ids.map(() => '?').join(',')

    const clientesIds = (await query(
      `SELECT DISTINCT cliente_id FROM movimientos_cuenta WHERE id_op_encabezado IN (${ph})`, ids
    )).rows.map(r => r.cliente_id)
    if (!clientesIds.length) return {}

    const movs = (await query(
      `SELECT cliente_id, id_op_encabezado, monto FROM movimientos_cuenta
       WHERE cliente_id IN (${clientesIds.map(() => '?').join(',')})
       ORDER BY cliente_id, created_at ASC, id ASC`,
      clientesIds
    )).rows

    const deudas = {} // id_op_encabezado -> { total, pagado }
    let clienteActual = null
    let cola = [] // deudas abiertas del cliente actual, más vieja primero
    for (const m of movs) {
      if (m.cliente_id !== clienteActual) { clienteActual = m.cliente_id; cola = [] }
      const monto = Number(m.monto)
      if (monto < 0) {
        const entrada = { idOp: m.id_op_encabezado, restante: -monto }
        cola.push(entrada)
        if (m.id_op_encabezado) deudas[m.id_op_encabezado] = { total: entrada.restante, pagado: 0 }
      } else if (monto > 0) {
        let disponible = monto
        while (disponible > 1e-6 && cola.length) {
          const cabeza = cola[0]
          const consumido = Math.min(disponible, cabeza.restante)
          cabeza.restante -= consumido
          disponible -= consumido
          if (cabeza.idOp && deudas[cabeza.idOp]) deudas[cabeza.idOp].pagado += consumido
          if (cabeza.restante <= 1e-6) cola.shift()
        }
      }
    }

    const resultado = {}
    for (const id of ids) {
      const d = deudas[id]
      resultado[id] = d ? d.pagado >= d.total - 1e-6 : true
    }
    return resultado
  },

  // Cuánto falta pagar de cada cargo del cliente: { [movimiento_id]: restante }.
  // Los pagos y ajustes a favor se aplican FIFO contra los cargos más viejos (misma
  // regla que saldadaPorOperacion y que el saldo corrido del estado de cuenta).
  async pendientePorCargo(clienteId) {
    const movs = (await query(
      `SELECT id, monto FROM movimientos_cuenta WHERE cliente_id = ? ORDER BY created_at ASC, id ASC`, [clienteId]
    )).rows
    const restante = {}
    const cola = []
    let aFavor = 0 // pagos adelantados: cubren los cargos que vengan después
    for (const m of movs) {
      const monto = Number(m.monto)
      if (monto < 0) {
        const entrada = { id: m.id, resta: -monto }
        const usado = Math.min(aFavor, entrada.resta)
        entrada.resta -= usado
        aFavor -= usado
        restante[m.id] = entrada.resta
        if (entrada.resta > 1e-6) cola.push(entrada)
      } else if (monto > 0) {
        let disponible = monto
        while (disponible > 1e-6 && cola.length) {
          const cabeza = cola[0]
          const usado = Math.min(disponible, cabeza.resta)
          cabeza.resta -= usado
          disponible -= usado
          restante[cabeza.id] = cabeza.resta
          if (cabeza.resta <= 1e-6) cola.shift()
        }
        aFavor += disponible
      }
    }
    Object.keys(restante).forEach(k => { restante[k] = Math.round(restante[k] * 100) / 100 })
    return restante
  },

  // ── Submódulo Cuenta Corriente ────────────────────────────────
  // Aparece en el módulo todo cliente que tenga la cuenta habilitada, O que tenga saldo,
  // O que tenga operaciones a cuenta corriente todavía sin cargo (alquileres en curso).
  // Así una deuda nunca queda escondida porque se deshabilitó la cuenta.
  async listarCuentas() {
    return (await query(`
      SELECT c.*,
             (SELECT COUNT(*) FROM movimientos_cuenta m WHERE m.cliente_id = c.id)::int AS cant_movimientos,
             (${SQL_PENDIENTES_CC})::int AS cant_pendientes
      FROM clientes c
      WHERE c.activo = 1
        AND (c.cuenta_corriente = 1 OR ABS(COALESCE(c.saldo, 0)) > 0.005 OR (${SQL_PENDIENTES_CC}) > 0)
      ORDER BY c.apellido, c.nombre
    `)).rows
  },

  async sinCuenta() {
    return (await query(`
      SELECT c.* FROM clientes c
      WHERE c.activo = 1 AND (c.cuenta_corriente = 0 OR c.cuenta_corriente IS NULL)
        AND ABS(COALESCE(c.saldo, 0)) <= 0.005 AND (${SQL_PENDIENTES_CC}) = 0
      ORDER BY c.apellido, c.nombre
    `)).rows
  },

  // Operaciones a cuenta corriente que todavía no generaron su cargo: alquileres de
  // contenedor en curso (el importe se conoce al cerrar) y de maquinaria antes de
  // iniciar el trabajo. Las ventas generan el cargo apenas se registran.
  async operacionesSinCargo(clienteId) {
    return (await query(`
      SELECT op.id, op.nro_op, op.tipo_op, op.estado, op.fecha_emision, op.fecha_entrega_planificada, op.obra,
             oc.precio_alquiler, dm.precio_total AS precio_maquinaria, maq.nombre AS maquinaria_nombre,
             cont.numero_contenedor
      FROM op_encabezado op
      LEFT JOIN op_detalle_contenedor oc ON oc.id_orden_pedido = op.id
      LEFT JOIN contenedores cont        ON cont.id = oc.id_contenedor
      LEFT JOIN op_detalle_maquinaria dm ON dm.id_orden_pedido = op.id
      LEFT JOIN maquinaria maq           ON maq.id = dm.id_maquinaria
      WHERE op.id_cliente = ? AND ${SQL_OP_SIN_CARGO}
      ORDER BY op.fecha_emision, op.id
    `, [clienteId])).rows
  },

  async deshabilitarCuenta(id) {
    await query(`UPDATE clientes SET cuenta_corriente = 0 WHERE id = ?`, [id])
  },

  // Estado de cuenta de un período: movimientos + saldo inicial/final + totales.
  // Convención de signo: monto < 0 = débito (deuda), monto > 0 = crédito (pago/ajuste a favor).
  async estadoCuenta(clienteId, { desde, hasta } = {}) {
    const wheres = ['cliente_id = ?']
    const params = [clienteId]
    if (desde) { wheres.push('LEFT(created_at, 10) >= ?'); params.push(desde) }
    if (hasta) { wheres.push('LEFT(created_at, 10) <= ?'); params.push(hasta) }
    const movimientos = (await query(
      `SELECT * FROM movimientos_cuenta WHERE ${wheres.join(' AND ')} ORDER BY created_at ASC, id ASC`,
      params
    )).rows

    let saldoInicial = 0
    if (desde) {
      saldoInicial = (await query(
        `SELECT COALESCE(SUM(monto),0) AS s FROM movimientos_cuenta WHERE cliente_id = ? AND LEFT(created_at, 10) < ?`,
        [clienteId, desde]
      )).rows[0]?.s || 0
    }

    let debitos = 0, creditos = 0
    let saldo = saldoInicial
    const filas = movimientos.map(m => {
      if (m.monto < 0) debitos += -m.monto; else creditos += m.monto
      saldo += m.monto
      return { ...m, saldo }
    })
    return { movimientos: filas, saldoInicial, debitos, creditos, saldoFinal: saldo }
  },

  nombreCompleto(c) {
    if (!c) return ''
    return `${c.nombre} ${c.apellido || ''}`.trim()
  },
}

module.exports = ClientesModel
