'use strict'
const crypto = require('crypto')
const db = require('../config/db')

const ClientesModel = {

  listar() {
    return db.prepare(`SELECT * FROM clientes WHERE activo = 1 ORDER BY apellido, nombre`).all()
  },

  obtener(id) {
    return db.prepare(`SELECT * FROM clientes WHERE id = ?`).get(id)
  },

  // Autocomplete: un único término busca en numero/dni/nombre/apellido/razón social.
  // Prioriza coincidencias exactas (N°, DNI, nombre/apellido) y luego orden alfabético.
  buscarLive(q, limit = 8) {
    const s = String(q || '').trim()
    if (!s) return []
    const term = `%${s}%`
    const exact = s.toLowerCase()
    return db.prepare(`
      SELECT * FROM clientes
      WHERE activo = 1 AND (
        nombre LIKE ? OR apellido LIKE ? OR (nombre || ' ' || apellido) LIKE ?
        OR dni LIKE ? OR CAST(numero AS TEXT) LIKE ?
      )
      ORDER BY
        CASE WHEN CAST(numero AS TEXT) = ? OR lower(dni) = ?
                  OR lower(nombre) = ? OR lower(apellido) = ?
                  OR lower(nombre || ' ' || apellido) = ? THEN 0 ELSE 1 END,
        apellido, nombre
      LIMIT ?
    `).all(term, term, term, term, term, exact, exact, exact, exact, exact, limit)
  },

  // Búsqueda estricta: si vienen varios criterios, TODOS deben corresponder al mismo cliente (AND).
  buscar({ id, dni, nombre, numero } = {}) {
    const wheres = []
    const params = []

    const sId = id != null ? String(id).trim() : ''
    const numId = (numero != null && numero !== '') ? numero
                : (sId && /^\d+$/.test(sId)) ? sId : null
    const uuid = (sId && !/^\d+$/.test(sId)) ? sId : null

    if (numId != null) { wheres.push('numero = ?'); params.push(Number(numId)) }
    if (uuid)          { wheres.push('id = ?');     params.push(uuid) }
    if (dni)           { wheres.push('dni = ?');    params.push(String(dni).trim()) }
    if (nombre)        { wheres.push('(nombre LIKE ? OR apellido LIKE ?)'); params.push(`%${nombre}%`, `%${nombre}%`) }

    if (!wheres.length) {
      return db.prepare(`SELECT * FROM clientes WHERE activo = 1 ORDER BY apellido, nombre`).all()
    }
    return db.prepare(`SELECT * FROM clientes WHERE ${wheres.join(' AND ')} ORDER BY apellido, nombre`).all(...params)
  },

  proximoNumero() {
    const r = db.prepare(`SELECT COALESCE(MAX(numero), 0) AS m FROM clientes`).get()
    return (r.m || 0) + 1
  },

  crear({ nombre, apellido, domicilio_ppal, zona, tel_whatsapp, telefono, email, dni, tipo_cliente, cuenta_corriente }) {
    const id = crypto.randomUUID()
    const numero = this.proximoNumero()
    db.prepare(`
      INSERT INTO clientes (id, numero, nombre, apellido, domicilio_ppal, zona, tel_whatsapp, telefono, email, dni, tipo_cliente, cuenta_corriente)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, numero, nombre, apellido || '', domicilio_ppal || null, zona || null,
           tel_whatsapp || null, telefono || null, email || null, dni || null,
           tipo_cliente || null, cuenta_corriente ? 1 : 0)
    return id
  },

  actualizar(id, datos) {
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
    db.prepare(`UPDATE clientes SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  },

  toggleActivo(id) {
    db.prepare(`UPDATE clientes SET activo = NOT activo WHERE id = ?`).run(id)
  },

  // ¿Se puede dar de baja? Revisa operaciones activas, alquileres vigentes y saldo CC.
  puedeEliminar(id) {
    const cli = this.obtener(id)
    if (!cli) return { ok: false, motivo: 'Cliente no encontrado.' }
    if (Math.abs(cli.saldo || 0) > 0.009) {
      return { ok: false, motivo: `Tiene saldo pendiente en cuenta corriente (${cli.saldo < 0 ? 'debe' : 'a favor'} $${Math.abs(cli.saldo).toLocaleString('es-AR')}).` }
    }
    const opsActivas = db.prepare(`
      SELECT COUNT(*) AS n FROM op_encabezado
      WHERE id_cliente = ? AND (estado IN ('pendiente','despachado')
            OR (tipo_op IN ('C','MA') AND estado = 'entregado'))
    `).get(id).n
    if (opsActivas > 0) {
      return { ok: false, motivo: `Tiene ${opsActivas} operación(es) activa(s) o alquiler(es) vigente(s).` }
    }
    return { ok: true }
  },

  eliminar(id) {
    // Baja lógica: conserva historial transaccional
    db.prepare(`UPDATE clientes SET activo = 0 WHERE id = ?`).run(id)
  },

  habilitarCuenta(id) {
    db.prepare(`UPDATE clientes SET cuenta_corriente = 1 WHERE id = ?`).run(id)
  },

  agregarMovimiento(id, { tipo, descripcion, monto }) {
    const movId = crypto.randomUUID()
    db.prepare(`INSERT INTO movimientos_cuenta (id, cliente_id, tipo, descripcion, monto) VALUES (?, ?, ?, ?, ?)`
    ).run(movId, id, tipo, descripcion, Number(monto))
    db.prepare(`UPDATE clientes SET saldo = saldo + ? WHERE id = ?`).run(Number(monto), id)
    return movId
  },

  movimientos(clienteId) {
    return db.prepare(`SELECT * FROM movimientos_cuenta WHERE cliente_id = ? ORDER BY created_at DESC`).all(clienteId)
  },

  // ── Submódulo Cuenta Corriente ────────────────────────────────
  listarCuentas() {
    return db.prepare(`SELECT * FROM clientes WHERE activo = 1 AND cuenta_corriente = 1 ORDER BY apellido, nombre`).all()
  },

  sinCuenta() {
    return db.prepare(`SELECT * FROM clientes WHERE activo = 1 AND (cuenta_corriente = 0 OR cuenta_corriente IS NULL) ORDER BY apellido, nombre`).all()
  },

  deshabilitarCuenta(id) {
    db.prepare(`UPDATE clientes SET cuenta_corriente = 0 WHERE id = ?`).run(id)
  },

  // Estado de cuenta de un período: movimientos + saldo inicial/final + totales.
  // Convención de signo: monto < 0 = débito (deuda), monto > 0 = crédito (pago/ajuste a favor).
  estadoCuenta(clienteId, { desde, hasta } = {}) {
    const wheres = ['cliente_id = ?']
    const params = [clienteId]
    if (desde) { wheres.push('date(created_at) >= date(?)'); params.push(desde) }
    if (hasta) { wheres.push('date(created_at) <= date(?)'); params.push(hasta) }
    const movimientos = db.prepare(
      `SELECT * FROM movimientos_cuenta WHERE ${wheres.join(' AND ')} ORDER BY created_at ASC, id ASC`
    ).all(...params)

    let saldoInicial = 0
    if (desde) {
      saldoInicial = db.prepare(
        `SELECT COALESCE(SUM(monto),0) AS s FROM movimientos_cuenta WHERE cliente_id = ? AND date(created_at) < date(?)`
      ).get(clienteId, desde).s
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
