'use strict'
const { query, transaction } = require('../config/db')
const { SQL_SIGUIENTE_NRO_OP } = require('../utils/numeracion')
const FlotaModel = require('./flota.model')
const ConfigContenedoresModel = require('./config_contenedores.model')
const TransaccionesModel = require('./transacciones.model')
const ClientesModel = require('./clientes.model')
const { textoDestino, numeroSinRepetirCalle } = require('../utils/destino')
const { sumarDiasHabiles } = require('../utils/diasHabiles')

// Nombre completo del cliente (nombre + apellido) — mismo criterio que en
// contenedores.model.js: antes se mostraba solo el nombre de pila.
const nombreCompleto = (alias) => `NULLIF(TRIM(COALESCE(${alias}.nombre,'') || ' ' || COALESCE(${alias}.apellido,'')), '')`

const SQL_ULTIMO_MOV = `
  SELECT m.* FROM (
    SELECT m.*, ROW_NUMBER() OVER (PARTITION BY id_contenedor ORDER BY fecha_movimiento DESC, id DESC) AS rn
    FROM movimiento_contenedor m
  ) m WHERE m.rn = 1
`

// Movimiento 'en_alquiler' más antiguo por contenedor (= inicio real del período)
const SQL_MOV_ALQUILER = `
  SELECT DISTINCT ON (id_contenedor) id_contenedor, fecha_movimiento AS fecha_alquiler
  FROM movimiento_contenedor WHERE estado_paso = 'en_alquiler'
  ORDER BY id_contenedor, fecha_movimiento ASC
`

// Igual que el anterior pero por operación: un contenedor con historial tuvo varios
// alquileres, y cada uno arrancó en su propia entrega.
const SQL_MOV_ALQUILER_OP = `
  SELECT DISTINCT ON (id_op_contenedor) id_op_contenedor, fecha_movimiento AS fecha_alquiler
  FROM movimiento_contenedor
  WHERE estado_paso = 'en_alquiler' AND id_op_contenedor IS NOT NULL
  ORDER BY id_op_contenedor, fecha_movimiento ASC
`

// Fecha en que el contenedor de una OP dejó el domicilio del cliente (texto de
// fecha_movimiento), o NULL si sigue afuera:
//  - el 'disponible' de ESTA OP para su contenedor ACTUAL (retiro a planta). Con "Reponer",
//    la unidad vieja tiene su propio 'disponible', pero cuenta la unidad nueva;
//  - si el contenedor pasó directo al próximo alquiler encadenado, el primer movimiento
//    atribuido a otra OP después del último de esta.
// Los movimientos manuales (sin OP) no cuentan: no dicen que el contenedor se retiró.
// Alias: oc = op_detalle_contenedor.
const SQL_FECHA_CIERRE_OP = `COALESCE(
  (SELECT MIN(mc.fecha_movimiento) FROM movimiento_contenedor mc
    WHERE mc.id_contenedor = oc.id_contenedor AND mc.id_op_contenedor = oc.id AND mc.estado_paso = 'disponible'),
  (SELECT mc.fecha_movimiento FROM movimiento_contenedor mc
    WHERE mc.id_contenedor = oc.id_contenedor AND mc.id_op_contenedor IS NOT NULL AND mc.id_op_contenedor <> oc.id
      AND mc.id > (SELECT MAX(mp.id) FROM movimiento_contenedor mp WHERE mp.id_contenedor = oc.id_contenedor AND mp.id_op_contenedor = oc.id)
    ORDER BY mc.id LIMIT 1))`

// Una OP de un alquiler agrupado está ABIERTA mientras no terminó su ciclo: sin entregar
// (pendiente o despachada, o todavía sin contenedor), o entregada y sin fecha de cierre
// (ver SQL_FECHA_CIERRE_OP). Las anuladas nunca están abiertas.
// Alias: op = op_encabezado, oc = op_detalle_contenedor.
const SQL_OP_ABIERTA = `(op.estado <> 'anulado' AND (op.estado IN ('pendiente', 'despachado')
  OR oc.id_contenedor IS NULL OR ${SQL_FECHA_CIERRE_OP} IS NULL))`

// plazo_alquiler NULL = alquiler sin fecha de fin definida. Hay que distinguirlo del
// "no vino nada" (que toma el default), por eso no alcanza con `parseInt(x) || n`.
function normalizarPlazo(plazo, porDefecto) {
  if (plazo === null) return null                              // sin fecha de fin
  if (plazo === undefined || plazo === '') return porDefecto   // no vino: default
  const n = parseInt(plazo, 10)
  return Number.isNaN(n) ? porDefecto : n
}

// Dirección normalizada para comparar si cambió (espacios y mayúsculas no cuentan).
const normDir = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase()

// precio_alquiler NULL = alquiler sin precio (todavía no se le asignó). No es lo mismo que
// $0 (un precio cero a propósito), por eso no alcanza con `parseFloat(x) || 0`.
function precioONull(precio) {
  if (precio === null || precio === undefined || String(precio).trim() === '') return null
  const n = parseFloat(precio)
  return Number.isFinite(n) ? n : null
}

// Tarifa por días vigente: de 1 a 8 días se cobra por día; desde los 9 días (o sin días
// que contar) el precio base.
function tarifaPorDias(dias, cfg) {
  return (dias != null && dias > 0 && dias < 9) ? dias * cfg.precioDia : cfg.precioAlquiler
}

// Métodos de pago reales: con ellos se asigna el precio de un alquiler sin precio y se carga
// uno histórico ya terminado. 'a_convenir' no está: es justamente no haber resuelto todavía
// cómo se paga.
const METODOS_PAGO = ['efectivo', 'transferencia', 'cheque', 'cuenta_corriente', 'saldo_a_favor']

