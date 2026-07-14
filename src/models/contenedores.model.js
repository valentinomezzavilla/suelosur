'use strict'
const { query, transaction } = require('../config/db')

const SQL_ULTIMO_MOV = `
  SELECT m.* FROM (
    SELECT m.*, ROW_NUMBER() OVER (PARTITION BY id_contenedor ORDER BY fecha_movimiento DESC, id DESC) AS rn
    FROM movimiento_contenedor m
  ) m WHERE m.rn = 1
`

const ContenedoresModel = {

  async listar({ estado_paso, estado_general, q, registro } = {}) {
    const wheres = []
    const params = []
    // Registro: por defecto solo activos; 'baja' solo dados de baja; 'todos' ambos.
    if (registro === 'baja')       wheres.push('c.activo = 0')
    else if (registro !== 'todos') wheres.push('c.activo = 1')
    if (estado_general) { wheres.push('c.estado_general = ?'); params.push(estado_general) }
    if (estado_paso)    { wheres.push('um.estado_paso = ?');   params.push(estado_paso) }
    // Búsqueda: si es puramente numérica, filtra por N° de contenedor u OP (exacto,
    // así "5" trae el contenedor 5 y no todo lo que contenga un 5). Si tiene letras,
    // busca texto libre en el resto de los datos.
    if (q && String(q).trim()) {
      const term = String(q).trim()
      if (/^\d+$/.test(term)) {
        wheres.push(`(CAST(c.numero_contenedor AS TEXT) = ? OR COALESCE(CAST(op.nro_op AS TEXT), '') = ?)`)
        params.push(term, term)
      } else {
        const like = `%${term}%`
        wheres.push(`(
          COALESCE(c.observaciones, '')      ILIKE ?
          OR COALESCE(c.estado_general, '')  ILIKE ?
          OR COALESCE(um.estado_paso, '')    ILIKE ?
          OR COALESCE(cli.nombre, '')        ILIKE ?
          OR COALESCE(oc.domicilio_entrega, '') ILIKE ?
          OR COALESCE(oc.zona_entrega, '')   ILIKE ?
        )`)
        for (let i = 0; i < 6; i++) params.push(like)
      }
    }
    return (await query(`
      SELECT c.id, c.numero_contenedor, c.estado_general, c.fecha_ultima_pintada,
             c.observaciones, c.activo, um.estado_paso, um.fecha_movimiento,
             oc.domicilio_entrega, oc.zona_entrega, oc.plazo_alquiler,
             cli.nombre AS cliente_nombre, op.nro_op,
             (CURRENT_DATE - LEFT(um.fecha_movimiento, 10)::date) AS dias_en_estado
      FROM contenedores c
      LEFT JOIN (${SQL_ULTIMO_MOV}) um ON um.id_contenedor = c.id
      LEFT JOIN op_detalle_contenedor oc ON oc.id = um.id_op_contenedor
      LEFT JOIN op_encabezado op ON op.id = oc.id_orden_pedido
      LEFT JOIN clientes cli ON cli.id = op.id_cliente
      ${wheres.length ? 'WHERE ' + wheres.join(' AND ') : ''} ORDER BY c.numero_contenedor
    `, params)).rows
  },

  async obtener(id) {
    const c = (await query(`SELECT * FROM contenedores WHERE id = ?`, [id])).rows[0]
    if (!c) return null
    c.movimientos = (await query(`
      SELECT m.*, u.nombre AS chofer_nombre, f.patente AS camion_patente, f.nombre AS camion_nombre,
             op.nro_op, cli.nombre AS cliente_nombre, oc.domicilio_entrega, oc.zona_entrega
      FROM movimiento_contenedor m
      LEFT JOIN users u ON u.id = m.id_chofer
      LEFT JOIN flota_vehiculos f ON f.id = m.id_camion
      LEFT JOIN op_detalle_contenedor oc ON oc.id = m.id_op_contenedor
      LEFT JOIN op_encabezado op ON op.id = oc.id_orden_pedido
      LEFT JOIN clientes cli ON cli.id = op.id_cliente
      WHERE m.id_contenedor = ? ORDER BY m.fecha_movimiento DESC, m.id DESC
    `, [id])).rows

    // Historial de ALQUILERES: un renglón por operación (OP) que usó este contenedor.
    const alq = (await query(`
      SELECT op.nro_op, op.estado AS op_estado, cli.nombre AS cliente_nombre,
             oc.domicilio_entrega, oc.zona_entrega, oc.precio_alquiler, oc.plazo_alquiler,
             op.fecha_entrega_planificada,
             (SELECT MIN(fecha_movimiento) FROM movimiento_contenedor mm
                WHERE mm.id_op_contenedor = oc.id AND mm.estado_paso = 'en_alquiler') AS fecha_inicio,
             (SELECT MIN(fecha_movimiento) FROM movimiento_contenedor mm
                WHERE mm.id_op_contenedor = oc.id AND mm.estado_paso = 'disponible') AS fecha_fin
      FROM op_detalle_contenedor oc
      JOIN op_encabezado op ON op.id = oc.id_orden_pedido
      LEFT JOIN clientes cli ON cli.id = op.id_cliente
      WHERE oc.id_contenedor = ? AND op.tipo_op = 'C' AND op.estado <> 'anulado'
    `, [id])).rows
    alq.sort((a, b) => String(b.fecha_inicio || b.fecha_entrega_planificada || '')
      .localeCompare(String(a.fecha_inicio || a.fecha_entrega_planificada || '')))
    c.alquileres = alq

    return c
  },

  async obtenerPorNumero(numero) {
    return (await query(`SELECT * FROM contenedores WHERE numero_contenedor = ?`, [numero])).rows[0]
  },

  // Próximo número de contenedor disponible (para mostrarlo en el formulario)
  async proximoNumero() {
    const r = (await query(`SELECT COALESCE(MAX(numero_contenedor), 0) + 1 AS n FROM contenedores`)).rows[0]
    return parseInt(r.n) || 1
  },

  // El número es autoincrementable: se calcula dentro de la transacción
  // para evitar duplicados ante creaciones simultáneas.
  async crear({ estado_general, fecha_ultima_pintada, observaciones } = {}) {
    return await transaction(async (q) => {
      const numero = parseInt((await q(`SELECT COALESCE(MAX(numero_contenedor), 0) + 1 AS n FROM contenedores`)).rows[0].n) || 1
      const { rows } = await q(`INSERT INTO contenedores (numero_contenedor, estado_general, fecha_ultima_pintada, observaciones) VALUES (?, ?, ?, ?) RETURNING id`,
        [numero, estado_general || 'operativo', fecha_ultima_pintada || null, observaciones || ''])
      const id = rows[0].id
      await q(`INSERT INTO movimiento_contenedor (id_contenedor, estado_paso, observaciones) VALUES (?, 'disponible', 'Alta inicial')`,
        [id])
      return { id, numero }
    })
  },

  // El número de contenedor es inmutable (autoincrementable): no se actualiza.
  async actualizar(id, { estado_general, fecha_ultima_pintada, observaciones }) {
    await query(`UPDATE contenedores SET estado_general = ?, fecha_ultima_pintada = ?, observaciones = ? WHERE id = ?`,
      [estado_general || 'operativo', fecha_ultima_pintada || null, observaciones || '', id])
  },

  async toggleActivo(id) {
    await query(`UPDATE contenedores SET activo = 1 - activo WHERE id = ?`, [id])
  },

  async registrarMovimiento({ id_contenedor, id_op_contenedor, id_chofer, id_camion, estado_paso, observaciones, fecha_movimiento }) {
    await query(`
      INSERT INTO movimiento_contenedor (id_contenedor, id_op_contenedor, id_chofer, id_camion, fecha_movimiento, estado_paso, observaciones)
      VALUES (?, ?, ?, ?, COALESCE(?, to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')), ?, ?)
    `, [id_contenedor, id_op_contenedor || null,
        id_chofer || null, id_camion || null, fecha_movimiento || null,
        estado_paso, observaciones || ''])
  },

  async disponibles() {
    return (await query(`
      SELECT c.id, c.numero_contenedor FROM contenedores c
      JOIN (${SQL_ULTIMO_MOV}) um ON um.id_contenedor = c.id
      WHERE c.activo = 1 AND c.estado_general = 'operativo' AND um.estado_paso = 'disponible'
      ORDER BY c.numero_contenedor
    `)).rows
  },

  async resumenPorEstado() {
    return (await query(`
      SELECT um.estado_paso, COUNT(*) AS total FROM contenedores c
      JOIN (${SQL_ULTIMO_MOV}) um ON um.id_contenedor = c.id
      WHERE c.activo = 1 GROUP BY um.estado_paso
    `)).rows
  },

  async circuitoDiario() {
    return (await query(`
      SELECT c.id, c.numero_contenedor, um.estado_paso, ma.fecha_alquiler AS fecha_movimiento,
             oc.id AS id_op_contenedor, oc.domicilio_entrega, oc.zona_entrega, oc.plazo_alquiler,
             cli.nombre AS cliente_nombre, cli.tel_whatsapp, op.nro_op,
             (CURRENT_DATE - LEFT(ma.fecha_alquiler, 10)::date) AS dias_en_domicilio,
             ((CURRENT_DATE - LEFT(ma.fecha_alquiler, 10)::date) - oc.plazo_alquiler) AS dias_excedidos
      FROM contenedores c
      JOIN (${SQL_ULTIMO_MOV}) um ON um.id_contenedor = c.id
      JOIN op_detalle_contenedor oc ON oc.id = um.id_op_contenedor
      JOIN op_encabezado op ON op.id = oc.id_orden_pedido
      JOIN clientes cli ON cli.id = op.id_cliente
      JOIN (
        SELECT DISTINCT ON (id_contenedor) id_contenedor, fecha_movimiento AS fecha_alquiler
        FROM movimiento_contenedor WHERE estado_paso = 'en_alquiler'
        ORDER BY id_contenedor, fecha_movimiento ASC
      ) ma ON ma.id_contenedor = c.id
      WHERE c.activo = 1 AND um.estado_paso IN ('en_alquiler','pendiente_retiro')
        AND (CURRENT_DATE - LEFT(ma.fecha_alquiler, 10)::date) >= oc.plazo_alquiler
      ORDER BY oc.zona_entrega, dias_excedidos DESC
    `)).rows
  },

  async choferes() {
    return (await query(`SELECT id, nombre FROM users WHERE rol = 'chofer' AND activo = 1 ORDER BY nombre`)).rows
  },

  async camiones() {
    return (await query(`SELECT id, patente, nombre FROM flota_vehiculos WHERE tipo_vehiculo = 'camion' AND activo = 1 ORDER BY nombre`)).rows
  },
}

module.exports = ContenedoresModel
