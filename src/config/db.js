'use strict'
// ═══════════════════════════════════════════════════════════════════
// db.js — Base de datos · Suelosur S.A.S.
// pg (async) · PostgreSQL / Supabase
// ═══════════════════════════════════════════════════════════════════

const crypto = require('crypto')
const { Pool } = require('pg')
const bcrypt  = require('bcryptjs')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
})

// Convierte placeholders ? → $1, $2, ... para PostgreSQL
async function query(sql, params = []) {
  let i = 0
  const pgSql = sql.replace(/\?/g, () => `$${++i}`)
  return pool.query(pgSql, params)
}

// Ejecuta fn(q) dentro de una transacción; q es el mismo helper ? → $N
async function transaction(fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const q = (sql, params = []) => {
      let i = 0
      return client.query(sql.replace(/\?/g, () => `$${++i}`), params)
    }
    const result = await fn(q)
    await client.query('COMMIT')
    return result
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

// ═══════════════════════════════════════════════════════════════════
// initDB — crea tablas, migraciones, seeds y backfills
// ═══════════════════════════════════════════════════════════════════
async function initDB() {

  // ─────────────────────────────────────────────────────────────────
  // BLOQUE 1 — TABLAS CENTRALES
  // ─────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      usuario       TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      nombre        TEXT NOT NULL,
      rol           TEXT NOT NULL CHECK (rol IN ('admin_ventas','admin_contable','chofer','dueno')),
      activo        INTEGER DEFAULT 1,
      created_at    TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS clientes (
      id               TEXT PRIMARY KEY,
      nombre           TEXT NOT NULL,
      apellido         TEXT NOT NULL DEFAULT '',
      dni              TEXT,
      domicilio_ppal   TEXT,
      zona             TEXT,
      tel_whatsapp     TEXT,
      telefono         TEXT,
      email            TEXT,
      tipo_cliente     TEXT,
      cuenta_corriente INTEGER DEFAULT 0,
      saldo            REAL DEFAULT 0,
      activo           INTEGER DEFAULT 1,
      numero           INTEGER,
      created_at       TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_numero ON clientes(numero)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS movimientos_cuenta (
      id          TEXT PRIMARY KEY,
      cliente_id  TEXT NOT NULL REFERENCES clientes(id),
      tipo        TEXT NOT NULL CHECK (tipo IN ('deuda','pago','ajuste')),
      descripcion TEXT NOT NULL DEFAULT '',
      monto       REAL NOT NULL,
      created_at  TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS productos (
      id                TEXT PRIMARY KEY,
      nombre            TEXT NOT NULL,
      unidad_medida     TEXT NOT NULL DEFAULT 'm³',
      precio_referencia REAL DEFAULT 0,
      activo            INTEGER DEFAULT 1,
      created_at        TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock (
      id                      TEXT PRIMARY KEY,
      id_producto             TEXT NOT NULL UNIQUE REFERENCES productos(id),
      cantidad_actual         REAL DEFAULT 0,
      cant_pendiente_entregar REAL DEFAULT 0,
      stock_minimo            REAL DEFAULT 0
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS flota_vehiculos (
      id               TEXT PRIMARY KEY,
      tipo_vehiculo    TEXT NOT NULL CHECK (tipo_vehiculo IN ('camion','bobcat','utilitario','otro')),
      patente          TEXT NOT NULL,
      nombre           TEXT NOT NULL,
      kilometraje      INTEGER DEFAULT 0,
      activo           INTEGER DEFAULT 1,
      marca            TEXT,
      modelo           TEXT,
      anio             INTEGER,
      nro_chasis       TEXT,
      nro_motor        TEXT,
      tipo_unidad      TEXT,
      capacidad_carga  REAL,
      estado_operativo TEXT DEFAULT 'disponible',
      numero_interno   INTEGER,
      fecha_ultimo_mant  TEXT,
      fecha_proximo_mant TEXT,
      observaciones    TEXT DEFAULT '',
      dedicacion       TEXT DEFAULT 'ambos',
      created_at       TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  // ─────────────────────────────────────────────────────────────────
  // BLOQUE 2 — OPERACIONES
  // ─────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS op_encabezado (
      id                        TEXT PRIMARY KEY,
      id_cliente                TEXT NOT NULL REFERENCES clientes(id),
      id_administrativo         TEXT NOT NULL REFERENCES users(id),
      fecha_emision             TEXT NOT NULL DEFAULT to_char(CURRENT_DATE, 'YYYY-MM-DD'),
      tipo_op                   TEXT NOT NULL DEFAULT 'M' CHECK (tipo_op IN ('M','C','MA')),
      nro_op                    INTEGER NOT NULL,
      nro_remito                INTEGER,
      estado                    TEXT NOT NULL DEFAULT 'pendiente'
                                  CHECK (estado IN ('pendiente','despachado','entregado','anulado')),
      modalidad                 TEXT CHECK (modalidad IN ('deposito','flete') OR modalidad IS NULL),
      metodo_pago               TEXT CHECK (metodo_pago IN ('efectivo','transferencia','cheque','cuenta_corriente') OR metodo_pago IS NULL),
      observaciones             TEXT DEFAULT '',
      fecha_entrega_planificada TEXT,
      domicilio_calle           TEXT,
      domicilio_altura          INTEGER,
      domicilio_sin_numero      INTEGER DEFAULT 0,
      domicilio_lat             REAL,
      domicilio_lng             REAL,
      estado_programacion       TEXT DEFAULT NULL,
      archivo_remito            TEXT,
      id_chofer                 TEXT,
      id_camion                 TEXT,
      asignacion_fecha          TEXT,
      asignacion_usuario        TEXT,
      created_at                TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS op_detalle_material (
      id              TEXT PRIMARY KEY,
      id_orden_pedido TEXT NOT NULL REFERENCES op_encabezado(id),
      id_producto     TEXT NOT NULL REFERENCES productos(id),
      cantidad_pedida REAL NOT NULL,
      precio_unitario REAL NOT NULL
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS op_detalle_contenedor (
      id                   TEXT PRIMARY KEY,
      id_orden_pedido      TEXT NOT NULL REFERENCES op_encabezado(id),
      id_contenedor        TEXT REFERENCES contenedores(id),
      domicilio_entrega    TEXT NOT NULL DEFAULT '',
      zona_entrega         TEXT NOT NULL DEFAULT '',
      plazo_alquiler       INTEGER NOT NULL DEFAULT 5,
      precio_alquiler      REAL DEFAULT 0,
      domicilio_calle      TEXT,
      domicilio_numero     TEXT,
      domicilio_lat        REAL,
      domicilio_lng        REAL,
      alquiler_siguiente_id TEXT,
      metodo_pago          TEXT
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS op_detalle_maquinaria (
      id                TEXT PRIMARY KEY,
      id_orden_pedido   TEXT NOT NULL REFERENCES op_encabezado(id),
      id_maquinaria     TEXT REFERENCES maquinaria(id),
      domicilio_entrega TEXT NOT NULL DEFAULT '',
      zona_entrega      TEXT NOT NULL DEFAULT '',
      plazo_alquiler    INTEGER NOT NULL DEFAULT 1,
      precio_por_hora   REAL DEFAULT 0,
      horas_pactadas    REAL DEFAULT 0,
      precio_total      REAL DEFAULT 0,
      id_chofer         TEXT REFERENCES users(id),
      domicilio_calle   TEXT,
      domicilio_numero  TEXT,
      metodo_pago       TEXT
    )
  `)

  // ─────────────────────────────────────────────────────────────────
  // BLOQUE 3 — CONTENEDORES
  // ─────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contenedores (
      id                   TEXT PRIMARY KEY,
      numero_contenedor    INTEGER NOT NULL UNIQUE,
      estado_general       TEXT NOT NULL DEFAULT 'operativo'
                             CHECK (estado_general IN ('operativo','en_reparacion','baja')),
      fecha_ultima_pintada TEXT,
      observaciones        TEXT DEFAULT '',
      activo               INTEGER DEFAULT 1,
      created_at           TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS movimiento_contenedor (
      id               TEXT PRIMARY KEY,
      id_contenedor    TEXT NOT NULL REFERENCES contenedores(id),
      id_op_contenedor TEXT REFERENCES op_detalle_contenedor(id),
      id_chofer        TEXT REFERENCES users(id),
      id_camion        TEXT REFERENCES flota_vehiculos(id),
      fecha_movimiento TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      estado_paso      TEXT NOT NULL
                         CHECK (estado_paso IN (
                           'en_planta','en_transito','entregado',
                           'en_alquiler','a_retirar','vaciado'
                         )),
      observaciones    TEXT DEFAULT ''
    )
  `)

  // ─────────────────────────────────────────────────────────────────
  // BLOQUE 4 — MAQUINARIA
  // ─────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS maquinaria (
      id              TEXT PRIMARY KEY,
      nombre          TEXT NOT NULL,
      tipo            TEXT NOT NULL DEFAULT 'bobcat'
                        CHECK (tipo IN ('bobcat','minicargadora','retroexcavadora','otro')),
      patente         TEXT,
      modelo          TEXT,
      anio            INTEGER,
      estado_general  TEXT NOT NULL DEFAULT 'operativo'
                        CHECK (estado_general IN ('operativo','en_servicio','baja')),
      km_actuales     INTEGER DEFAULT 0,
      ultimo_service  TEXT,
      proximo_service TEXT,
      observaciones   TEXT DEFAULT '',
      activo          INTEGER DEFAULT 1,
      precio_por_hora REAL DEFAULT 0,
      precio_por_dia  REAL DEFAULT 0,
      modo_precio     TEXT DEFAULT 'hora',
      numero_interno  INTEGER,
      horas_uso       REAL DEFAULT 0,
      estado_operativo TEXT DEFAULT 'disponible',
      marca           TEXT,
      created_at      TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS movimiento_maquinaria (
      id               TEXT PRIMARY KEY,
      id_maquinaria    TEXT NOT NULL REFERENCES maquinaria(id),
      id_op_maquinaria TEXT REFERENCES op_detalle_maquinaria(id),
      id_operario      TEXT REFERENCES users(id),
      id_camion        TEXT REFERENCES flota_vehiculos(id),
      fecha_movimiento TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      estado_paso      TEXT NOT NULL
                         CHECK (estado_paso IN (
                           'en_planta','despachada','en_uso','a_retirar','en_servicio'
                         )),
      horas_trabajadas REAL DEFAULT 0,
      km_registrados   INTEGER DEFAULT 0,
      observaciones    TEXT DEFAULT ''
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS mantenimiento_maquinaria (
      id            TEXT PRIMARY KEY,
      id_maquinaria TEXT NOT NULL REFERENCES maquinaria(id),
      tipo_service  TEXT NOT NULL DEFAULT 'preventivo'
                      CHECK (tipo_service IN ('preventivo','correctivo','revision')),
      fecha         TEXT NOT NULL,
      costo         REAL DEFAULT 0,
      km_al_service INTEGER DEFAULT 0,
      proximo_fecha TEXT,
      taller        TEXT DEFAULT '',
      descripcion   TEXT DEFAULT '',
      created_at    TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  // ─────────────────────────────────────────────────────────────────
  // BLOQUE 5 — TRANSACCIONES
  // ─────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transacciones (
      id               TEXT PRIMARY KEY,
      tipo             TEXT NOT NULL
                         CHECK (tipo IN (
                           'Venta Cantera','Venta Viaje',
                           'Alquiler','Maquinaria','Ajuste'
                         )),
      id_op_encabezado TEXT REFERENCES op_encabezado(id),
      nro_remito       INTEGER,
      cliente_id       TEXT REFERENCES clientes(id),
      cliente          TEXT NOT NULL DEFAULT '',
      monto            REAL NOT NULL DEFAULT 0,
      descripcion      TEXT DEFAULT '',
      metodo_pago      TEXT NOT NULL DEFAULT 'efectivo'
                         CHECK (metodo_pago IN (
                           'efectivo','transferencia','cheque','cuenta_corriente'
                         )),
      fecha            TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      numero           INTEGER,
      created_at       TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  // ─────────────────────────────────────────────────────────────────
  // BLOQUE 6 — CIRCUITOS LOGÍSTICOS
  // ─────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS circuitos (
      id            TEXT PRIMARY KEY,
      fecha         TEXT NOT NULL DEFAULT to_char(CURRENT_DATE, 'YYYY-MM-DD'),
      id_chofer     TEXT REFERENCES users(id),
      id_camion     TEXT REFERENCES flota_vehiculos(id),
      id_empleado   TEXT,
      estado        TEXT NOT NULL DEFAULT 'borrador'
                      CHECK (estado IN ('borrador','confirmado','en_curso','finalizado')),
      observaciones TEXT DEFAULT '',
      created_at    TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS circuito_paradas (
      id               TEXT PRIMARY KEY,
      id_circuito      TEXT NOT NULL REFERENCES circuitos(id),
      id_op_encabezado TEXT REFERENCES op_encabezado(id),
      orden            INTEGER NOT NULL DEFAULT 1,
      tipo_parada      TEXT NOT NULL
                         CHECK (tipo_parada IN (
                           'entrega_material','entrega_contenedor',
                           'retiro_contenedor','entrega_maquinaria',
                           'retiro_maquinaria'
                         )),
      domicilio        TEXT DEFAULT '',
      zona             TEXT DEFAULT '',
      hora_estimada    TEXT,
      estado           TEXT NOT NULL DEFAULT 'pendiente'
                         CHECK (estado IN ('pendiente','completada','cancelada')),
      observaciones    TEXT DEFAULT '',
      created_at       TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  // ─────────────────────────────────────────────────────────────────
  // BLOQUE 7 — COMPRAS Y PROVEEDORES
  // ─────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS proveedores (
      id         TEXT PRIMARY KEY,
      nombre     TEXT NOT NULL,
      cuit       TEXT,
      domicilio  TEXT,
      telefono   TEXT,
      email      TEXT,
      activo     INTEGER DEFAULT 1,
      created_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS compras_encabezado (
      id            TEXT PRIMARY KEY,
      id_proveedor  TEXT NOT NULL REFERENCES proveedores(id),
      fecha         TEXT NOT NULL DEFAULT to_char(CURRENT_DATE, 'YYYY-MM-DD'),
      estado        TEXT NOT NULL DEFAULT 'emitida'
                      CHECK (estado IN ('emitida','recibida','cancelada')),
      observaciones TEXT DEFAULT '',
      created_at    TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS compras_detalle (
      id              TEXT PRIMARY KEY,
      id_compra       TEXT NOT NULL REFERENCES compras_encabezado(id),
      id_producto     TEXT NOT NULL REFERENCES productos(id),
      cantidad        REAL NOT NULL,
      precio_unitario REAL NOT NULL
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cc_proveedores (
      id               TEXT PRIMARY KEY,
      id_proveedor     TEXT NOT NULL REFERENCES proveedores(id),
      tipo_movimiento  TEXT NOT NULL CHECK (tipo_movimiento IN ('debito','credito')),
      nro_comprobante  TEXT,
      monto_debito     REAL DEFAULT 0,
      monto_credito    REAL DEFAULT 0,
      saldo_resultante REAL DEFAULT 0,
      descripcion      TEXT DEFAULT '',
      fecha            TEXT DEFAULT to_char(CURRENT_DATE, 'YYYY-MM-DD'),
      created_at       TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  // ─────────────────────────────────────────────────────────────────
  // BLOQUE 8 — FLOTA Y MANTENIMIENTO
  // ─────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mantenimiento_vehiculo (
      id            TEXT PRIMARY KEY,
      id_vehiculo   TEXT NOT NULL REFERENCES flota_vehiculos(id),
      tipo_service  TEXT NOT NULL DEFAULT 'preventivo'
                      CHECK (tipo_service IN ('preventivo','correctivo','revision')),
      fecha         TEXT NOT NULL,
      costo         REAL DEFAULT 0,
      km            INTEGER DEFAULT 0,
      proxima_fecha TEXT,
      taller        TEXT DEFAULT '',
      observaciones TEXT DEFAULT '',
      categoria     TEXT DEFAULT 'preventivo',
      descripcion   TEXT DEFAULT '',
      proximo_km    INTEGER,
      archivo       TEXT,
      created_at    TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS combustible (
      id           TEXT PRIMARY KEY,
      id_vehiculo  TEXT NOT NULL REFERENCES flota_vehiculos(id),
      id_chofer    TEXT REFERENCES users(id),
      litros       REAL NOT NULL,
      costo_total  REAL NOT NULL,
      km_al_cargar INTEGER DEFAULT 0,
      fecha        TEXT NOT NULL DEFAULT to_char(CURRENT_DATE, 'YYYY-MM-DD'),
      estacion     TEXT,
      created_at   TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  // ─────────────────────────────────────────────────────────────────
  // BLOQUE 9 — FLOTA DE PERSONAL (RRHH)
  // ─────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS empleados (
      id                        TEXT PRIMARY KEY,
      legajo                    INTEGER UNIQUE,
      nombre                    TEXT NOT NULL,
      apellido                  TEXT NOT NULL DEFAULT '',
      dni                       TEXT,
      fecha_nacimiento          TEXT,
      direccion                 TEXT,
      telefono                  TEXT,
      email                     TEXT,
      cargo                     TEXT,
      sector                    TEXT,
      fecha_ingreso             TEXT,
      estado_laboral            TEXT NOT NULL DEFAULT 'activo'
                                  CHECK (estado_laboral IN ('activo','licencia','suspendido','baja')),
      tipo_contratacion         TEXT,
      salario                   REAL DEFAULT 0,
      bonificaciones            REAL DEFAULT 0,
      descuentos                REAL DEFAULT 0,
      viaticos                  REAL DEFAULT 0,
      horas_extras              REAL DEFAULT 0,
      vehiculo_asignado         TEXT,
      licencia_categoria        TEXT,
      licencia_vencimiento      TEXT,
      certificaciones           TEXT,
      id_usuario                TEXT REFERENCES users(id),
      activo                    INTEGER DEFAULT 1,
      cuil                      TEXT,
      contacto_emergencia       TEXT,
      contacto_emergencia_tel   TEXT,
      convenio                  TEXT,
      categoria_laboral         TEXT,
      sueldo_basico             REAL DEFAULT 0,
      supervisor_id             TEXT,
      es_chofer                 INTEGER DEFAULT 0,
      licencia_numero           TEXT,
      licencia_fecha_emision    TEXT,
      licencia_organismo        TEXT,
      fecha_baja                TEXT,
      motivo_baja               TEXT,
      created_at                TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_empleados_legajo ON empleados(legajo)`)

  // ─────────────────────────────────────────────────────────────────
  // BLOQUE 10 — CHOFERES, FLOTA Y AUXILIARES
  // ─────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS documentos (
      id                TEXT PRIMARY KEY,
      entidad_tipo      TEXT NOT NULL CHECK (entidad_tipo IN ('empleado','vehiculo')),
      entidad_id        TEXT NOT NULL,
      tipo              TEXT NOT NULL,
      descripcion       TEXT DEFAULT '',
      archivo           TEXT,
      fecha_emision     TEXT,
      fecha_vencimiento TEXT,
      created_at        TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_documentos_entidad ON documentos(entidad_tipo, entidad_id)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS asignaciones_chofer (
      id            TEXT PRIMARY KEY,
      id_empleado   TEXT NOT NULL REFERENCES empleados(id),
      id_vehiculo   TEXT NOT NULL REFERENCES flota_vehiculos(id),
      tipo          TEXT NOT NULL DEFAULT 'principal' CHECK (tipo IN ('principal','alternativo')),
      fecha_desde   TEXT NOT NULL DEFAULT to_char(CURRENT_DATE, 'YYYY-MM-DD'),
      fecha_hasta   TEXT,
      activo        INTEGER DEFAULT 1,
      observaciones TEXT DEFAULT '',
      created_at    TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS control_horario (
      id             TEXT PRIMARY KEY,
      id_empleado    TEXT NOT NULL REFERENCES empleados(id),
      fecha          TEXT NOT NULL DEFAULT to_char(CURRENT_DATE, 'YYYY-MM-DD'),
      hora_ingreso   TEXT,
      hora_egreso    TEXT,
      horas_normales REAL DEFAULT 0,
      horas_extra    REAL DEFAULT 0,
      motivo_extra   TEXT DEFAULT '',
      aprobado       INTEGER DEFAULT 0,
      aprobado_por   TEXT,
      observaciones  TEXT DEFAULT '',
      created_at     TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pagos_empleado (
      id          TEXT PRIMARY KEY,
      id_empleado TEXT NOT NULL REFERENCES empleados(id),
      tipo        TEXT NOT NULL CHECK (tipo IN ('sueldo','anticipo','viatico','horas_extra','bonificacion','descuento','liquidacion')),
      periodo     TEXT,
      monto       REAL NOT NULL DEFAULT 0,
      fecha       TEXT NOT NULL DEFAULT to_char(CURRENT_DATE, 'YYYY-MM-DD'),
      descripcion TEXT DEFAULT '',
      created_at  TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS estado_vehiculo_hist (
      id            TEXT PRIMARY KEY,
      id_vehiculo   TEXT NOT NULL REFERENCES flota_vehiculos(id),
      estado        TEXT NOT NULL,
      fecha         TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      id_usuario    TEXT,
      observaciones TEXT DEFAULT ''
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS config_mantenimiento (
      id          TEXT PRIMARY KEY,
      id_vehiculo TEXT REFERENCES flota_vehiculos(id),
      tipo        TEXT NOT NULL,
      cada_km     INTEGER,
      cada_meses  INTEGER,
      descripcion TEXT DEFAULT '',
      created_at  TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS gastos_vehiculo (
      id          TEXT PRIMARY KEY,
      id_vehiculo TEXT NOT NULL REFERENCES flota_vehiculos(id),
      categoria   TEXT NOT NULL CHECK (categoria IN ('seguro','impuesto','peaje','estacionamiento','multa','otro')),
      descripcion TEXT DEFAULT '',
      monto       REAL NOT NULL DEFAULT 0,
      fecha       TEXT NOT NULL DEFAULT to_char(CURRENT_DATE, 'YYYY-MM-DD'),
      vencimiento TEXT,
      estado      TEXT DEFAULT 'pagado',
      archivo     TEXT,
      created_at  TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS gps_posiciones (
      id          TEXT PRIMARY KEY,
      id_vehiculo TEXT NOT NULL REFERENCES flota_vehiculos(id),
      lat         REAL,
      lng         REAL,
      velocidad   REAL,
      estado      TEXT,
      fecha       TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS auditoria (
      id           TEXT PRIMARY KEY,
      entidad_tipo TEXT NOT NULL,
      entidad_id   TEXT NOT NULL,
      accion       TEXT NOT NULL,
      id_usuario   TEXT,
      detalle      TEXT DEFAULT '',
      created_at   TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_auditoria_entidad ON auditoria(entidad_tipo, entidad_id)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS config_notificaciones (
      id         TEXT PRIMARY KEY,
      clave      TEXT NOT NULL UNIQUE,
      valor      TEXT NOT NULL DEFAULT '',
      created_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS asignaciones_recurso (
      id            TEXT PRIMARY KEY,
      id_empleado   TEXT NOT NULL REFERENCES empleados(id),
      recurso_tipo  TEXT NOT NULL CHECK (recurso_tipo IN ('camion','maquina')),
      recurso_id    TEXT NOT NULL,
      fecha_desde   TEXT NOT NULL DEFAULT to_char(CURRENT_DATE, 'YYYY-MM-DD'),
      fecha_hasta   TEXT,
      activo        INTEGER DEFAULT 1,
      observaciones TEXT DEFAULT '',
      created_at    TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_asig_recurso  ON asignaciones_recurso(recurso_tipo, recurso_id, activo)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_asig_empleado ON asignaciones_recurso(id_empleado, activo)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock_ingresos (
      id             TEXT PRIMARY KEY,
      id_producto    TEXT NOT NULL REFERENCES productos(id),
      id_proveedor   TEXT REFERENCES proveedores(id),
      cantidad       REAL NOT NULL,
      costo_unitario REAL DEFAULT 0,
      id_usuario     TEXT,
      observaciones  TEXT DEFAULT '',
      fecha          TEXT NOT NULL DEFAULT to_char(CURRENT_DATE, 'YYYY-MM-DD'),
      created_at     TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  // ─────────────────────────────────────────────────────────────────
  // TABLAS DE CONFIGURACIÓN
  // ─────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS config_contenedores (
      id          TEXT PRIMARY KEY,
      clave       TEXT NOT NULL UNIQUE,
      valor       TEXT NOT NULL DEFAULT '',
      descripcion TEXT DEFAULT '',
      created_at  TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS config_maquinaria (
      id            TEXT PRIMARY KEY,
      id_maquinaria TEXT REFERENCES maquinaria(id),
      clave         TEXT NOT NULL,
      valor         TEXT NOT NULL DEFAULT '',
      created_at    TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      UNIQUE(id_maquinaria, clave)
    )
  `)

  // ─────────────────────────────────────────────────────────────────
  // SEEDS DE CONFIGURACIÓN
  // ─────────────────────────────────────────────────────────────────
  for (const [k, v] of [
    ['email_activo', '0'], ['email_destinatarios', ''], ['umbral_dias', '90,60,30'],
    ['alertas_licencias', '1'], ['alertas_documentos', '1'], ['alertas_mantenimiento', '1'],
  ]) {
    await pool.query(
      `INSERT INTO config_notificaciones (id, clave, valor) VALUES ($1, $2, $3) ON CONFLICT (clave) DO NOTHING`,
      [crypto.randomUUID(), k, v]
    )
  }

  for (const [clave, valor, desc] of [
    ['precio_dia', '30000', 'Precio por día de alquiler'],
    ['precio_alquiler', '250000', 'Precio base alquiler (9+ días)'],
    ['plazo_minimo', '4', 'Plazo mínimo en días'],
    ['plazo_maximo', '9', 'Plazo máximo en días'],
    ['tiempo_entre_alquileres', '0', 'Horas mínimas entre alquileres'],
    ['costo_extra_dia', '30000', 'Costo extra por día adicional'],
  ]) {
    await pool.query(
      `INSERT INTO config_contenedores (id, clave, valor, descripcion) VALUES ($1, $2, $3, $4) ON CONFLICT (clave) DO NOTHING`,
      [crypto.randomUUID(), clave, valor, desc]
    )
  }

  for (const [clave, valor] of [
    ['precio_por_hora_default', '15000'],
    ['precio_por_dia_default', '80000'],
    ['modo_precio_default', 'hora'],
  ]) {
    await pool.query(
      `INSERT INTO config_maquinaria (id, id_maquinaria, clave, valor) VALUES ($1, NULL, $2, $3) ON CONFLICT (id_maquinaria, clave) DO NOTHING`,
      [crypto.randomUUID(), clave, valor]
    )
  }

  // ─────────────────────────────────────────────────────────────────
  // BACKFILLS — numeración de registros sin número interno
  // ─────────────────────────────────────────────────────────────────
  for (const tabla of ['flota_vehiculos', 'maquinaria']) {
    const { rows: pend } = await pool.query(`SELECT id FROM ${tabla} WHERE numero_interno IS NULL ORDER BY created_at, id`)
    if (pend.length) {
      const { rows: [mr] } = await pool.query(`SELECT COALESCE(MAX(numero_interno), 0) AS m FROM ${tabla}`)
      let next = (parseInt(mr.m) || 0) + 1
      await transaction(async (q) => {
        for (const r of pend) {
          await q(`UPDATE ${tabla} SET numero_interno = ? WHERE id = ?`, [next++, r.id])
        }
      })
    }
  }

  // Backfill transacciones sin número
  const { rows: pendTx } = await pool.query(`SELECT id, tipo FROM transacciones WHERE numero IS NULL ORDER BY created_at, id`)
  if (pendTx.length) {
    const { rows: maxRows } = await pool.query(`SELECT tipo, COALESCE(MAX(numero), 0) AS m FROM transacciones WHERE numero IS NOT NULL GROUP BY tipo`)
    const maxPorTipo = {}
    maxRows.forEach(r => { maxPorTipo[r.tipo] = parseInt(r.m) })
    await transaction(async (q) => {
      for (const t of pendTx) {
        const n = (maxPorTipo[t.tipo] || 0) + 1
        maxPorTipo[t.tipo] = n
        await q(`UPDATE transacciones SET numero = ? WHERE id = ?`, [n, t.id])
      }
    })
  }

  // Backfill clientes sin número
  const { rows: pendCli } = await pool.query(`SELECT id FROM clientes WHERE numero IS NULL ORDER BY created_at, id`)
  if (pendCli.length) {
    const { rows: [maxCli] } = await pool.query(`SELECT COALESCE(MAX(numero), 0) AS m FROM clientes`)
    let next = (parseInt(maxCli.m) || 0) + 1
    await transaction(async (q) => {
      for (const c of pendCli) {
        await q(`UPDATE clientes SET numero = ? WHERE id = ?`, [next++, c.id])
      }
    })
  }

  // ─────────────────────────────────────────────────────────────────
  // SEED DE DESARROLLO
  // ─────────────────────────────────────────────────────────────────
  const seedUsuarios = [
    { usuario: 'valentino',      nombre: 'Valentino Mezzavilla', rol: 'dueno'          },
    { usuario: 'admin_ventas',   nombre: 'Admin Ventas',         rol: 'admin_ventas'   },
    { usuario: 'admin_contable', nombre: 'Admin Contable',       rol: 'admin_contable' },
    { usuario: 'chofer1',        nombre: 'Chofer Demo',          rol: 'chofer'         },
  ]
  for (const u of seedUsuarios) {
    await pool.query(
      `INSERT INTO users (id, usuario, password_hash, nombre, rol) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (usuario) DO NOTHING`,
      [crypto.randomUUID(), u.usuario, bcrypt.hashSync('suelosur123', 10), u.nombre, u.rol]
    )
  }

  // Productos
  const { rows: [{ n: cantProd }] } = await pool.query(`SELECT COUNT(*) AS n FROM productos`)
  if (parseInt(cantProd) === 0) {
    for (const [nombre, um, precio] of [
      ['Arena Fina', 'm³', 8500], ['Arena Gruesa', 'm³', 7800],
      ['Piedra Partida', 'm³', 9200], ['Piedra Bola', 'm³', 8800],
      ['Canto Rodado', 'm³', 10500], ['Tosca', 'm³', 5500],
    ]) {
      await pool.query(
        `INSERT INTO productos (id, nombre, unidad_medida, precio_referencia) VALUES ($1,$2,$3,$4)`,
        [crypto.randomUUID(), nombre, um, precio]
      )
    }
  }

  // Stock inicial
  const { rows: sinStock } = await pool.query(`
    SELECT p.id FROM productos p
    WHERE p.activo = 1
      AND NOT EXISTS (SELECT 1 FROM stock s WHERE s.id_producto = p.id)
  `)
  for (const p of sinStock) {
    await pool.query(
      `INSERT INTO stock (id, id_producto, cantidad_actual, cant_pendiente_entregar, stock_minimo) VALUES ($1,$2,0,0,0)`,
      [crypto.randomUUID(), p.id]
    )
  }

  // Clientes
  const { rows: [{ n: cantCli }] } = await pool.query(`SELECT COUNT(*) AS n FROM clientes`)
  if (parseInt(cantCli) === 0) {
    for (const [nombre, apellido, dom, zona, tel, tipo] of [
      ['Construcciones Norte', 'SRL', 'Av. Vélez Sársfield 3200', 'Norte',  '3514001234', 'Empresa'   ],
      ['García',               'Roberto', 'Colón 1420',           'Centro', '3513009876', 'Particular'],
      ['Obra Bv. Chacabuco',   '',   'Bv. Chacabuco 890',         'Sur',    '3512005678', 'Obra'      ],
    ]) {
      await pool.query(
        `INSERT INTO clientes (id, nombre, apellido, domicilio_ppal, zona, tel_whatsapp, tipo_cliente) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [crypto.randomUUID(), nombre, apellido, dom, zona, tel, tipo]
      )
    }
  }

  // Proveedores
  const { rows: [{ n: cantProv }] } = await pool.query(`SELECT COUNT(*) AS n FROM proveedores`)
  if (parseInt(cantProv) === 0) {
    for (const [nombre, cuit, dom, tel, email] of [
      ['Cantera del Centro S.A.', '30-11223344-5', 'Ruta 9 Km 12',        '3514112233', 'ventas@canteracentro.com'],
      ['Áridos del Sur SRL',      '30-55667788-9', 'Camino a Alta Gracia', '3515667788', 'info@aridosdelsur.com'],
      ['Transporte Norte',        '20-99887766-5', 'Av. Japón 1500',       '3513445566', 'contacto@transportenorte.com'],
    ]) {
      await pool.query(
        `INSERT INTO proveedores (id, nombre, cuit, domicilio, telefono, email) VALUES ($1,$2,$3,$4,$5,$6)`,
        [crypto.randomUUID(), nombre, cuit, dom, tel, email]
      )
    }
  }

  // Flota
  const { rows: [{ n: cantFlota }] } = await pool.query(`SELECT COUNT(*) AS n FROM flota_vehiculos`)
  if (parseInt(cantFlota) === 0) {
    for (const [tipo, patente, nombre] of [
      ['camion', 'ABC123', 'Camión 1'], ['camion', 'DEF456', 'Camión 2'],
      ['camion', 'GHI789', 'Camión 3'], ['camion', 'JKL012', 'Camión 4'],
      ['camion', 'MNO345', 'Camión 5'], ['bobcat', 'PQR678', 'Bobcat'],
    ]) {
      await pool.query(
        `INSERT INTO flota_vehiculos (id, tipo_vehiculo, patente, nombre) VALUES ($1,$2,$3,$4)`,
        [crypto.randomUUID(), tipo, patente, nombre]
      )
    }
  }

  // Contenedores
  const { rows: [{ n: cantCont }] } = await pool.query(`SELECT COUNT(*) AS n FROM contenedores`)
  if (parseInt(cantCont) === 0) {
    for (let n = 1; n <= 10; n++) {
      const id = crypto.randomUUID()
      await pool.query(
        `INSERT INTO contenedores (id, numero_contenedor, estado_general) VALUES ($1,$2,'operativo')`,
        [id, n]
      )
      await pool.query(
        `INSERT INTO movimiento_contenedor (id, id_contenedor, estado_paso, observaciones) VALUES ($1,$2,'en_planta','Alta inicial')`,
        [crypto.randomUUID(), id]
      )
    }
  }

  // Maquinaria
  const { rows: [{ n: cantMaq }] } = await pool.query(`SELECT COUNT(*) AS n FROM maquinaria`)
  if (parseInt(cantMaq) === 0) {
    const id = crypto.randomUUID()
    await pool.query(
      `INSERT INTO maquinaria (id, nombre, tipo, patente, estado_general) VALUES ($1,'Bobcat S650','bobcat','PQR678','operativo')`,
      [id]
    )
    await pool.query(
      `INSERT INTO movimiento_maquinaria (id, id_maquinaria, estado_paso, observaciones) VALUES ($1,$2,'en_planta','Alta inicial')`,
      [crypto.randomUUID(), id]
    )
  }

  console.log('✅ Base de datos PostgreSQL inicializada')
}

module.exports = { pool, query, transaction, initDB }