const AlquileresModel = {

  METODOS_PAGO,

  // Auto-vence alquileres: los que llegaron a su fecha fin (plazo contado en DÍAS
  // HÁBILES desde la entrega) y siguen 'en_alquiler' pasan automáticamente a
  // 'pendiente_retiro' ("Pendiente Retiro"). Idempotente (una vez marcado, ya no vuelve a
  // matchear). Se llama al abrir el listado/detalle de Alquileres y de Contenedores.
  async autoVencerAlquileres() {
    await query(`
      INSERT INTO movimiento_contenedor (id_contenedor, id_op_contenedor, estado_paso, observaciones)
      SELECT lm.id_contenedor, lm.id_op_contenedor, 'pendiente_retiro', 'Vencimiento automático del alquiler'
      FROM (${SQL_ULTIMO_MOV}) lm
      JOIN op_detalle_contenedor oc ON oc.id = lm.id_op_contenedor
      JOIN op_encabezado op ON op.id = oc.id_orden_pedido
      JOIN (${SQL_MOV_ALQUILER}) ma ON ma.id_contenedor = lm.id_contenedor
      WHERE op.tipo_op = 'C' AND op.estado = 'entregado'
        AND lm.estado_paso = 'en_alquiler'
        AND oc.plazo_alquiler IS NOT NULL
        AND sumar_dias_habiles(COALESCE(LEFT(op.fecha_entrega_planificada, 10)::date, LEFT(ma.fecha_alquiler, 10)::date), oc.plazo_alquiler) <= CURRENT_DATE
    `)
  },

  async listarPorEstado({ q } = {}) {
    // Búsqueda libre por N° de OP, remito o cliente — mismo criterio que ventas/transacciones.
    let filtroWhere = ''
    const filtroParams = []
    if (q && String(q).trim()) {
      const term = `%${String(q).trim()}%`
      filtroWhere = ` AND (CAST(op.nro_op AS TEXT) ILIKE ? OR CAST(op.nro_remito AS TEXT) ILIKE ? OR cli.nombre ILIKE ? OR cli.apellido ILIKE ?)`
      filtroParams.push(term, term, term, term)
    }
    // Para calcular fechas de alquiler usamos el movimiento 'en_alquiler' (inicio del período)
    const baseSelect = `
      SELECT op.id, op.nro_op, op.nro_remito, op.estado, op.fecha_emision, op.fecha_entrega_planificada, op.obra,
             op.id_grupo,
             (SELECT COUNT(*) FROM op_encabezado g WHERE g.id_grupo = op.id_grupo AND g.estado <> 'anulado')::int AS grupo_cant,
             ${nombreCompleto('cli')} AS cliente_nombre, cli.tel_whatsapp,
             oc.id AS id_op_contenedor, oc.domicilio_entrega, oc.zona_entrega,
             oc.plazo_alquiler, oc.precio_alquiler, oc.id_contenedor,
             cont.numero_contenedor,
             um.estado_paso AS contenedor_estado, um.fecha_movimiento AS fecha_ultimo_mov,
             ma.fecha_alquiler AS fecha_entrega_real,
             sumar_dias_habiles(COALESCE(LEFT(op.fecha_entrega_planificada, 10)::date, LEFT(ma.fecha_alquiler, 10)::date), oc.plazo_alquiler) AS fecha_fin_estimada,
             (sumar_dias_habiles(COALESCE(LEFT(op.fecha_entrega_planificada, 10)::date, LEFT(ma.fecha_alquiler, 10)::date), oc.plazo_alquiler) - CURRENT_DATE) AS dias_restantes,
             (CURRENT_DATE - LEFT(um.fecha_movimiento, 10)::date) AS dias_en_estado
      FROM op_encabezado op
      JOIN clientes cli ON cli.id = op.id_cliente
      LEFT JOIN op_detalle_contenedor oc ON oc.id_orden_pedido = op.id
      LEFT JOIN contenedores cont ON cont.id = oc.id_contenedor
      -- El último movimiento tiene que ser DE ESTA operación: si no, las ops viejas de
      -- un contenedor con historial se cuelan como si siguieran en curso.
      LEFT JOIN (${SQL_ULTIMO_MOV}) um
             ON um.id_contenedor = oc.id_contenedor AND um.id_op_contenedor = oc.id
      LEFT JOIN (${SQL_MOV_ALQUILER_OP}) ma ON ma.id_op_contenedor = oc.id
      WHERE op.tipo_op = 'C'${filtroWhere}
    `
    const todosEnCurso = (await query(`${baseSelect}
      AND op.estado = 'entregado' AND um.estado_paso IN ('en_alquiler','pendiente_retiro')
      ORDER BY fecha_fin_estimada ASC`, filtroParams)).rows
    // "Por finalizar" son los que vencen hoy/mañana (o ya están en pendiente_retiro).
    const esPorFinalizar = a => a.contenedor_estado === 'pendiente_retiro'
      || (a.dias_restantes != null && a.dias_restantes <= 1)
    // Un mismo contenedor físico solo puede estar en un alquiler a la vez: si hay
    // varias ops activas para el mismo contenedor, dejamos una sola (la más urgente),
    // priorizando "por finalizar". Así no se duplica ni aparece en dos tablas.
    const masUrgente = (a, b) => {
      const pa = esPorFinalizar(a), pb = esPorFinalizar(b)
      if (pa !== pb) return pa // por finalizar gana
      return (a.dias_restantes ?? 9999) < (b.dias_restantes ?? 9999)
    }
    const porContenedor = new Map()
    for (const a of todosEnCurso) {
      const key = a.id_contenedor != null ? `c${a.id_contenedor}` : `op${a.id}`
      const prev = porContenedor.get(key)
      if (!prev || masUrgente(a, prev)) porContenedor.set(key, a)
    }
    const unicos = [...porContenedor.values()]
    const porFinalizar = unicos.filter(esPorFinalizar)
    const actuales     = unicos.filter(a => !esPorFinalizar(a))
    const programados  = (await query(`${baseSelect}
      AND op.estado IN ('pendiente','despachado')
      ORDER BY op.fecha_entrega_planificada ASC NULLS LAST, op.created_at ASC`, filtroParams)).rows
    return { actuales, porFinalizar, programados }
  },

  async obtener(id) {
    const op = (await query(`
      SELECT op.*, ${nombreCompleto('cli')} AS cliente_nombre, cli.tel_whatsapp, cli.domicilio_ppal,
             u.nombre AS administrativo_nombre
      FROM op_encabezado op
      JOIN clientes cli ON cli.id = op.id_cliente
      JOIN users    u   ON u.id  = op.id_administrativo
      WHERE op.id = ? AND op.tipo_op = 'C'
    `, [id])).rows[0]
    if (!op) return null

    op.detalle = (await query(`
      SELECT oc.*, cont.numero_contenedor, cont.estado_general
      FROM op_detalle_contenedor oc LEFT JOIN contenedores cont ON cont.id = oc.id_contenedor
      WHERE oc.id_orden_pedido = ? LIMIT 1
    `, [id])).rows[0]

    if (op.detalle?.id_contenedor) {
      op.movimientos = (await query(`
        SELECT m.*, u.nombre AS chofer_nombre, f.patente AS camion_patente
        FROM movimiento_contenedor m
        LEFT JOIN users u ON u.id = m.id_chofer
        LEFT JOIN flota_vehiculos f ON f.id = m.id_camion
        WHERE m.id_contenedor = ? AND m.id_op_contenedor = ?
        ORDER BY m.fecha_movimiento ASC, m.id ASC
      `, [op.detalle.id_contenedor, op.detalle.id])).rows

      op.estadoContenedor = (await query(`
        SELECT estado_paso, fecha_movimiento FROM movimiento_contenedor
        WHERE id_contenedor = ? ORDER BY fecha_movimiento DESC, id DESC LIMIT 1
      `, [op.detalle.id_contenedor])).rows[0]

      const movEntrega = (await query(`
        SELECT fecha_movimiento FROM movimiento_contenedor
        WHERE id_contenedor = ? AND id_op_contenedor = ? AND estado_paso = 'en_alquiler'
        ORDER BY fecha_movimiento ASC LIMIT 1
      `, [op.detalle.id_contenedor, op.detalle.id])).rows[0]
      op.diasEnDomicilio = movEntrega
        ? Math.floor((Date.now() - new Date(movEntrega.fecha_movimiento).getTime()) / 86400000)
        : null
      // Fin de alquiler = fecha de inicio (la que se edita) + plazo (días).
      // Base: fecha_entrega_planificada (inicio editable); si falta, la entrega real.
      const baseInicio = (op.fecha_entrega_planificada && String(op.fecha_entrega_planificada).slice(0, 10))
        || (movEntrega && String(movEntrega.fecha_movimiento).slice(0, 10))
      // Sin plazo definido no hay fecha de fin: el alquiler sigue por tiempo indeterminado.
      const sinPlazo = op.detalle.plazo_alquiler == null
      if (baseInicio && !sinPlazo) {
        op.fechaFinAlquiler = sumarDiasHabiles(baseInicio, op.detalle.plazo_alquiler)
        const hoy = new Date(); hoy.setHours(0, 0, 0, 0)
        const fin = new Date(op.fechaFinAlquiler + 'T00:00:00')
        op.diasRestantes = Math.round((fin - hoy) / 86400000)
      } else {
        op.fechaFinAlquiler = null; op.diasRestantes = null
      }
    } else {
      op.movimientos = []; op.estadoContenedor = null; op.diasEnDomicilio = null
      op.fechaFinAlquiler = null; op.diasRestantes = null
    }
    op.grupo = op.id_grupo ? await this.grupoDe(op.id) : null
    return op
  },

  // Alquiler agrupado al que pertenece la OP (null si es de un solo contenedor), con todas
  // sus OP: estado, contenedor, días restantes, si está abierta y si ya se cobró.
  async grupoDe(id_op) {
    const g = (await query(`
      SELECT ag.id, ag.cobro_modo FROM op_encabezado op
      JOIN alquiler_grupos ag ON ag.id = op.id_grupo
      WHERE op.id = ?
    `, [id_op])).rows[0]
    if (!g) return null
    g.ops = (await query(`
      SELECT op.id, op.nro_op, op.estado, oc.id_contenedor, cont.numero_contenedor,
             CASE WHEN um.id_op_contenedor = oc.id THEN um.estado_paso END AS contenedor_estado,
             (sumar_dias_habiles(COALESCE(NULLIF(LEFT(op.fecha_entrega_planificada, 10), '')::date, LEFT(ma.fecha_alquiler, 10)::date), oc.plazo_alquiler) - CURRENT_DATE) AS dias_restantes,
             ${SQL_OP_ABIERTA} AS abierta,
             ${SQL_FECHA_CIERRE_OP} AS fecha_cierre,
             oc.precio_alquiler,
             EXISTS (SELECT 1 FROM transacciones t WHERE t.id_op_encabezado = op.id) AS cobrada
      FROM op_encabezado op
      JOIN op_detalle_contenedor oc ON oc.id_orden_pedido = op.id
      LEFT JOIN contenedores cont ON cont.id = oc.id_contenedor
      LEFT JOIN (${SQL_ULTIMO_MOV}) um ON um.id_contenedor = oc.id_contenedor
      LEFT JOIN (${SQL_MOV_ALQUILER_OP}) ma ON ma.id_op_contenedor = oc.id
      WHERE op.id_grupo = ?
      ORDER BY op.id
    `, [g.id])).rows
    g.abiertas = g.ops.filter(o => o.abierta).length
    return g
  },

  // ¿El contenedor está ocupado? (último movimiento no 'disponible' O hay una op activa sin cerrar)
  // `q` permite hacer el chequeo dentro de la transacción del alta (crearGrupo).
  async contenedorOcupado(id_contenedor, q = query) {
    if (!id_contenedor) return false
    const r = (await q(`
      SELECT 1 FROM (
        SELECT DISTINCT ON (id_contenedor) id_contenedor, estado_paso
        FROM movimiento_contenedor ORDER BY id_contenedor, fecha_movimiento DESC, id DESC
      ) lm WHERE lm.id_contenedor = ? AND lm.estado_paso <> 'disponible'
      UNION
      SELECT 1 FROM op_detalle_contenedor oc
      JOIN op_encabezado op ON op.id = oc.id_orden_pedido
      WHERE oc.id_contenedor = ? AND op.tipo_op = 'C' AND op.estado IN ('pendiente','despachado')
    `, [id_contenedor, id_contenedor])).rows[0]
    return !!r
  },

  // Inserta UNA operación de alquiler de contenedor (encabezado + detalle + movimiento)
  // con el cliente de transacción `q`. La usan el alta de un contenedor (crear,
  // crearEnCurso) y la de varios (crearGrupo), para que las dos hagan exactamente lo mismo.
  //  - enCurso = false → 'pendiente', contenedor reservado ('pendiente_despacho').
  //  - enCurso = true  → 'entregado', contenedor ya en el domicilio ('en_alquiler'); el
  //    inicio real queda en fecha_entrega_planificada (y en fecha_emision).
  async _insertarAlquiler(q, d, { enCurso = false } = {}) {
    const { nro } = (await q(`SELECT ${SQL_SIGUIENTE_NRO_OP} AS nro`)).rows[0]
    const { rows } = enCurso
      ? await q(`
          INSERT INTO op_encabezado (id_cliente, id_administrativo, tipo_op, nro_op, nro_remito, estado, metodo_pago, observaciones, fecha_emision, fecha_entrega_planificada, obra, id_grupo)
          VALUES (?, ?, 'C', ?, ?, 'entregado', ?, ?, ?, ?, ?, ?) RETURNING id
        `, [d.id_cliente, d.id_administrativo, nro, d.nro_remito, d.metodo_pago || null, d.observaciones || '',
            d.fecha_inicio || null, d.fecha_inicio || null, d.obra || null, d.id_grupo || null])
      : await q(`
          INSERT INTO op_encabezado (id_cliente, id_administrativo, tipo_op, nro_op, nro_remito, estado, metodo_pago, observaciones, fecha_entrega_planificada, id_chofer, id_camion, obra, id_grupo)
          VALUES (?, ?, 'C', ?, ?, 'pendiente', ?, ?, ?, ?, ?, ?, ?) RETURNING id
        `, [d.id_cliente, d.id_administrativo, nro, d.nro_remito, d.metodo_pago || null, d.observaciones || '',
            d.fecha_entrega_planificada || null, d.id_chofer || null, d.id_camion || null, d.obra || null, d.id_grupo || null])
    const id_op = rows[0].id
    const { rows: detRows } = await q(`
      INSERT INTO op_detalle_contenedor (id_orden_pedido, id_contenedor, domicilio_entrega, domicilio_calle, domicilio_numero, zona_entrega, plazo_alquiler, precio_alquiler, metodo_pago)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
    `, [id_op, d.id_contenedor || null, d.domicilio_entrega || '', d.domicilio_calle || null, d.domicilio_numero || null,
        d.zona_entrega || '', normalizarPlazo(d.plazo_alquiler, 5), precioONull(d.precio_alquiler), d.metodo_pago || null])
    if (d.id_contenedor) {
      await q(`INSERT INTO movimiento_contenedor (id_contenedor, id_op_contenedor, estado_paso, observaciones) VALUES (?, ?, ?, ?)`,
        [d.id_contenedor, detRows[0].id,
         enCurso ? 'en_alquiler' : 'pendiente_despacho',
         enCurso ? 'Alquiler en curso cargado — el contenedor ya estaba en el domicilio' : 'Contenedor reservado para despacho'])
    }
    return { id: id_op, nro_op: nro, id_oc: detRows[0].id }
  },

  async crear(datos) {
    if (datos.id_contenedor && await this.contenedorOcupado(datos.id_contenedor)) {
      throw new Error('Ese contenedor ya está alquilado o reservado en otra operación. Para programar el próximo alquiler, usá "próximos a finalizar".')
    }
    const { nro_rem: nroSiguiente } = (await query(`SELECT COALESCE(MAX(nro_remito), 0) + 1 AS nro_rem FROM op_encabezado`)).rows[0]
    const nro_rem = datos.nro_remito || nroSiguiente
    return await transaction(async (q) => {
      const r = await this._insertarAlquiler(q, { ...datos, nro_remito: nro_rem }, { enCurso: false })
      return { id: r.id, nro_op: r.nro_op, nro_remito: nro_rem }
    })
  },

  // Alquiler de VARIOS contenedores: un grupo y una OP por contenedor, todo en una sola
  // transacción. Si un contenedor ya no se puede reservar (o está repetido), no se crea
  // ninguna OP. Comparten cliente, dirección, remito, método de pago y fechas; cada
  // contenedor trae su plazo y su precio. Las OP quedan en orden de id: la primera es la
  // principal del grupo (ahí se ancla el cargo de cuenta corriente del cobro por alquiler).
  async crearGrupo({ cobro_modo, en_curso = false, contenedores, nro_remito, ...comunes }) {
    if (!Array.isArray(contenedores) || contenedores.length < 2) {
      throw new Error('Un alquiler agrupado necesita al menos dos contenedores.')
    }
    const ids = contenedores.map(c => String(c.id_contenedor))
    if (new Set(ids).size !== ids.length) throw new Error('Elegiste el mismo contenedor más de una vez.')
    const base = { ...comunes, fecha_entrega_planificada: comunes.fecha_entrega_planificada ?? comunes.fecha_inicio }
    return await transaction(async (q) => {
      for (const c of contenedores) {
        if (await this.contenedorOcupado(c.id_contenedor, q)) {
          const n = (await q(`SELECT numero_contenedor FROM contenedores WHERE id = ?`, [c.id_contenedor])).rows[0]?.numero_contenedor
          throw new Error(`El contenedor N° ${n ?? c.id_contenedor} ya está alquilado o reservado en otra operación. No se creó ningún alquiler.`)
        }
      }
      const nro_rem = nro_remito || (await q(`SELECT COALESCE(MAX(nro_remito), 0) + 1 AS n FROM op_encabezado`)).rows[0].n
      const { id: id_grupo } = (await q(`INSERT INTO alquiler_grupos (cobro_modo) VALUES (?) RETURNING id`,
        [cobro_modo === 'alquiler' ? 'alquiler' : 'contenedor'])).rows[0]
      const ops = []
      for (const c of contenedores) {
        const r = await this._insertarAlquiler(q, {
          ...base, nro_remito: nro_rem, id_grupo,
          id_contenedor: c.id_contenedor, plazo_alquiler: c.plazo_alquiler, precio_alquiler: c.precio_alquiler,
        }, { enCurso: !!en_curso })
        ops.push({ ...r, id_contenedor: c.id_contenedor, precio_alquiler: precioONull(c.precio_alquiler) })
      }
      return { id_grupo, nro_remito: nro_rem, ops }
    })
  },

  async asignarContenedor(id_op, id_contenedor) {
    const oc = (await query(`UPDATE op_detalle_contenedor SET id_contenedor = ? WHERE id_orden_pedido = ? RETURNING id`, [id_contenedor, id_op])).rows[0]
    if (oc) {
      await query(`INSERT INTO movimiento_contenedor (id_contenedor, id_op_contenedor, estado_paso, observaciones) VALUES (?, ?, 'pendiente_despacho', 'Contenedor asignado — pendiente de despacho')`,
        [id_contenedor, oc.id])
    }
  },

  // Edición de los datos comerciales / de entrega del alquiler.
  // Devuelve { direccionCambio }: si cambió la calle o el número, las coordenadas
  // guardadas ya no sirven — se borran acá y quien llama vuelve a geocodificar.
  // Un alquiler SIN precio no se edita por acá: su precio y su método de pago se asignan en
  // Cobranzas → Asignar precio (con la validación de cuenta corriente), así que la edición
  // no los toca (y sobre todo no le pone un $0 por no venir en el formulario).
  async actualizar(id_op, { calle, numero: numeroForm, zona_entrega, plazo_alquiler, precio_alquiler, metodo_pago, observaciones, fecha_entrega_planificada, obra }) {
    const numero = numeroSinRepetirCalle(calle, numeroForm)
    const domicilio_entrega = `${calle || ''} ${numero}`.trim()
    const previo = (await query(`SELECT domicilio_calle, domicilio_numero, precio_alquiler FROM op_detalle_contenedor WHERE id_orden_pedido = ? LIMIT 1`, [id_op])).rows[0]
    const direccionCambio = !!previo
      && (normDir(previo.domicilio_calle) !== normDir(calle) || normDir(previo.domicilio_numero) !== normDir(numero))
    const sinPrecio = !!previo && previo.precio_alquiler == null
    await transaction(async (q) => {
      await q(sinPrecio
        ? `UPDATE op_encabezado SET observaciones = ?, fecha_entrega_planificada = ?, obra = ? WHERE id = ?`
        : `UPDATE op_encabezado SET observaciones = ?, fecha_entrega_planificada = ?, obra = ?, metodo_pago = ? WHERE id = ?`,
        [observaciones || '', fecha_entrega_planificada || null, (obra || '').trim() || null,
         ...(sinPrecio ? [] : [metodo_pago || null]), id_op])
      await q(sinPrecio
        ? `
          UPDATE op_detalle_contenedor
          SET domicilio_entrega = ?, domicilio_calle = ?, domicilio_numero = ?, zona_entrega = ?, plazo_alquiler = ?
          WHERE id_orden_pedido = ?`
        : `
          UPDATE op_detalle_contenedor
          SET domicilio_entrega = ?, domicilio_calle = ?, domicilio_numero = ?, zona_entrega = ?, plazo_alquiler = ?,
              precio_alquiler = ?, metodo_pago = ?
          WHERE id_orden_pedido = ?`,
        [domicilio_entrega, calle || null, numero || null, zona_entrega || '', normalizarPlazo(plazo_alquiler, 5),
         ...(sinPrecio ? [] : [parseFloat(precio_alquiler) || 0, metodo_pago || null]), id_op])
      if (direccionCambio) {
        await q(`UPDATE op_detalle_contenedor SET domicilio_lat = NULL, domicilio_lng = NULL, geo_estado = NULL, geo_detalle = NULL, geo_actualizado_en = NULL WHERE id_orden_pedido = ?`, [id_op])
      }
    })
    return { direccionCambio }
  },

  // Datos compartidos del alquiler agrupado (dirección, obra, zona, método de pago y
  // observaciones): los copia de esta OP a las demás OP del grupo que siguen vivas. Plazo,
  // precio y fechas son de cada contenedor y no se tocan. Si cambia la dirección de una
  // OP, se borran sus coordenadas (las vuelve a llenar ubicar). Devuelve cuántas actualizó.
  //  - No toca las OP ya cobradas (su método tiene que seguir coincidiendo con su cobro)
  //    ni, con cobro por contenedor, las ya retiradas: una retirada "a convenir" espera
  //    en Cobranzas y cambiarle el método la sacaría de ahí sin cobrarla. Con cobro por
  //    alquiler las retiradas sin cobrar sí se actualizan: se cobran todas juntas al final.
  //  - Un método vacío no pisa el de las otras (el formulario puede no traerlo).
  //  - Un contenedor SIN precio no recibe método de pago: se asigna junto con el precio
  //    (Cobranzas → Asignar precio).
  async actualizarCompartidosGrupo(id_op) {
    return await transaction(async (q) => {
      const src = (await q(`
        SELECT op.id_grupo, op.metodo_pago, op.observaciones, op.obra,
               oc.domicilio_entrega, oc.domicilio_calle, oc.domicilio_numero, oc.zona_entrega
        FROM op_encabezado op JOIN op_detalle_contenedor oc ON oc.id_orden_pedido = op.id
        WHERE op.id = ?
      `, [id_op])).rows[0]
      if (!src?.id_grupo) return 0
      const otras = (await q(`
        SELECT op.id, (oc.precio_alquiler IS NULL) AS sin_precio FROM op_encabezado op
        JOIN op_detalle_contenedor oc ON oc.id_orden_pedido = op.id
        JOIN alquiler_grupos ag ON ag.id = op.id_grupo
        WHERE op.id_grupo = ? AND op.id <> ? AND op.estado <> 'anulado'
          AND NOT EXISTS (SELECT 1 FROM transacciones t WHERE t.id_op_encabezado = op.id)
          AND (ag.cobro_modo = 'alquiler' OR ${SQL_OP_ABIERTA})
        ORDER BY op.id
      `, [src.id_grupo, id_op])).rows
      for (const { id, sin_precio } of otras) {
        const metodo = sin_precio ? null : src.metodo_pago
        const previo = (await q(`SELECT domicilio_calle, domicilio_numero FROM op_detalle_contenedor WHERE id_orden_pedido = ?`, [id])).rows[0]
        await q(`UPDATE op_encabezado SET metodo_pago = COALESCE(NULLIF(?, ''), metodo_pago), observaciones = ?, obra = ? WHERE id = ?`,
          [metodo, src.observaciones, src.obra, id])
        await q(`
          UPDATE op_detalle_contenedor
          SET domicilio_entrega = ?, domicilio_calle = ?, domicilio_numero = ?, zona_entrega = ?,
              metodo_pago = COALESCE(NULLIF(?, ''), metodo_pago)
          WHERE id_orden_pedido = ?
        `, [src.domicilio_entrega, src.domicilio_calle, src.domicilio_numero, src.zona_entrega, metodo, id])
        if (normDir(previo?.domicilio_calle) !== normDir(src.domicilio_calle) || normDir(previo?.domicilio_numero) !== normDir(src.domicilio_numero)) {
          await q(`UPDATE op_detalle_contenedor SET domicilio_lat = NULL, domicilio_lng = NULL, geo_estado = NULL, geo_detalle = NULL, geo_actualizado_en = NULL WHERE id_orden_pedido = ?`, [id])
        }
      }
      return otras.length
    })
  },

  // ── Mapa de contenedores ──────────────────────────────────────

  async guardarUbicacion(id_op, { lat, lng, estado, detalle }) {
    await query(`
      UPDATE op_detalle_contenedor
      SET domicilio_lat = ?, domicilio_lng = ?, geo_estado = ?, geo_detalle = ?,
          geo_actualizado_en = ahora_local()
      WHERE id_orden_pedido = ?
    `, [lat ?? null, lng ?? null, estado, detalle || null, id_op])
  },

  // Copia las coordenadas de una OP a las demás OP de su grupo que tienen la misma
  // dirección: un alquiler agrupado se geocodifica una sola vez. Las que se editaron con
  // otra dirección no se tocan.
  async copiarUbicacionAlGrupo(id_op) {
    await query(`
      UPDATE op_detalle_contenedor oc
      SET domicilio_lat = src.domicilio_lat, domicilio_lng = src.domicilio_lng,
          geo_estado = src.geo_estado, geo_detalle = src.geo_detalle, geo_actualizado_en = src.geo_actualizado_en
      FROM op_detalle_contenedor src
      JOIN op_encabezado op_src ON op_src.id = src.id_orden_pedido
      JOIN op_encabezado op ON op.id_grupo = op_src.id_grupo
      WHERE src.id_orden_pedido = ? AND op_src.id_grupo IS NOT NULL
        AND oc.id_orden_pedido = op.id AND op.id <> op_src.id
        AND LOWER(TRIM(COALESCE(oc.domicilio_calle, ''))) = LOWER(TRIM(COALESCE(src.domicilio_calle, '')))
        AND LOWER(TRIM(COALESCE(oc.domicilio_numero, ''))) = LOWER(TRIM(COALESCE(src.domicilio_numero, '')))
    `, [id_op])
  },

  // Geocodifica la dirección del alquiler (OpenStreetMap) y guarda el resultado, salga
  // bien o mal: si falla queda sin coordenadas y aparece en "sin ubicar" del mapa.
  async ubicar(id_op) {
    const { geocodificarDireccion } = require('../services/geocoding.service')
    const oc = (await query(`
      SELECT oc.domicilio_calle, oc.domicilio_numero, op.obra
      FROM op_detalle_contenedor oc JOIN op_encabezado op ON op.id = oc.id_orden_pedido
      WHERE oc.id_orden_pedido = ? LIMIT 1
    `, [id_op])).rows[0]
    if (!oc) return null
    const geo = await geocodificarDireccion({ calle: oc.domicilio_calle, numero: oc.domicilio_numero, obra: oc.obra })
    await this.guardarUbicacion(id_op, geo)
    await this.copiarUbicacionAlGrupo(id_op)
    return geo
  },

  // Alquileres para el mapa, con las coordenadas ya guardadas (no geocodifica nada):
  //  - en curso: entregados y con el contenedor todavía en el domicilio ('en_alquiler'
  //    o 'pendiente_retiro') — mismo criterio que la tabla "en curso";
  //  - programados: pendientes de iniciar ('pendiente' / 'despachado').
  // dias_restantes se calcula igual que en listarPorEstado (plazo en días hábiles).
  async datosMapa() {
    return (await query(`
      SELECT op.id, op.nro_op, op.obra, ${nombreCompleto('cli')} AS cliente_nombre,
             oc.domicilio_entrega, oc.domicilio_calle, oc.domicilio_numero, oc.zona_entrega,
             oc.domicilio_lat AS lat, oc.domicilio_lng AS lng, oc.geo_estado, oc.geo_detalle,
             op.estado AS op_estado, cont.numero_contenedor, um.estado_paso AS contenedor_estado,
             to_char(COALESCE(NULLIF(LEFT(op.fecha_entrega_planificada, 10), '')::date, LEFT(ma.fecha_alquiler, 10)::date), 'YYYY-MM-DD') AS fecha_inicio,
             (sumar_dias_habiles(COALESCE(NULLIF(LEFT(op.fecha_entrega_planificada, 10), '')::date, LEFT(ma.fecha_alquiler, 10)::date), oc.plazo_alquiler) - CURRENT_DATE) AS dias_restantes
      FROM op_encabezado op
      JOIN clientes cli ON cli.id = op.id_cliente
      JOIN op_detalle_contenedor oc ON oc.id_orden_pedido = op.id
      LEFT JOIN (${SQL_ULTIMO_MOV}) um ON um.id_contenedor = oc.id_contenedor AND um.id_op_contenedor = oc.id
      LEFT JOIN contenedores cont ON cont.id = oc.id_contenedor
      LEFT JOIN (${SQL_MOV_ALQUILER_OP}) ma ON ma.id_op_contenedor = oc.id
      WHERE op.tipo_op = 'C'
        AND (op.estado IN ('pendiente','despachado')
             OR (op.estado = 'entregado' AND um.estado_paso IN ('en_alquiler','pendiente_retiro')))
      ORDER BY cont.numero_contenedor NULLS LAST
    `)).rows
  },

  async despachar(id_op) {
    const oc = (await query(`SELECT id, id_contenedor FROM op_detalle_contenedor WHERE id_orden_pedido = ? LIMIT 1`, [id_op])).rows[0]
    if (!oc?.id_contenedor) throw new Error('No hay contenedor asignado.')
    await transaction(async (q) => {
      await q(`UPDATE op_encabezado SET estado = 'despachado' WHERE id = ? AND estado = 'pendiente'`, [id_op])
      await q(`INSERT INTO movimiento_contenedor (id_contenedor, id_op_contenedor, estado_paso, observaciones) VALUES (?, ?, 'despachado', 'Salida a entregar')`,
        [oc.id_contenedor, oc.id])
    })
    await FlotaModel.setEnUso(await FlotaModel.camionDeOperacion(id_op), true)
  },

  async entregar(id_op) {
    const oc = (await query(`SELECT id, id_contenedor FROM op_detalle_contenedor WHERE id_orden_pedido = ? LIMIT 1`, [id_op])).rows[0]
    if (!oc?.id_contenedor) throw new Error('No hay contenedor asignado.')
    await transaction(async (q) => {
      await q(`UPDATE op_encabezado SET estado = 'entregado' WHERE id = ? AND estado IN ('pendiente','despachado')`, [id_op])
      await q(`INSERT INTO movimiento_contenedor (id_contenedor, id_op_contenedor, estado_paso, observaciones) VALUES (?, ?, 'en_alquiler', 'Contenedor en domicilio — alquiler iniciado')`,
        [oc.id_contenedor, oc.id])
    })
    await FlotaModel.setEnUso(await FlotaModel.camionDeOperacion(id_op), false)
  },

  // Admin marca que el contenedor está listo para retirar (espera al chofer)
  async registrarRetiro(id_op) {
    const oc = (await query(`SELECT id, id_contenedor FROM op_detalle_contenedor WHERE id_orden_pedido = ? LIMIT 1`, [id_op])).rows[0]
    if (!oc?.id_contenedor) throw new Error('No hay contenedor asignado.')
    await query(`INSERT INTO movimiento_contenedor (id_contenedor, id_op_contenedor, estado_paso, observaciones) VALUES (?, ?, 'pendiente_retiro', 'Pendiente retiro por el chofer')`,
      [oc.id_contenedor, oc.id])
  },

  // Chofer inicia el retiro: sale a buscar el contenedor. El contenedor sigue en
  // 'pendiente_retiro' (recién queda disponible cuando el retiro se completa); el
  // "retiro en curso" se marca en la operación.
  async iniciarRetiro(id_op) {
    const oc = (await query(`SELECT id, id_contenedor FROM op_detalle_contenedor WHERE id_orden_pedido = ? LIMIT 1`, [id_op])).rows[0]
    if (!oc?.id_contenedor) throw new Error('No hay contenedor asignado.')
    await query(`UPDATE op_encabezado SET retiro_iniciado_en = ahora_local() WHERE id = ?`, [id_op])
    await FlotaModel.setEnUso(await FlotaModel.camionDeOperacion(id_op), true)
  },

  // ¿El chofer ya salió a hacer este retiro?
  async retiroEnCurso(id_op) {
    const op = (await query(`SELECT retiro_iniciado_en FROM op_encabezado WHERE id = ?`, [id_op])).rows[0]
    return !!op?.retiro_iniciado_en
  },

  async devolverAPlanta(id_op) {
    const oc = (await query(`SELECT id, id_contenedor FROM op_detalle_contenedor WHERE id_orden_pedido = ? LIMIT 1`, [id_op])).rows[0]
    if (!oc?.id_contenedor) throw new Error('No hay contenedor asignado.')
    await query(`INSERT INTO movimiento_contenedor (id_contenedor, id_op_contenedor, estado_paso, observaciones) VALUES (?, ?, 'disponible', 'Contenedor retirado — disponible')`,
      [oc.id_contenedor, oc.id])
    await query(`UPDATE op_encabezado SET retiro_iniciado_en = NULL WHERE id = ?`, [id_op])
    await FlotaModel.setEnUso(await FlotaModel.camionDeOperacion(id_op), false)
  },

  // Repone el contenedor de un alquiler EN CURSO por una unidad nueva, elegida
  // automáticamente entre las disponibles (la misma lista que se ofrece al dar de alta
  // un alquiler). La operación no se toca — mismas fechas, plazo, precio y cliente —,
  // solo cambia qué contenedor físico la cubre: el viejo vuelve a quedar disponible.
  async reponerContenedor(id_op) {
    const op = (await query(`
      SELECT op.estado, oc.id AS id_oc, oc.id_contenedor, cont.numero_contenedor
      FROM op_encabezado op
      JOIN op_detalle_contenedor oc ON oc.id_orden_pedido = op.id
      LEFT JOIN contenedores cont ON cont.id = oc.id_contenedor
      WHERE op.id = ? LIMIT 1
    `, [id_op])).rows[0]
    if (!op || !op.id_contenedor) throw new Error('Este alquiler no tiene un contenedor asignado.')
    if (op.estado !== 'entregado') throw new Error('Solo se puede reponer un alquiler en curso.')
    const estadoActual = (await query(
      `SELECT estado_paso FROM movimiento_contenedor WHERE id_contenedor = ? ORDER BY fecha_movimiento DESC, id DESC LIMIT 1`,
      [op.id_contenedor])).rows[0]?.estado_paso
    if (estadoActual !== 'en_alquiler') throw new Error('El contenedor no está en curso: no se puede reponer.')

    const { disponibles } = await this.contenedoresDisponibles()
    const reemplazo = disponibles[0]
    if (!reemplazo) throw new Error('No hay contenedores disponibles para la reposición.')

    await transaction(async (q) => {
      await q(`INSERT INTO movimiento_contenedor (id_contenedor, id_op_contenedor, estado_paso, observaciones) VALUES (?, ?, 'disponible', ?)`,
        [op.id_contenedor, op.id_oc, `Repuesto por el contenedor N° ${reemplazo.numero_contenedor}`])
      await q(`UPDATE op_detalle_contenedor SET id_contenedor = ? WHERE id = ?`, [reemplazo.id, op.id_oc])
      await q(`INSERT INTO movimiento_contenedor (id_contenedor, id_op_contenedor, estado_paso, observaciones) VALUES (?, ?, 'en_alquiler', ?)`,
        [reemplazo.id, op.id_oc, `Reposición — reemplaza al contenedor N° ${op.numero_contenedor}`])
    })

    return { numeroAnterior: op.numero_contenedor, numeroNuevo: reemplazo.numero_contenedor }
  },

  // ¿La operación (retiro) tiene un alquiler programado siguiente para el mismo contenedor?
  async proximoAlquiler(id_op) {
    const oc = (await query(`SELECT alquiler_siguiente_id FROM op_detalle_contenedor WHERE id_orden_pedido = ? LIMIT 1`, [id_op])).rows[0]
    if (!oc?.alquiler_siguiente_id) return null
    return (await query(`
      SELECT op.id, op.nro_op, ${nombreCompleto('cli')} AS cliente_nombre, oc.domicilio_entrega
      FROM op_encabezado op
      JOIN clientes cli ON cli.id = op.id_cliente
      LEFT JOIN op_detalle_contenedor oc ON oc.id_orden_pedido = op.id
      WHERE op.id = ? AND op.estado != 'anulado'
    `, [oc.alquiler_siguiente_id])).rows[0] || null
  },

  // El chofer retira el contenedor y, en vez de volver a planta, lo lleva
  // directo al próximo alquiler programado (se despacha con el mismo camión/chofer).
  async iniciarProximoAlquiler(id_op) {
    const ocA = (await query(`SELECT id, id_contenedor, alquiler_siguiente_id FROM op_detalle_contenedor WHERE id_orden_pedido = ? LIMIT 1`, [id_op])).rows[0]
    if (!ocA?.id_contenedor) throw new Error('No hay contenedor asignado.')
    if (!ocA.alquiler_siguiente_id) throw new Error('No hay un alquiler programado siguiente.')
    const idB = ocA.alquiler_siguiente_id
    const opA = (await query(`SELECT id_chofer, id_camion FROM op_encabezado WHERE id = ?`, [id_op])).rows[0]
    return await transaction(async (q) => {
      // El contenedor lo lleva el chofer que hizo el retiro: se le asigna la op siguiente.
      await q(`
        UPDATE op_encabezado
        SET estado = 'despachado', estado_programacion = 'activo',
            id_chofer = COALESCE(?, id_chofer), id_camion = COALESCE(?, id_camion)
        WHERE id = ? AND estado IN ('pendiente','despachado')
      `, [opA?.id_chofer || null, opA?.id_camion || null, idB])
      const ocB = (await q(`SELECT id, id_contenedor FROM op_detalle_contenedor WHERE id_orden_pedido = ? LIMIT 1`, [idB])).rows[0]
      if (!ocB) throw new Error('El alquiler siguiente no tiene detalle de contenedor.')
      if (!ocB.id_contenedor) {
        await q(`UPDATE op_detalle_contenedor SET id_contenedor = ? WHERE id = ?`, [ocA.id_contenedor, ocB.id])
        ocB.id_contenedor = ocA.id_contenedor
      }
      // El contenedor pasa directo a "despachado" (en camino) para el próximo alquiler.
      await q(`INSERT INTO movimiento_contenedor (id_contenedor, id_op_contenedor, estado_paso, observaciones) VALUES (?, ?, 'despachado', 'Retirado del cliente anterior — en camino al próximo alquiler')`,
        [ocB.id_contenedor, ocB.id])
      // El retiro de la operación anterior quedó completado.
      await q(`UPDATE op_encabezado SET retiro_iniciado_en = NULL WHERE id = ?`, [id_op])
      return idB
    })
  },

  async anular(id_op) {
    const oc = (await query(`SELECT id, id_contenedor FROM op_detalle_contenedor WHERE id_orden_pedido = ? LIMIT 1`, [id_op])).rows[0]
    await query(`UPDATE op_encabezado SET estado = 'anulado' WHERE id = ? AND estado IN ('pendiente','despachado')`, [id_op])
    if (oc?.id_contenedor) {
      const ec = (await query(`SELECT estado_paso FROM movimiento_contenedor WHERE id_contenedor = ? ORDER BY fecha_movimiento DESC, id DESC LIMIT 1`, [oc.id_contenedor])).rows[0]?.estado_paso
      if (ec && ['pendiente_despacho','despachado'].includes(ec)) {
        await query(`INSERT INTO movimiento_contenedor (id_contenedor, id_op_contenedor, estado_paso, observaciones) VALUES (?, ?, 'disponible', 'Alquiler anulado — contenedor disponible')`,
          [oc.id_contenedor, oc.id])
      }
    }
  },

  // Anula todas las OP del grupo que todavía se pueden anular (pendientes o despachadas);
  // las ya entregadas siguen su curso. Devuelve cuántas anuló.
  async anularGrupo(id_op) {
    const grupo = await this.grupoDe(id_op)
    if (!grupo) throw new Error('Este alquiler no es de varios contenedores.')
    const anulables = grupo.ops.filter(o => o.estado === 'pendiente' || o.estado === 'despachado')
    for (const o of anulables) await this.anular(o.id)
    return anulables.length
  },

  // Agrupa alquileres YA cargados por separado en un alquiler agrupado (ej. dos alquileres
  // idénticos cargados a mano antes de que existiera esta opción). Solo alquileres de
  // contenedor del mismo cliente, sin anular, sin grupo y sin cobrar. Con simular = true
  // hace todas las validaciones y no escribe nada.
  async agruparExistentes(nrosOp, cobroModo = 'contenedor', { simular = false } = {}) {
    const nros = [...new Set((nrosOp || []).map(n => parseInt(n, 10)).filter(Number.isFinite))]
    if (nros.length < 2) throw new Error('Indicá al menos dos N° de OP para agrupar.')
    return await transaction(async (q) => {
      const ops = (await q(`
        SELECT op.id, op.nro_op, op.id_cliente, op.estado, op.id_grupo, op.tipo_op, op.metodo_pago, op.nro_remito,
               oc.domicilio_entrega, cont.numero_contenedor,
               (oc.id IS NOT NULL AND NOT ${SQL_OP_ABIERTA}) AS retirado,
               EXISTS (SELECT 1 FROM transacciones t WHERE t.id_op_encabezado = op.id) AS cobrada
        FROM op_encabezado op
        LEFT JOIN op_detalle_contenedor oc ON oc.id_orden_pedido = op.id
        LEFT JOIN contenedores cont ON cont.id = oc.id_contenedor
        WHERE op.nro_op = ANY(?::int[]) ORDER BY op.id FOR UPDATE OF op
      `, [nros])).rows
      const nombre = (n) => 'OP-' + String(n).padStart(4, '0')
      const faltan = nros.filter(n => !ops.some(o => o.nro_op === n))
      if (faltan.length) throw new Error(`No existe ${faltan.map(nombre).join(', ')}.`)
      for (const o of ops) {
        if (o.tipo_op !== 'C') throw new Error(`${nombre(o.nro_op)} no es un alquiler de contenedor.`)
        if (o.estado === 'anulado') throw new Error(`${nombre(o.nro_op)} está anulada.`)
        if (o.id_grupo) throw new Error(`${nombre(o.nro_op)} ya pertenece a un alquiler agrupado.`)
        if (o.cobrada) throw new Error(`${nombre(o.nro_op)} ya se cobró: no se puede agrupar.`)
      }
      if (new Set(ops.map(o => String(o.id_cliente))).size > 1) throw new Error('Las OP son de clientes distintos.')
      // Cobro por alquiler: el grupo se cobra entero con el método de la OP principal, así
      // que todas tienen que tener el mismo (si no, una quedaría cobrada con otro método).
      const metodos = [...new Set(ops.map(o => o.metodo_pago || 'sin especificar'))]
      if (cobroModo === 'alquiler' && metodos.length > 1) {
        throw new Error(`Las OP tienen métodos de pago distintos (${ops.map(o => `${nombre(o.nro_op)}: ${o.metodo_pago || 'sin especificar'}`).join(', ')}). Para cobrar por alquiler tienen que tener el mismo: corregilo en cada OP o agrupalas con cobro por contenedor.`)
      }
      // El detalle sirve para revisar la simulación antes de confirmar.
      const resumen = ops.map(o => ({
        id: o.id, nro_op: o.nro_op, estado: o.estado, numero_contenedor: o.numero_contenedor,
        metodo_pago: o.metodo_pago, retirado: !!o.retirado, domicilio_entrega: o.domicilio_entrega, nro_remito: o.nro_remito,
      }))
      if (simular) return { simulado: true, ops: resumen }
      const { id } = (await q(`INSERT INTO alquiler_grupos (cobro_modo) VALUES (?) RETURNING id`,
        [cobroModo === 'alquiler' ? 'alquiler' : 'contenedor'])).rows[0]
      await q(`UPDATE op_encabezado SET id_grupo = ? WHERE id = ANY(?::bigint[])`, [id, ops.map(o => o.id)])
      return { id_grupo: id, ops: resumen }
    })
  },

  async clientes() {
    return (await query(`SELECT id, nombre FROM clientes WHERE activo = 1 ORDER BY nombre`)).rows
  },

  async contenedoresDisponibles() {
    // Un contenedor está disponible cuando su último movimiento es 'disponible' y además
    // no tiene otro alquiler ya cargado sin entregar (si no, contenedorOcupado lo rechaza
    // al confirmar y el usuario lo elige para nada).
    const disponibles = (await query(`
      SELECT c.id, c.numero_contenedor FROM contenedores c
      JOIN (${SQL_ULTIMO_MOV}) um ON um.id_contenedor = c.id
      WHERE c.activo = 1 AND c.estado_general = 'operativo'
        AND um.estado_paso = 'disponible'
        AND NOT EXISTS (
          SELECT 1 FROM op_detalle_contenedor oc2
          JOIN op_encabezado op2 ON op2.id = oc2.id_orden_pedido
          WHERE oc2.id_contenedor = c.id AND op2.tipo_op = 'C'
            AND op2.estado IN ('pendiente', 'despachado')
        )
      ORDER BY c.numero_contenedor
    `)).rows

    const porLiberar = (await query(`
      SELECT c.id, c.numero_contenedor,
             op.id AS alquiler_actual_id, op.nro_op,
             ${nombreCompleto('cli')} AS cliente_actual,
             oc.plazo_alquiler,
             to_char(sumar_dias_habiles(LEFT(ma.fecha_alquiler, 10)::date, oc.plazo_alquiler), 'YYYY-MM-DD') AS fecha_liberacion,
             (sumar_dias_habiles(LEFT(ma.fecha_alquiler, 10)::date, oc.plazo_alquiler) - CURRENT_DATE) * 24 AS horas_restantes
      FROM contenedores c
      JOIN (${SQL_ULTIMO_MOV}) um ON um.id_contenedor = c.id
      JOIN op_detalle_contenedor oc ON oc.id_contenedor = c.id AND oc.id = um.id_op_contenedor
      JOIN op_encabezado op ON op.id = oc.id_orden_pedido
      JOIN clientes cli ON cli.id = op.id_cliente
      JOIN (
        SELECT DISTINCT ON (id_contenedor) id_contenedor, fecha_movimiento AS fecha_alquiler
        FROM movimiento_contenedor WHERE estado_paso = 'en_alquiler'
        ORDER BY id_contenedor, fecha_movimiento ASC
      ) ma ON ma.id_contenedor = c.id
      WHERE c.activo = 1
        AND c.estado_general = 'operativo'
        AND um.estado_paso IN ('en_alquiler','pendiente_retiro')
        AND oc.alquiler_siguiente_id IS NULL
        -- Sin fecha de fin no se sabe cuándo se libera: no se puede encadenar un próximo alquiler
        AND oc.plazo_alquiler IS NOT NULL
      ORDER BY horas_restantes ASC
    `)).rows

    return { disponibles, porLiberar }
  },

  async crearProgramado({ id_cliente, id_administrativo, domicilio_entrega, domicilio_calle, domicilio_numero, zona_entrega, plazo_alquiler, precio_alquiler, id_contenedor, metodo_pago, observaciones, alquiler_actual_id, fecha_entrega_planificada, obra, nro_remito }) {
    const tieneProximoAlquiler = (await query(`
      SELECT 1 FROM op_detalle_contenedor oc
      JOIN op_encabezado op ON op.id = oc.id_orden_pedido
      WHERE oc.id_contenedor = ? AND oc.alquiler_siguiente_id IS NOT NULL AND op.estado != 'anulado'
    `, [id_contenedor])).rows[0]
    if (tieneProximoAlquiler) throw new Error('Este contenedor ya tiene un alquiler programado.')

    const { nro }         = (await query(`SELECT ${SQL_SIGUIENTE_NRO_OP} AS nro`)).rows[0]
    const { nro_rem: nroSiguiente } = (await query(`SELECT COALESCE(MAX(nro_remito), 0) + 1 AS nro_rem FROM op_encabezado`)).rows[0]
    const nro_rem = nro_remito || nroSiguiente
    return await transaction(async (q) => {
      const { rows } = await q(`
        INSERT INTO op_encabezado (id_cliente, id_administrativo, tipo_op, nro_op, nro_remito, estado, estado_programacion, metodo_pago, observaciones, fecha_entrega_planificada, obra)
        VALUES (?, ?, 'C', ?, ?, 'pendiente', 'programado', ?, ?, ?, ?)
        RETURNING id
      `, [id_cliente, id_administrativo, nro, nro_rem, metodo_pago || null, observaciones || '', fecha_entrega_planificada || null, obra || null])
      const id_op = rows[0].id

      await q(`
        INSERT INTO op_detalle_contenedor (id_orden_pedido, id_contenedor, domicilio_entrega, domicilio_calle, domicilio_numero, zona_entrega, plazo_alquiler, precio_alquiler, metodo_pago)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [id_op, id_contenedor, domicilio_entrega || '',
          domicilio_calle || null, domicilio_numero || null,
          zona_entrega || '', normalizarPlazo(plazo_alquiler, 5), precioONull(precio_alquiler),
          metodo_pago || null])

      await q(`
        UPDATE op_detalle_contenedor SET alquiler_siguiente_id = ?
        WHERE id_orden_pedido = ? AND id_contenedor = ?
      `, [id_op, alquiler_actual_id, id_contenedor])

      return { id: id_op, nro_op: nro, nro_remito: nro_rem }
    })
  },

  // Carga de un alquiler que YA ESTÁ EN CURSO: arrancó antes de hoy y el contenedor
  // está en el domicilio del cliente. Se crea directamente como 'entregado', ocupando
  // el contenedor, sin pasar por despacho ni generar tareas de chofer.
  // El movimiento se registra con la fecha de hoy (es cuando se toma conocimiento);
  // el inicio real del alquiler queda en fecha_entrega_planificada.
  async crearEnCurso(datos) {
    if (datos.id_contenedor && await this.contenedorOcupado(datos.id_contenedor)) {
      throw new Error('Ese contenedor ya está alquilado o reservado en otra operación.')
    }
    const { nro_rem: nroSiguiente } = (await query(`SELECT COALESCE(MAX(nro_remito), 0) + 1 AS nro_rem FROM op_encabezado`)).rows[0]
    const nro_rem = datos.nro_remito || nroSiguiente
    return await transaction(async (q) => {
      const r = await this._insertarAlquiler(q, { ...datos, nro_remito: nro_rem }, { enCurso: true })
      return { id: r.id, nro_op: r.nro_op, nro_remito: nro_rem }
    })
  },

  // Datos para cerrar el alquiler y cobrarlo: el precio pactado al inicio (que puede
  // ser de hace meses) y el sugerido con la tarifa vigente hoy. El cobro se hace al
  // retirar el contenedor, no al entregarlo.
  // `alRetiro`: contar los días hasta el día en que se retiró el contenedor de ESTA OP
  // (si ya se retiró) en vez de hasta hoy. Lo usa el cobro por alquiler de un grupo, que
  // cobra todo junto al retirar el último: cada contenedor tiene que contar solo sus días.
  // `q`: leer con el cliente de una transacción en curso (para ver lo que ella escribió).
  //
  // Qué se cobra al cerrar (precioACobrar):
  //  - alquiler con precio ASIGNADO en Cobranzas (precio_asignado_en): ese precio;
  //  - alquiler con precio de alta (los viejos): la tarifa por días de hoy (precioActual),
  //    y el precio de alta queda como referencia;
  //  - alquiler SIN precio (sinPrecio): no hay nada que cobrar hasta que se le asigne uno.
  // precioSugerido es lo que se propone al asignar el precio.
  async datosCierre(id_op, { alRetiro = false, q = query } = {}) {
    const op = (await q(`
      SELECT op.fecha_entrega_planificada, op.obra, oc.precio_alquiler, oc.precio_asignado_en, oc.plazo_alquiler,
             oc.domicilio_entrega, oc.domicilio_calle, oc.domicilio_numero, cont.numero_contenedor,
             ${SQL_FECHA_CIERRE_OP} AS fecha_cierre
      FROM op_encabezado op
      JOIN op_detalle_contenedor oc ON oc.id_orden_pedido = op.id
      LEFT JOIN contenedores cont ON cont.id = oc.id_contenedor
      WHERE op.id = ? LIMIT 1
    `, [id_op])).rows[0]
    if (!op) return null

    const precioInicial = parseFloat(op.precio_alquiler) || 0
    const sinPrecio = op.precio_alquiler == null
    const precioAsignado = op.precio_asignado_en != null
    const cfg = await ConfigContenedoresModel.obtenerPrecios()

    // Días reales que estuvo afuera, desde el inicio cargado hasta hoy (o hasta el retiro)
    const inicio = op.fecha_entrega_planificada ? String(op.fecha_entrega_planificada).slice(0, 10) : null
    let dias = null
    if (inicio) {
      const hasta = (alRetiro && op.fecha_cierre)
        ? new Date(String(op.fecha_cierre).slice(0, 10) + 'T00:00:00')
        : new Date(new Date().setHours(0, 0, 0, 0))
      dias = Math.max(0, Math.round((hasta - new Date(inicio + 'T00:00:00')) / 86400000))
    }
    // Tarifa vigente: el precio base a partir del plazo largo, o por día si fue corto
    const precioActual = tarifaPorDias(dias, cfg)
    // Sugerido al asignar el precio: el plazo cargado en el alta (con las ampliaciones) a la
    // tarifa por días. Un alquiler sin fecha de fin no tiene plazo: se usan los días reales.
    const precioSugerido = op.plazo_alquiler > 0 ? tarifaPorDias(op.plazo_alquiler, cfg) : precioActual

    const MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre']
    let mesInicio = null
    if (inicio) {
      const [a, m] = inicio.split('-')
      mesInicio = `${MESES[Number(m) - 1]} ${a}`
    }
    return {
      precioInicial, precioActual, dias, inicio, mesInicio,
      sinPrecio, precioAsignado, precioSugerido, plazo: op.plazo_alquiler,
      precioACobrar: precioAsignado ? precioInicial : precioActual,
      numero_contenedor: op.numero_contenedor, domicilio_entrega: op.domicilio_entrega,
      destino: textoDestino({ domicilio: op.domicilio_entrega, calle: op.domicilio_calle, numero: op.domicilio_numero, obra: op.obra }),
      // Distinto = conviene mostrar el precio de referencia entre paréntesis. Un precio
      // asignado es el que se cobra, así que no hay referencia que mostrar.
      cambioDePrecio: !precioAsignado && precioInicial > 0 && Math.round(precioInicial) !== Math.round(precioActual),
    }
  },

  // Grupo con cobro "por alquiler" al que pertenece la OP, o null.
  async grupoConCobroPorAlquiler(id_op) {
    return (await query(`
      SELECT ag.id FROM op_encabezado op
      JOIN alquiler_grupos ag ON ag.id = op.id_grupo
      WHERE op.id = ? AND ag.cobro_modo = 'alquiler'
    `, [id_op])).rows[0] || null
  },

  // Cobro de un alquiler agrupado "por alquiler". Cobra solo cuando no queda ninguna OP
  // abierta (se retiró el último contenedor). Devuelve null sin tocar nada si falta
  // retirar alguno, si es "a convenir" y no viene el método, si algún contenedor no tiene
  // precio todavía (se cobra cuando se le asigne) o si ya estaba cobrado.
  //  - Una transacción por OP, cada una con su monto (la facturación, el borrado y el
  //    control de "ya cobrada" funcionan por operación).
  //  - UN solo movimiento de cuenta corriente / saldo a favor por el total, anclado a la
  //    OP principal (la de menor id), con el detalle de contenedores en la descripción.
  // Todo en una transacción y con el grupo bloqueado (FOR UPDATE): un doble clic, o el
  // chofer y la oficina cerrando a la vez, no pueden cobrar dos veces.
  // `montos`: { [id_op]: monto } para ajustar el precio de cierre de cada contenedor.
  // `q`: cliente de una transacción ya abierta (asignarPrecioGrupo cobra en la misma
  // transacción en la que asigna los precios); sin él, abre la suya.
  async cobrarGrupo(id_grupo, { montos = {}, metodoPagoFinal = null, q: qExterno = null } = {}) {
    const cobrar = async (q) => {
      await q(`SELECT id FROM alquiler_grupos WHERE id = ? FOR UPDATE`, [id_grupo])
      const ops = (await q(`
        SELECT op.id, op.nro_op, op.nro_remito, op.id_cliente, op.metodo_pago,
               ${nombreCompleto('cli')} AS cliente_nombre,
               ${SQL_OP_ABIERTA} AS abierta,
               (oc.precio_alquiler IS NULL) AS sin_precio,
               EXISTS (SELECT 1 FROM transacciones t WHERE t.id_op_encabezado = op.id) AS cobrada
        FROM op_encabezado op
        JOIN clientes cli ON cli.id = op.id_cliente
        JOIN op_detalle_contenedor oc ON oc.id_orden_pedido = op.id
        WHERE op.id_grupo = ? AND op.estado <> 'anulado'
        ORDER BY op.id
      `, [id_grupo])).rows
      if (!ops.length || ops.some(o => o.abierta)) return null
      // Sin precio no hay nada que cobrar: el cobro se genera cuando se asigne el precio.
      if (ops.some(o => o.sin_precio)) return null
      const aCobrar = ops.filter(o => !o.cobrada)
      if (!aCobrar.length) return null

      let metodoPago = ops[0].metodo_pago
      if (metodoPago === 'a_convenir') {
        if (!metodoPagoFinal) return null
        metodoPago = metodoPagoFinal
        await q(`UPDATE op_encabezado SET metodo_pago = ? WHERE id_grupo = ? AND estado <> 'anulado'`, [metodoPago, id_grupo])
      }

      let total = 0
      const numeros = []
      for (const o of aCobrar) {
        // Cada contenedor cuenta sus días hasta su propio retiro, no hasta el último
        const cierre = await this.datosCierre(o.id, { alRetiro: true, q })
        const valor = montos[o.id]
        const manual = valor != null && String(valor).trim() !== ''
        const monto = manual ? (parseFloat(valor) || 0) : cierre.precioACobrar
        total += monto
        numeros.push(`#${cierre.numero_contenedor || '?'}`)
        await TransaccionesModel.crear({
          tipo: 'Alquiler', id_op_encabezado: o.id, nro_remito: o.nro_remito,
          cliente_id: o.id_cliente, cliente: o.cliente_nombre, monto,
          descripcion: `Alquiler contenedor #${cierre.numero_contenedor || '?'}${cierre.destino ? ' — ' + cierre.destino : ''} (cobro por alquiler, ${ops.length} contenedores)`,
          metodo_pago: metodoPago || 'efectivo',
        }, q)
      }

      const principal = ops[0]
      const detalle = `Alquiler contenedores ${numeros.join(', ')} — ${ops.map(o => 'OP-' + String(o.nro_op).padStart(4, '0')).join(', ')}`
      if (metodoPago === 'cuenta_corriente' && principal.id_cliente) {
        await ClientesModel.agregarMovimiento(principal.id_cliente, {
          tipo: 'deuda', descripcion: detalle, monto: -total, id_op_encabezado: principal.id,
        }, q)
      }
      if (metodoPago === 'saldo_a_favor' && principal.id_cliente) {
        await ClientesModel.agregarMovimiento(principal.id_cliente, {
          tipo: 'uso_saldo_favor', descripcion: `${detalle} — pagado con saldo a favor`, monto: -total, id_op_encabezado: principal.id,
        }, q)
      }
      return total
    }
    return qExterno ? cobrar(qExterno) : await transaction(cobrar)
  },

  // Registra el cobro de UNA operación: la transacción (ingreso) y, si el método es cuenta
  // corriente o saldo a favor, el movimiento en la cuenta del cliente. Lo usan el cierre
  // del alquiler (cobrarAlCerrar) y la asignación de precio de uno ya retirado
  // (asignarPrecio). Con `q` corre dentro de la transacción de quien llama.
  async _registrarCobro({ op, cierre, monto, metodoPago }, q = query) {
    // Si el alquiler arrancó con otro precio, se deja la referencia en la descripción
    const referencia = (cierre.cambioDePrecio && cierre.mesInicio)
      ? ` (Precio inicial ${cierre.mesInicio}: $${Math.round(cierre.precioInicial).toLocaleString('es-AR')})`
      : ''
    const detalle = `Alquiler contenedor #${cierre.numero_contenedor || '?'}${cierre.destino ? ' — ' + cierre.destino : ''}`

    await TransaccionesModel.crear({
      tipo: 'Alquiler', id_op_encabezado: op.id, nro_remito: op.nro_remito,
      cliente_id: op.id_cliente, cliente: op.cliente_nombre, monto,
      descripcion: detalle + referencia,
      metodo_pago: metodoPago || 'efectivo',
    }, q)
    if (metodoPago === 'cuenta_corriente' && op.id_cliente) {
      await ClientesModel.agregarMovimiento(op.id_cliente, {
        tipo: 'deuda',
        descripcion: `Alquiler contenedor #${cierre.numero_contenedor || '?'} OP-${String(op.nro_op).padStart(4, '0')}`,
        monto: -monto,
        id_op_encabezado: op.id,
      }, q)
    }
    if (metodoPago === 'saldo_a_favor' && op.id_cliente) {
      await ClientesModel.agregarMovimiento(op.id_cliente, {
        tipo: 'uso_saldo_favor',
        descripcion: `Alquiler contenedor #${cierre.numero_contenedor || '?'} OP-${String(op.nro_op).padStart(4, '0')} — pagado con saldo a favor`,
        monto: -monto,
        id_op_encabezado: op.id,
      }, q)
    }
  },

  // Genera el ingreso del alquiler al cerrarlo (cuando se retira el contenedor).
  // `montoManual` permite ajustar el precio en el momento del cierre; si no viene, cobra
  // el precio asignado en Cobranzas o, en un alquiler con precio de alta, la tarifa
  // vigente (ver datosCierre). Si la operación ya tenía un ingreso, no hace nada.
  //
  // Un alquiler SIN precio no genera ingreso (devuelve null): se retira igual, sin
  // bloquear a la oficina ni al chofer, y sigue en Cobranzas → Asignar precio; el cobro se
  // genera cuando se le asigne el precio (asignarPrecio).
  //
  // `metodoPagoFinal` resuelve los alquileres cargados "a convenir una vez
  // finalizado": si el método de pago pactado es 'a_convenir' y no viene uno acá,
  // NO se genera el ingreso (el alquiler queda pendiente de cobro — aparece en el
  // submódulo de Cobranzas hasta que se resuelva). El chofer (hoja de ruta) nunca
  // manda este parámetro, así que un alquiler "a convenir" que él cierra queda
  // pendiente automáticamente, sin bloquear su tarea.
  async cobrarAlCerrar(id_op, montoManual, metodoPagoFinal) {
    // Alquiler de varios contenedores con cobro "por alquiler": se cobra todo junto al
    // retirar el último (cobrarGrupo). El monto manual puede venir por contenedor
    // ({ [id_op]: monto }) o ser el de esta OP.
    const grupo = await this.grupoConCobroPorAlquiler(id_op)
    if (grupo) {
      const montos = (montoManual && typeof montoManual === 'object') ? montoManual
        : (montoManual != null && String(montoManual).trim() !== '') ? { [id_op]: montoManual } : {}
      return this.cobrarGrupo(grupo.id, { montos, metodoPagoFinal })
    }
    // Con la OP bloqueada (FOR UPDATE), en una transacción: así un retiro y una asignación de
    // precio (asignarPrecio, que bloquea la misma fila) que ocurren a la vez no pueden dejar un
    // alquiler retirado, con precio y sin cobrar, y dos cierres simultáneos no cobran dos veces.
    return await transaction(async (q) => {
      await q(`SELECT id FROM op_encabezado WHERE id = ? FOR UPDATE`, [id_op])
      if (await TransaccionesModel.existePorOperacion(id_op, q)) return null
      const op = (await q(`
        SELECT op.id, op.nro_remito, op.id_cliente, op.metodo_pago, op.nro_op, ${nombreCompleto('cli')} AS cliente_nombre
        FROM op_encabezado op JOIN clientes cli ON cli.id = op.id_cliente WHERE op.id = ?
      `, [id_op])).rows[0]
      const cierre = await this.datosCierre(id_op, { q })
      if (!op || !cierre) return null
      if (cierre.sinPrecio) return null

      let metodoPago = op.metodo_pago
      if (metodoPago === 'a_convenir') {
        if (!metodoPagoFinal) return null
        metodoPago = metodoPagoFinal
        await q(`UPDATE op_encabezado SET metodo_pago = ? WHERE id = ?`, [metodoPago, id_op])
      }

      const manual = montoManual != null && String(montoManual).trim() !== ''
      const monto = manual ? (parseFloat(montoManual) || 0) : cierre.precioACobrar

      await this._registrarCobro({ op, cierre, monto, metodoPago }, q)
      return monto
    })
  },

  // Alquileres de contenedor "a convenir una vez finalizado" que ya se retiraron
  // (el contenedor está de nuevo disponible) pero todavía no se les cargó el método
  // de pago real: pendientes de cobro. Alimenta el submódulo de Cobranzas.
  async pendientesDeCobro() {
    const filas = (await query(`
      SELECT op.id, op.nro_op, op.nro_remito, op.id_cliente, op.id_grupo, ag.cobro_modo,
             ${nombreCompleto('cli')} AS cliente_nombre,
             GREATEST(0, COALESCE(cli.saldo, 0)) AS saldo_favor_cliente,
             oc.precio_alquiler, oc.plazo_alquiler, oc.domicilio_entrega, cont.numero_contenedor,
             (SELECT MIN(m.fecha_movimiento) FROM movimiento_contenedor m
                WHERE m.id_op_contenedor = oc.id AND m.estado_paso = 'disponible') AS fecha_retiro
      FROM op_encabezado op
      JOIN clientes cli ON cli.id = op.id_cliente
      JOIN op_detalle_contenedor oc ON oc.id_orden_pedido = op.id
      LEFT JOIN contenedores cont ON cont.id = oc.id_contenedor
      LEFT JOIN alquiler_grupos ag ON ag.id = op.id_grupo
      WHERE op.tipo_op = 'C' AND op.estado = 'entregado' AND op.metodo_pago = 'a_convenir'
        AND (ag.cobro_modo = 'alquiler'
             OR EXISTS (SELECT 1 FROM movimiento_contenedor m WHERE m.id_op_contenedor = oc.id AND m.estado_paso = 'disponible'))
        AND NOT EXISTS (SELECT 1 FROM transacciones t WHERE t.id_op_encabezado = op.id)
      ORDER BY fecha_retiro ASC NULLS LAST
    `)).rows
    // Alquiler agrupado con cobro por alquiler: UNA fila por grupo, y solo cuando ya se
    // retiraron todos sus contenedores (antes no hay nada que cobrar todavía). Las OPs
    // salen de grupoDe, que también da por cerrada la que pasó directo al próximo
    // alquiler sin volver a planta (esa no tiene un 'disponible' propio).
    const resultado = []
    const vistos = new Set()
    for (const f of filas) {
      if (f.cobro_modo !== 'alquiler') { resultado.push(f); continue }
      if (vistos.has(f.id_grupo)) continue
      vistos.add(f.id_grupo)
      const grupo = await this.grupoDe(f.id)
      if (!grupo || grupo.abiertas > 0) continue
      const ops = grupo.ops.filter(o => o.estado !== 'anulado' && !o.cobrada)
      if (!ops.length) continue
      const cierres = ops.map(o => o.fecha_cierre).filter(Boolean)
      resultado.push({
        ...f, esGrupo: true, ops,
        numero_contenedor: ops.map(o => o.numero_contenedor).filter(Boolean).join(', '),
        fecha_retiro: cierres.length ? cierres.reduce((a, b) => (new Date(b) > new Date(a) ? b : a)) : null,
      })
    }
    const orden = (p) => (p.fecha_retiro ? new Date(p.fecha_retiro).getTime() : Infinity)
    return resultado.sort((a, b) => orden(a) - orden(b))
  },

  // Alquileres de contenedor SIN precio (precio_alquiler NULL), sin anular: pendientes de
  // iniciar, en curso o ya retirados. Alimenta Cobranzas → Asignar precio.
  // Devuelve bloques, los ya retirados primero (el cobro no se genera hasta que se les
  // asigne el precio), después los en curso y los pendientes:
  //  - { todoJunto: false, filas: [fila] }  un alquiler de un contenedor, o un contenedor
  //    de un alquiler agrupado que se asigna por separado ("por contenedor");
  //  - { todoJunto: true, id_grupo, filas }  alquiler agrupado en el que NINGÚN contenedor
  //    tiene precio todavía: se puede asignar todo junto ("por alquiler": un solo cargo en
  //    cuenta corriente por el total) o cada contenedor por separado.
  // Cada fila trae el estado (pendiente / en_curso / retirado), los días transcurridos, el
  // plazo, el precio sugerido y lo que hace falta para ofrecer los métodos de pago (si el
  // cliente tiene cuenta corriente y su saldo a favor).
  async sinPrecio() {
    const filas = (await query(`
      SELECT op.id, op.nro_op, op.nro_remito, op.id_cliente, op.id_grupo, op.estado, op.obra,
             ${nombreCompleto('cli')} AS cliente_nombre,
             (COALESCE(cli.cuenta_corriente, 0) = 1) AS cliente_con_cc,
             GREATEST(0, COALESCE(cli.saldo, 0)) AS saldo_favor_cliente,
             oc.domicilio_entrega, oc.plazo_alquiler, oc.id_contenedor, cont.numero_contenedor,
             COALESCE(NULLIF(LEFT(op.fecha_entrega_planificada, 10), ''), LEFT(ma.fecha_alquiler, 10)) AS fecha_inicio,
             ${SQL_FECHA_CIERRE_OP} AS fecha_retiro,
             (SELECT COUNT(*) FROM op_encabezado g WHERE g.id_grupo = op.id_grupo AND g.estado <> 'anulado')::int AS grupo_cant
      FROM op_encabezado op
      JOIN clientes cli ON cli.id = op.id_cliente
      JOIN op_detalle_contenedor oc ON oc.id_orden_pedido = op.id
      LEFT JOIN contenedores cont ON cont.id = oc.id_contenedor
      LEFT JOIN (${SQL_MOV_ALQUILER_OP}) ma ON ma.id_op_contenedor = oc.id
      WHERE op.tipo_op = 'C' AND op.estado <> 'anulado' AND oc.precio_alquiler IS NULL
      ORDER BY op.id
    `)).rows
    for (const f of filas) {
      f.estado_asignar = f.estado !== 'entregado' ? 'pendiente'
        : (f.id_contenedor != null && f.fecha_retiro != null ? 'retirado' : 'en_curso')
      const cierre = await this.datosCierre(f.id, { alRetiro: true })
      f.dias = f.estado_asignar === 'pendiente' ? null : cierre.dias
      f.precio_sugerido = cierre.precioSugerido
    }

    const porGrupo = new Map()
    for (const f of filas) {
      if (f.id_grupo) porGrupo.set(f.id_grupo, [...(porGrupo.get(f.id_grupo) || []), f])
    }
    const bloques = []
    const vistos = new Set()
    for (const f of filas) {
      const delGrupo = f.id_grupo ? porGrupo.get(f.id_grupo) : null
      if (delGrupo && delGrupo.length >= 2 && delGrupo.length === f.grupo_cant) {
        if (vistos.has(f.id_grupo)) continue
        vistos.add(f.id_grupo)
        bloques.push({ todoJunto: true, id_grupo: f.id_grupo, filas: delGrupo })
      } else {
        bloques.push({ todoJunto: false, filas: [f] })
      }
    }
    const urgencia = { retirado: 0, en_curso: 1, pendiente: 2 }
    const prioridad = (b) => Math.min(...b.filas.map(f => urgencia[f.estado_asignar]))
    const inicio = (b) => b.filas.map(f => f.fecha_inicio || '9999-12-31').sort()[0]
    return bloques.sort((a, b) => prioridad(a) - prioridad(b) || inicio(a).localeCompare(inicio(b)) || a.filas[0].id - b.filas[0].id)
  },

  // Cuántos alquileres sin precio hay para asignar (el aviso del listado y de Cobranzas).
  async cantidadSinPrecio() {
    return (await query(`
      SELECT COUNT(*)::int AS n FROM op_encabezado op
      JOIN op_detalle_contenedor oc ON oc.id_orden_pedido = op.id
      WHERE op.tipo_op = 'C' AND op.estado <> 'anulado' AND oc.precio_alquiler IS NULL
    `)).rows[0].n
  },

  // Valida lo que no depende del alquiler para asignar precio y método: el método tiene que
  // ser uno de los permitidos, y cuenta corriente / saldo a favor se piden solo a clientes
  // que los tengan (la pantalla no los ofrece si no, pero el servidor no confía en eso).
  async _validarMetodoAsignar(metodo_pago, id_cliente) {
    if (!METODOS_PAGO.includes(metodo_pago)) throw new Error('Elegí un método de pago.')
    if (metodo_pago === 'cuenta_corriente') {
      const errCC = await ClientesModel.errorCuentaCorriente(id_cliente)
      if (errCC) throw new Error(errCC)
    }
    if (metodo_pago === 'saldo_a_favor') {
      const errSaldo = await ClientesModel.errorSaldoFavor(id_cliente)
      if (errSaldo) throw new Error(errSaldo)
    }
  },

  // Asigna precio y método de pago a UN alquiler sin precio (Cobranzas → Asignar precio).
  // Si el contenedor ya se retiró, el cobro se genera en este momento con el precio cargado;
  // si todavía no, se genera al retirarlo (cobrarAlCerrar cobra el precio asignado).
  // Todo en una transacción y con la OP bloqueada: un doble clic no puede asignar ni cobrar
  // dos veces. Devuelve { monto, cobrado }.
  async asignarPrecio(id_op, { precio, metodo_pago }) {
    const monto = precioONull(precio)
    if (monto == null) throw new Error('Ingresá el precio del alquiler.')
    if (monto < 0) throw new Error('El precio no puede ser negativo.')
    return await transaction(async (q) => {
      const op = (await q(`
        SELECT op.id, op.nro_op, op.nro_remito, op.id_cliente, op.estado, ag.cobro_modo,
               oc.precio_alquiler, ${nombreCompleto('cli')} AS cliente_nombre,
               (op.estado = 'entregado' AND oc.id_contenedor IS NOT NULL AND ${SQL_FECHA_CIERRE_OP} IS NOT NULL) AS retirado
        FROM op_encabezado op
        JOIN clientes cli ON cli.id = op.id_cliente
        JOIN op_detalle_contenedor oc ON oc.id_orden_pedido = op.id
        LEFT JOIN alquiler_grupos ag ON ag.id = op.id_grupo
        WHERE op.id = ? AND op.tipo_op = 'C'
        FOR UPDATE OF op
      `, [id_op])).rows[0]
      if (!op) throw new Error('Alquiler no encontrado.')
      if (op.estado === 'anulado') throw new Error('El alquiler está anulado.')
      if (op.precio_alquiler != null) throw new Error('Este alquiler ya tiene precio asignado.')
      if (op.cobro_modo === 'alquiler') throw new Error('Este alquiler se cobra por alquiler: asignale el precio a todos sus contenedores juntos.')
      await this._validarMetodoAsignar(metodo_pago, op.id_cliente)

      await q(`UPDATE op_detalle_contenedor SET precio_alquiler = ?, metodo_pago = ?, precio_asignado_en = ahora_local() WHERE id_orden_pedido = ?`,
        [monto, metodo_pago, op.id])
      await q(`UPDATE op_encabezado SET metodo_pago = ? WHERE id = ?`, [metodo_pago, op.id])

      // Ya retirado no hay otro momento en que se cobre: se cobra ahora.
      if (op.retirado) {
        const cierre = await this.datosCierre(op.id, { alRetiro: true, q })
        await this._registrarCobro({ op, cierre, monto, metodoPago: metodo_pago }, q)
      }
      return { monto, cobrado: !!op.retirado }
    })
  },

  // Asigna precio y método de pago a TODOS los contenedores de un alquiler agrupado, que
  // pasa a cobrarse "por alquiler": un solo método, un precio por contenedor, y un solo
  // cargo en cuenta corriente por el total. Solo si ningún contenedor del grupo tiene precio
  // todavía. `precios`: { [id_op]: monto }. Si ya se retiraron todos, se cobra ahora; si
  // falta alguno, se cobra todo junto al retirar el último (cobrarGrupo). Devuelve
  // { total, cobrado }.
  async asignarPrecioGrupo(id_op, { precios = {}, metodo_pago }) {
    return await transaction(async (q) => {
      const g = (await q(`
        SELECT ag.id FROM op_encabezado op JOIN alquiler_grupos ag ON ag.id = op.id_grupo
        WHERE op.id = ? AND op.tipo_op = 'C' FOR UPDATE OF ag
      `, [id_op])).rows[0]
      if (!g) throw new Error('Este alquiler no es de varios contenedores.')
      const ops = (await q(`
        SELECT op.id, op.id_cliente, oc.precio_alquiler, cont.numero_contenedor
        FROM op_encabezado op
        JOIN op_detalle_contenedor oc ON oc.id_orden_pedido = op.id
        LEFT JOIN contenedores cont ON cont.id = oc.id_contenedor
        WHERE op.id_grupo = ? AND op.estado <> 'anulado'
        ORDER BY op.id
        FOR UPDATE OF op
      `, [g.id])).rows
      if (!ops.length) throw new Error('El alquiler no tiene contenedores sin anular.')
      if (ops.some(o => o.precio_alquiler != null)) {
        throw new Error('Algún contenedor de este alquiler ya tiene precio: asignalos de a uno.')
      }
      const montos = {}
      for (const o of ops) {
        const monto = precioONull(precios[o.id])
        if (monto == null || monto < 0) throw new Error(`Ingresá el precio del contenedor N° ${o.numero_contenedor || '?'}.`)
        montos[o.id] = monto
      }
      await this._validarMetodoAsignar(metodo_pago, ops[0].id_cliente)

      await q(`UPDATE alquiler_grupos SET cobro_modo = 'alquiler' WHERE id = ?`, [g.id])
      for (const o of ops) {
        await q(`UPDATE op_detalle_contenedor SET precio_alquiler = ?, metodo_pago = ?, precio_asignado_en = ahora_local() WHERE id_orden_pedido = ?`,
          [montos[o.id], metodo_pago, o.id])
        await q(`UPDATE op_encabezado SET metodo_pago = ? WHERE id = ?`, [metodo_pago, o.id])
      }
      const cobrado = await this.cobrarGrupo(g.id, { montos, q })
      return { total: Object.values(montos).reduce((a, b) => a + b, 0), cobrado: cobrado != null }
    })
  },

  // Amplía el alquiler por el plazo que le corresponde al cliente. Si el contenedor
  // había pasado a 'pendiente_retiro' por vencimiento, vuelve a estar en alquiler.
  async ampliarPlazo(id_op, diasExtra) {
    const oc = (await query(`SELECT id, id_contenedor, plazo_alquiler FROM op_detalle_contenedor WHERE id_orden_pedido = ? LIMIT 1`, [id_op])).rows[0]
    if (!oc) throw new Error('El alquiler no tiene detalle de contenedor.')
    if (oc.plazo_alquiler == null) throw new Error('Este alquiler no tiene fecha de fin: no hay nada que ampliar.')
    const nuevoPlazo = oc.plazo_alquiler + diasExtra
    await query(`UPDATE op_detalle_contenedor SET plazo_alquiler = ? WHERE id = ?`, [nuevoPlazo, oc.id])
    if (oc.id_contenedor) {
      const ec = (await query(`SELECT estado_paso FROM movimiento_contenedor WHERE id_contenedor = ? ORDER BY fecha_movimiento DESC, id DESC LIMIT 1`, [oc.id_contenedor])).rows[0]?.estado_paso
      if (ec === 'pendiente_retiro') {
        await query(`INSERT INTO movimiento_contenedor (id_contenedor, id_op_contenedor, estado_paso, observaciones) VALUES (?, ?, 'en_alquiler', ?)`,
          [oc.id_contenedor, oc.id, `Alquiler ampliado ${diasExtra} días — sigue en el domicilio`])
      }
    }
    return nuevoPlazo
  },

  // Carga histórica: alquiler que YA terminó. Se crea directamente como
  // 'entregado' con las fechas pasadas y SIN contenedor físico (no genera
  // movimientos ni tareas de chofer). El ingreso lo registra el controller.
  async crearFinalizado({ id_cliente, id_administrativo, domicilio_entrega, domicilio_calle, domicilio_numero, zona_entrega, plazo_alquiler, precio_alquiler, metodo_pago, observaciones, fecha_inicio, fecha_fin, obra, nro_remito }) {
    const { nro }         = (await query(`SELECT ${SQL_SIGUIENTE_NRO_OP} AS nro`)).rows[0]
    const { nro_rem: nroSiguiente } = (await query(`SELECT COALESCE(MAX(nro_remito), 0) + 1 AS nro_rem FROM op_encabezado`)).rows[0]
    const nro_rem = nro_remito || nroSiguiente
    const cli = (await query(`SELECT NULLIF(TRIM(COALESCE(nombre,'') || ' ' || COALESCE(apellido,'')), '') AS nombre FROM clientes WHERE id = ?`, [id_cliente])).rows[0]
    return await transaction(async (q) => {
      const { rows } = await q(`
        INSERT INTO op_encabezado (id_cliente, id_administrativo, tipo_op, nro_op, nro_remito, estado, metodo_pago, observaciones, fecha_emision, fecha_entrega_planificada, obra)
        VALUES (?, ?, 'C', ?, ?, 'entregado', ?, ?, ?, ?, ?)
        RETURNING id
      `, [id_cliente, id_administrativo, nro, nro_rem, metodo_pago || null, observaciones || '',
          fecha_inicio || null, fecha_inicio || null, obra || null])
      const id_op = rows[0].id
      await q(`
        INSERT INTO op_detalle_contenedor (id_orden_pedido, id_contenedor, domicilio_entrega, domicilio_calle, domicilio_numero, zona_entrega, plazo_alquiler, precio_alquiler, metodo_pago)
        VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)
      `, [id_op, domicilio_entrega || '', domicilio_calle || null, domicilio_numero || null,
          zona_entrega || '', normalizarPlazo(plazo_alquiler, 0), parseFloat(precio_alquiler) || 0, metodo_pago || null])
      return { id: id_op, nro_op: nro, nro_remito: nro_rem, cliente_nombre: cli?.nombre || '' }
    })
  },

  async activarProgramado(id_op) {
    const op = (await query(`SELECT estado_programacion FROM op_encabezado WHERE id = ?`, [id_op])).rows[0]
    if (!op || op.estado_programacion !== 'programado') return
    await query(`UPDATE op_encabezado SET estado_programacion = 'activo' WHERE id = ?`, [id_op])
    const oc = (await query(`SELECT id, id_contenedor FROM op_detalle_contenedor WHERE id_orden_pedido = ? LIMIT 1`, [id_op])).rows[0]
    if (oc?.id_contenedor) {
      await query(`INSERT INTO movimiento_contenedor (id_contenedor, id_op_contenedor, estado_paso, observaciones) VALUES (?, ?, 'pendiente_despacho', 'Alquiler programado activado — pendiente despacho')`,
        [oc.id_contenedor, oc.id])
    }
  },
}

module.exports = AlquileresModel
