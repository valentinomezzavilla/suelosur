'use strict'
const crypto = require('crypto')
const { query, transaction } = require('../config/db')

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

  async crear({ nombre, apellido, domicilio_ppal, zona, tel_whatsapp, telefono, email, dni, tipo_cliente, cuenta_corriente }) {
    const numero = await this.proximoNumero()
    const { rows } = await query(`
      INSERT INTO clientes (numero, nombre, apellido, domicilio_ppal, zona, tel_whatsapp, telefono, email, dni, tipo_cliente, cuenta_corriente)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `, [numero, nombre, apellido || '', domicilio_ppal || null, zona || null,
        tel_whatsapp || null, telefono || null, email || null, dni || null,
        tipo_cliente || null, cuenta_corriente ? 1 : 0])
    return rows[0].id
  },

  async actualizar(id, datos) {
    const fields = []
    const values = []
    const map = { nombre:1, apellido:1, domicilio_ppal:1, zona:1, tel_whatsapp:1, telefono:1, email:1, dni:1, tipo_cliente:1 }
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

  async habilitarCuenta(id) {
    await query(`UPDATE clientes SET cuenta_corriente = 1 WHERE id = ?`, [id])
  },

  async agregarMovimiento(id, { tipo, descripcion, monto, metodo_pago }) {
    const { rows } = await query(`INSERT INTO movimientos_cuenta (cliente_id, tipo, descripcion, monto, metodo_pago) VALUES (?, ?, ?, ?, ?) RETURNING id`,
      [id, tipo, descripcion, Number(monto), metodo_pago || null])
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

  // ── Submódulo Cuenta Corriente ────────────────────────────────
  async listarCuentas() {
    return (await query(`SELECT * FROM clientes WHERE activo = 1 AND cuenta_corriente = 1 ORDER BY apellido, nombre`)).rows
  },

  async sinCuenta() {
    return (await query(`SELECT * FROM clientes WHERE activo = 1 AND (cuenta_corriente = 0 OR cuenta_corriente IS NULL) ORDER BY apellido, nombre`)).rows
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
