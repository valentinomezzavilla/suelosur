'use strict'
// ═══════════════════════════════════════════════════════════════════
// db.js — Base de datos · Suelosur S.A.S.
// pg (async) · PostgreSQL / Supabase
// ═══════════════════════════════════════════════════════════════════

const { Pool, types } = require('pg')
const bcrypt  = require('bcryptjs')

// Parsear NUMERIC / BIGINT / INT8 como números JS (no como strings).
// Sin esto, sumas como "$1500" se ven como "1500" sin formato porque toLocaleString()
// sobre un string no aplica el separador de miles.
types.setTypeParser(1700, (v) => v == null ? null : parseFloat(v)) // NUMERIC
types.setTypeParser(20,   (v) => v == null ? null : parseInt(v, 10)) // BIGINT / int8

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,                       // máximo de conexiones simultáneas
  idleTimeoutMillis: 30000,      // cerrar conexiones idle a los 30s
  connectionTimeoutMillis: 10000,// timeout para conectar (10s)
  statement_timeout: 30000,      // matar queries que tarden +30s
})

// Evitar que un error suelto del pool tire el proceso
pool.on('error', (err) => {
  console.error('Pool PG error (idle client):', err.message)
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
      id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
      id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
      id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      cliente_id  BIGINT NOT NULL REFERENCES clientes(id),
      tipo        TEXT NOT NULL CHECK (tipo IN ('deuda','pago','ajuste')),
      descripcion TEXT NOT NULL DEFAULT '',
      monto       REAL NOT NULL,
      created_at  TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS productos (
      id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      nombre            TEXT NOT NULL,
      unidad_medida     TEXT NOT NULL DEFAULT 'm³',
      precio_referencia REAL DEFAULT 0,
      precio_cantera    REAL DEFAULT 0,
      precio_viaje      REAL DEFAULT 0,
      activo            INTEGER DEFAULT 1,
      created_at        TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock (
      id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_producto             BIGINT NOT NULL UNIQUE REFERENCES productos(id),
      cantidad_actual         REAL DEFAULT 0,
      cant_pendiente_entregar REAL DEFAULT 0,
      stock_minimo            REAL DEFAULT 0
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS flota_vehiculos (
      id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
      id                        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_cliente                BIGINT NOT NULL REFERENCES clientes(id),
      id_administrativo         BIGINT NOT NULL REFERENCES users(id),
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
      id_chofer                 BIGINT,
      id_camion                 BIGINT,
      asignacion_fecha          TEXT,
      asignacion_usuario        BIGINT,
      firma_cliente             TEXT,
      firma_aclaracion          TEXT,
      archivo_remito_pdf        TEXT,
      firma_retiro              TEXT,
      firma_retiro_aclaracion   TEXT,
      archivo_remito_retiro     TEXT,
      created_at                TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS op_detalle_material (
      id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_orden_pedido BIGINT NOT NULL REFERENCES op_encabezado(id),
      id_producto     BIGINT NOT NULL REFERENCES productos(id),
      cantidad_pedida REAL NOT NULL,
      precio_unitario REAL NOT NULL
    )
  `)

  // Catálogos referenciados por op_detalle_*: deben crearse ANTES
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contenedores (
      id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
    CREATE TABLE IF NOT EXISTS maquinaria (
      id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
    CREATE TABLE IF NOT EXISTS op_detalle_contenedor (
      id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_orden_pedido      BIGINT NOT NULL REFERENCES op_encabezado(id),
      id_contenedor        BIGINT REFERENCES contenedores(id),
      domicilio_entrega    TEXT NOT NULL DEFAULT '',
      zona_entrega         TEXT NOT NULL DEFAULT '',
      plazo_alquiler       INTEGER NOT NULL DEFAULT 5,
      precio_alquiler      REAL DEFAULT 0,
      domicilio_calle      TEXT,
      domicilio_numero     TEXT,
      domicilio_lat        REAL,
      domicilio_lng        REAL,
      alquiler_siguiente_id BIGINT,
      metodo_pago          TEXT
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS op_detalle_maquinaria (
      id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_orden_pedido   BIGINT NOT NULL REFERENCES op_encabezado(id),
      id_maquinaria     BIGINT REFERENCES maquinaria(id),
      domicilio_entrega TEXT NOT NULL DEFAULT '',
      zona_entrega      TEXT NOT NULL DEFAULT '',
      plazo_alquiler    INTEGER NOT NULL DEFAULT 1,
      precio_por_hora   REAL DEFAULT 0,
      horas_pactadas    REAL DEFAULT 0,
      precio_total      REAL DEFAULT 0,
      id_chofer         BIGINT REFERENCES users(id),
      domicilio_calle   TEXT,
      domicilio_numero  TEXT,
      metodo_pago       TEXT
    )
  `)

  // ─────────────────────────────────────────────────────────────────
  // BLOQUE 3 — CONTENEDORES (movimientos; tabla principal creada arriba)
  // ─────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS movimiento_contenedor (
      id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_contenedor    BIGINT NOT NULL REFERENCES contenedores(id),
      id_op_contenedor BIGINT REFERENCES op_detalle_contenedor(id),
      id_chofer        BIGINT REFERENCES users(id),
      id_camion        BIGINT REFERENCES flota_vehiculos(id),
      fecha_movimiento TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      estado_paso      TEXT NOT NULL
                         CHECK (estado_paso IN (
                           'disponible','pendiente_despacho','despachado',
                           'en_alquiler','pendiente_retiro'
                         )),
      observaciones    TEXT DEFAULT ''
    )
  `)

  // ─────────────────────────────────────────────────────────────────
  // BLOQUE 4 — MAQUINARIA (movimientos; tabla principal creada arriba)
  // ─────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS movimiento_maquinaria (
      id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_maquinaria    BIGINT NOT NULL REFERENCES maquinaria(id),
      id_op_maquinaria BIGINT REFERENCES op_detalle_maquinaria(id),
      id_operario      BIGINT REFERENCES users(id),
      id_camion        BIGINT REFERENCES flota_vehiculos(id),
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
      id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_maquinaria BIGINT NOT NULL REFERENCES maquinaria(id),
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
      id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      tipo             TEXT NOT NULL
                         CHECK (tipo IN (
                           'Venta Cantera','Venta Viaje',
                           'Alquiler','Maquinaria','Ajuste'
                         )),
      id_op_encabezado BIGINT REFERENCES op_encabezado(id),
      nro_remito       INTEGER,
      cliente_id       BIGINT REFERENCES clientes(id),
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
      id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      fecha         TEXT NOT NULL DEFAULT to_char(CURRENT_DATE, 'YYYY-MM-DD'),
      id_chofer     BIGINT REFERENCES users(id),
      id_camion     BIGINT REFERENCES flota_vehiculos(id),
      id_empleado   BIGINT,
      estado        TEXT NOT NULL DEFAULT 'borrador'
                      CHECK (estado IN ('borrador','confirmado','en_curso','finalizado')),
      observaciones TEXT DEFAULT '',
      created_at    TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS circuito_paradas (
      id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_circuito      BIGINT NOT NULL REFERENCES circuitos(id),
      id_op_encabezado BIGINT REFERENCES op_encabezado(id),
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
      id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
      id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_proveedor  BIGINT NOT NULL REFERENCES proveedores(id),
      fecha         TEXT NOT NULL DEFAULT to_char(CURRENT_DATE, 'YYYY-MM-DD'),
      estado        TEXT NOT NULL DEFAULT 'emitida'
                      CHECK (estado IN ('emitida','recibida','cancelada')),
      observaciones TEXT DEFAULT '',
      created_at    TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS compras_detalle (
      id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_compra       BIGINT NOT NULL REFERENCES compras_encabezado(id),
      id_producto     BIGINT NOT NULL REFERENCES productos(id),
      cantidad        REAL NOT NULL,
      precio_unitario REAL NOT NULL
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cc_proveedores (
      id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_proveedor     BIGINT NOT NULL REFERENCES proveedores(id),
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
      id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_vehiculo   BIGINT NOT NULL REFERENCES flota_vehiculos(id),
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
      id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_vehiculo  BIGINT NOT NULL REFERENCES flota_vehiculos(id),
      id_chofer    BIGINT REFERENCES users(id),
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
      id                        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
      id_usuario                BIGINT REFERENCES users(id),
      activo                    INTEGER DEFAULT 1,
      cuil                      TEXT,
      contacto_emergencia       TEXT,
      contacto_emergencia_tel   TEXT,
      convenio                  TEXT,
      categoria_laboral         TEXT,
      sueldo_basico             REAL DEFAULT 0,
      supervisor_id             BIGINT,
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
      id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      entidad_tipo      TEXT NOT NULL CHECK (entidad_tipo IN ('empleado','vehiculo')),
      entidad_id        BIGINT NOT NULL,
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
    CREATE TABLE IF NOT EXISTS control_horario (
      id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_empleado    BIGINT NOT NULL REFERENCES empleados(id),
      fecha          TEXT NOT NULL DEFAULT to_char(CURRENT_DATE, 'YYYY-MM-DD'),
      hora_ingreso   TEXT,
      hora_egreso    TEXT,
      horas_normales REAL DEFAULT 0,
      horas_extra    REAL DEFAULT 0,
      motivo_extra   TEXT DEFAULT '',
      aprobado       INTEGER DEFAULT 0,
      aprobado_por   BIGINT,
      observaciones  TEXT DEFAULT '',
      created_at     TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pagos_empleado (
      id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_empleado BIGINT NOT NULL REFERENCES empleados(id),
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
      id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_vehiculo   BIGINT NOT NULL REFERENCES flota_vehiculos(id),
      estado        TEXT NOT NULL,
      fecha         TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      id_usuario    BIGINT,
      observaciones TEXT DEFAULT ''
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS config_mantenimiento (
      id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_vehiculo BIGINT REFERENCES flota_vehiculos(id),
      tipo        TEXT NOT NULL,
      cada_km     INTEGER,
      cada_meses  INTEGER,
      descripcion TEXT DEFAULT '',
      created_at  TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS gastos_vehiculo (
      id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_vehiculo BIGINT NOT NULL REFERENCES flota_vehiculos(id),
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
    CREATE TABLE IF NOT EXISTS rastreo_chofer (
      id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_op               BIGINT REFERENCES op_encabezado(id),
      id_empleado         BIGINT NOT NULL REFERENCES empleados(id),
      lat                 REAL,
      lng                 REAL,
      velocidad           REAL DEFAULT 0,
      exactitud           REAL,
      fecha_registro      TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rastreo_op ON rastreo_chofer(id_op)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rastreo_empleado ON rastreo_chofer(id_empleado)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rastreo_fecha ON rastreo_chofer(fecha_registro DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS auditoria (
      id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      entidad_tipo TEXT NOT NULL,
      entidad_id   BIGINT NOT NULL,
      accion       TEXT NOT NULL,
      id_usuario   BIGINT,
      detalle      TEXT DEFAULT '',
      created_at   TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_auditoria_entidad ON auditoria(entidad_tipo, entidad_id)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS config_notificaciones (
      id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      clave      TEXT NOT NULL UNIQUE,
      valor      TEXT NOT NULL DEFAULT '',
      created_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS asignaciones_recurso (
      id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_empleado   BIGINT NOT NULL REFERENCES empleados(id),
      recurso_tipo  TEXT NOT NULL CHECK (recurso_tipo IN ('camion','maquina')),
      recurso_id    BIGINT NOT NULL,
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
      id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_producto    BIGINT NOT NULL REFERENCES productos(id),
      id_proveedor   BIGINT REFERENCES proveedores(id),
      cantidad       REAL NOT NULL,
      costo_unitario REAL DEFAULT 0,
      costo_flete    REAL DEFAULT 0,
      id_usuario     BIGINT,
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
      id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      clave       TEXT NOT NULL UNIQUE,
      valor       TEXT NOT NULL DEFAULT '',
      descripcion TEXT DEFAULT '',
      created_at  TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS config_maquinaria (
      id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_maquinaria BIGINT REFERENCES maquinaria(id),
      clave         TEXT NOT NULL,
      valor         TEXT NOT NULL DEFAULT '',
      created_at    TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      UNIQUE(id_maquinaria, clave)
    )
  `)

  // ─────────────────────────────────────────────────────────────────
  // MEJORAS FUNCIONALES — columnas nuevas + historial de kilometraje
  // ─────────────────────────────────────────────────────────────────
  // Empleados: vencimiento de pago, especialización y anticipación de licencia
  await pool.query(`ALTER TABLE empleados ADD COLUMN IF NOT EXISTS fecha_vencimiento_pago TEXT`).catch(() => {})
  await pool.query(`ALTER TABLE empleados ADD COLUMN IF NOT EXISTS tipo_operacion TEXT`).catch(() => {})
  await pool.query(`ALTER TABLE empleados ADD COLUMN IF NOT EXISTS licencia_dias_alerta INTEGER DEFAULT 30`).catch(() => {})
  // Flota y maquinaria: actividad para la que está destinada la unidad
  await pool.query(`ALTER TABLE flota_vehiculos ADD COLUMN IF NOT EXISTS actividad TEXT`).catch(() => {})
  await pool.query(`ALTER TABLE maquinaria ADD COLUMN IF NOT EXISTS actividad TEXT`).catch(() => {})
  // Documentos: anticipación de la alerta configurable por documento
  await pool.query(`ALTER TABLE documentos ADD COLUMN IF NOT EXISTS dias_alerta INTEGER DEFAULT 30`).catch(() => {})
  // Zona del viaje (venta con flete) para tarifa y planificación logística
  await pool.query(`ALTER TABLE op_encabezado ADD COLUMN IF NOT EXISTS zona TEXT`).catch(() => {})
  // Hora planificada de la operación (para detectar solapamientos de camión/chofer)
  await pool.query(`ALTER TABLE op_encabezado ADD COLUMN IF NOT EXISTS hora_planificada TEXT`).catch(() => {})
  // Obra: nombre/referencia del destino cuando no hay una dirección de calle exacta
  await pool.query(`ALTER TABLE op_encabezado ADD COLUMN IF NOT EXISTS obra TEXT`).catch(() => {})
  // Ventas: flete y total pactado. El detalle solo guarda productos, así que sin estas
  // columnas un viaje programado perdía el flete (y cualquier total editado a mano)
  // hasta que se entregaba.
  await pool.query(`ALTER TABLE op_encabezado ADD COLUMN IF NOT EXISTS precio_flete REAL`).catch(() => {})
  await pool.query(`ALTER TABLE op_encabezado ADD COLUMN IF NOT EXISTS monto_total REAL`).catch(() => {})
  // Backfill: las ventas ya entregadas tienen el total real en su transacción.
  await pool.query(`
    UPDATE op_encabezado op SET monto_total = t.monto
    FROM (SELECT DISTINCT ON (id_op_encabezado) id_op_encabezado, monto FROM transacciones
          WHERE tipo IN ('Venta Viaje', 'Venta Cantera') AND id_op_encabezado IS NOT NULL
          ORDER BY id_op_encabezado, id) t
    WHERE t.id_op_encabezado = op.id AND op.tipo_op = 'M' AND op.monto_total IS NULL
  `).catch(e => console.error('Backfill monto_total:', e.message))
  // En los viajes viejos lo que el total supera a los productos es el flete.
  await pool.query(`
    UPDATE op_encabezado op SET precio_flete = op.monto_total - s.subtotal
    FROM (SELECT id_orden_pedido, SUM(cantidad_pedida * precio_unitario) AS subtotal
          FROM op_detalle_material GROUP BY id_orden_pedido) s
    WHERE s.id_orden_pedido = op.id AND op.tipo_op = 'M' AND op.modalidad = 'flete'
      AND op.precio_flete IS NULL AND op.monto_total > s.subtotal + 0.5
  `).catch(e => console.error('Backfill precio_flete:', e.message))
  // Backfill: transacciones de "Venta Viaje" creadas antes de que el destino (obra o
  // calle/número) se sumara a la descripción quedaron como "Viaje a " sin nada después.
  // Se recomponen con los datos ya cargados de la operación.
  ;(async () => {
    const { textoDestino } = require('../utils/destino')
    const rotas = (await pool.query(`
      SELECT t.id, op.domicilio_calle, op.domicilio_altura, op.obra, op.observaciones
      FROM transacciones t JOIN op_encabezado op ON op.id = t.id_op_encabezado
      WHERE t.tipo = 'Venta Viaje' AND TRIM(t.descripcion) = 'Viaje a'
    `)).rows
    for (const r of rotas) {
      const destino = textoDestino({ calle: r.domicilio_calle, numero: r.domicilio_altura, obra: r.obra })
      const nueva = [destino ? `Viaje a ${destino}` : 'Venta con viaje', r.observaciones].filter(Boolean).join(' — ')
      await query(`UPDATE transacciones SET descripcion = ? WHERE id = ?`, [nueva, r.id])
    }
    if (rotas.length) console.log(`✅ Backfill: ${rotas.length} descripción(es) de "Venta Viaje" completadas con el destino.`)
  })().catch(e => console.error('Backfill descripción Venta Viaje:', e.message))
  // Cuenta corriente: método de pago del movimiento (para pagos / abonos)
  await pool.query(`ALTER TABLE movimientos_cuenta ADD COLUMN IF NOT EXISTS metodo_pago TEXT`).catch(() => {})
  // Cuenta corriente: venta de origen del cargo (para saber, venta por venta, si ya fue saldada)
  await pool.query(`ALTER TABLE movimientos_cuenta ADD COLUMN IF NOT EXISTS id_op_encabezado BIGINT REFERENCES op_encabezado(id)`).catch(() => {})
  // Backfill: las deudas de cta. corriente cargadas antes de que existiera esta columna
  // quedan sin vincular a su venta/alquiler de origen. Sin ese vínculo, corregir el
  // método de pago de esa transacción (pasarla a efectivo/transferencia) no puede
  // revertir el cargo correspondiente y el saldo del cliente queda mal. Se vincula por
  // mejor esfuerzo: mismo cliente, mismo monto (con signo invertido) y la transacción
  // más cercana en el tiempo — no hay una relación explícita en los datos viejos.
  // Sin await a propósito: es "mejor esfuerzo", no crítica para arrancar. Si se
  // queda esperando una conexión (ej. problema de red puntual), no puede trabar el
  // arranque del server ni el bind del puerto.
  ;(async () => {
    const sinVincular = (await pool.query(
      `SELECT id, cliente_id, monto, created_at FROM movimientos_cuenta WHERE tipo = 'deuda' AND id_op_encabezado IS NULL`
    )).rows
    if (!sinVincular.length) return
    const candidatas = (await pool.query(
      `SELECT id_op_encabezado, cliente_id, monto, COALESCE(fecha, created_at) AS fecha FROM transacciones
       WHERE metodo_pago = 'cuenta_corriente' AND id_op_encabezado IS NOT NULL`
    )).rows
    const usadas = new Set()
    for (const d of sinVincular) {
      let mejor = null, mejorDif = Infinity
      for (const c of candidatas) {
        if (usadas.has(c.id_op_encabezado)) continue
        if (c.cliente_id !== d.cliente_id) continue
        if (Math.abs(Number(c.monto) + Number(d.monto)) > 0.01) continue
        const dif = Math.abs(new Date(c.fecha) - new Date(d.created_at))
        if (dif < mejorDif) { mejorDif = dif; mejor = c }
      }
      if (mejor) {
        usadas.add(mejor.id_op_encabezado)
        await pool.query(`UPDATE movimientos_cuenta SET id_op_encabezado = $1 WHERE id = $2`, [mejor.id_op_encabezado, d.id])
      }
    }
  })().catch(e => console.error('Backfill id_op_encabezado (movimientos_cuenta):', e.message))
  // Facturación: operaciones marcadas "para facturar" y su estado de facturación.
  // monto_facturar guarda el total cargado al crear (la venta con viaje no guarda el flete hasta entregarse).
  for (const col of [
    'para_facturar INTEGER DEFAULT 0',
    'monto_facturar REAL',
    'facturado INTEGER DEFAULT 0',
    'nro_factura TEXT',
    'fecha_factura TEXT',
    'facturado_por BIGINT',
    'facturado_en TEXT',
  ]) {
    await pool.query(`ALTER TABLE op_encabezado ADD COLUMN IF NOT EXISTS ${col}`).catch(() => {})
  }
  // Una factura puede cubrir varias OP del mismo cliente; la nota de crédito se registra por OP anulada.
  for (const col of ['factura_id BIGINT', 'nc_numero TEXT', 'nc_fecha TEXT', 'nc_cae TEXT']) {
    await pool.query(`ALTER TABLE op_encabezado ADD COLUMN IF NOT EXISTS ${col}`).catch(() => {})
  }
  // Datos fiscales del cliente (condicion_iva: RI / MT / EX / CF)
  for (const col of ['cuit TEXT', 'razon_social TEXT', 'condicion_iva TEXT']) {
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS ${col}`).catch(() => {})
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS facturas (
      id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      cliente_id             BIGINT REFERENCES clientes(id),
      tipo_comprobante       TEXT NOT NULL CHECK (tipo_comprobante IN ('A','B','C')),
      punto_venta            INTEGER,
      nro_cbte               INTEGER,
      numero                 TEXT NOT NULL,
      fecha                  TEXT NOT NULL,
      receptor_nombre        TEXT,
      receptor_cuit          TEXT,
      receptor_condicion_iva TEXT,
      alicuota_iva           REAL DEFAULT 0,
      neto                   REAL DEFAULT 0,
      iva                    REAL DEFAULT 0,
      total                  REAL DEFAULT 0,
      origen                 TEXT NOT NULL DEFAULT 'manual' CHECK (origen IN ('manual','afip')),
      cae                    TEXT,
      cae_vto                TEXT,
      estado                 TEXT NOT NULL DEFAULT 'emitida' CHECK (estado IN ('emitida','revertida')),
      id_usuario             BIGINT REFERENCES users(id),
      created_at             TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)
  // Ticket de acceso de AFIP (WSAA): dura 12 h y AFIP rechaza pedir otro mientras siga vigente,
  // por eso se persiste (el filesystem de Render es efímero).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS afip_ta (
      servicio TEXT NOT NULL,
      entorno  TEXT NOT NULL,
      token    TEXT NOT NULL,
      sign     TEXT NOT NULL,
      expira   TEXT NOT NULL,
      PRIMARY KEY (servicio, entorno)
    )
  `)
  // Datos para facturar (se cargan desde Facturación › Configuración). Fila única.
  // La clave privada del certificado se guarda cifrada (ver utils/cifrado.js).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS config_facturacion (
      id            INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      cuit          TEXT,
      condicion_iva TEXT NOT NULL DEFAULT 'RI' CHECK (condicion_iva IN ('RI','MT')),
      pto_vta       INTEGER,
      entorno       TEXT NOT NULL DEFAULT 'homologacion' CHECK (entorno IN ('homologacion','produccion')),
      cert_pem      TEXT,
      cert_huella   TEXT,
      key_cifrada   TEXT,
      updated_by    BIGINT REFERENCES users(id),
      updated_at    TEXT
    )
  `)
  await pool.query(`INSERT INTO config_facturacion (id) VALUES (1) ON CONFLICT (id) DO NOTHING`)

  // Categorías de egreso: 'material' y 'sueldo' son categorías del sistema (mueven stock /
  // generan recibo de sueldo) y no se pueden editar ni borrar. El resto se administra
  // libremente desde Compras / Pagos → Administrar categorías: cada una declara qué campos
  // opcionales usa (proveedor, producto, vehiculo, empleado, fletero, periodo).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS categorias_egreso (
      id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      clave      TEXT NOT NULL UNIQUE,
      etiqueta   TEXT NOT NULL,
      campos     TEXT NOT NULL DEFAULT '[]',
      campos_custom TEXT NOT NULL DEFAULT '[]',
      badge      TEXT NOT NULL DEFAULT 'badge-pendiente',
      sistema    INTEGER NOT NULL DEFAULT 0,
      activo     INTEGER NOT NULL DEFAULT 1,
      orden      INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)
  const categoriasSemilla = [
    ['material',     'Material (ingresa a stock)', [],            'badge-en-transito', 1, 1],
    ['sueldo',       'Sueldo',                     [],            'badge-activo',      1, 2],
    ['proveedor',    'Pago a proveedor',           ['proveedor'], 'badge-pendiente',   0, 3],
    ['seguro',       'Seguro',                     ['vehiculo'],  'badge-alerta',      0, 4],
    ['mantenimiento','Mantenimiento / Service',    ['vehiculo'],  'badge-pendiente',   0, 5],
    ['combustible',  'Combustible',                ['vehiculo'],  'badge-en-transito', 0, 6],
    ['impuesto',     'Impuesto / Multa',           ['vehiculo'],  'badge-alerta',      0, 7],
    ['otro',         'Otro',                       [],            'badge-pendiente',   0, 8],
  ]
  for (const [clave, etiqueta, campos, badge, sistema, orden] of categoriasSemilla) {
    await pool.query(`
      INSERT INTO categorias_egreso (clave, etiqueta, campos, badge, sistema, orden)
      VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (clave) DO NOTHING
    `, [clave, etiqueta, JSON.stringify(campos), badge, sistema, orden])
  }

  // Egresos: libro único de salidas de dinero (compras / pagos). Categoriza cada
  // salida (material, sueldo, seguro, proveedor, etc. — ver categorias_egreso) y la
  // vincula opcionalmente a proveedor / producto / empleado / vehículo. Alimentado a
  // mano o automático desde alertas.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS egresos (
      id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      fecha        TEXT NOT NULL DEFAULT to_char(CURRENT_DATE, 'YYYY-MM-DD'),
      categoria    TEXT NOT NULL,
      descripcion  TEXT NOT NULL DEFAULT '',
      monto        REAL NOT NULL DEFAULT 0,
      metodo_pago  TEXT,
      fletero      TEXT,
      periodo      TEXT,
      id_proveedor BIGINT REFERENCES proveedores(id),
      id_producto  BIGINT REFERENCES productos(id),
      id_empleado  BIGINT REFERENCES empleados(id),
      id_vehiculo  BIGINT REFERENCES flota_vehiculos(id),
      datos_extra  TEXT DEFAULT '{}',
      origen       TEXT DEFAULT 'manual',
      id_usuario   BIGINT,
      created_at   TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_egresos_fecha     ON egresos(fecha)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_egresos_categoria ON egresos(categoria)`)
  // Categorías ahora son dinámicas (tabla categorias_egreso): la restricción fija de
  // valores posibles se sacó de la definición de la tabla de arriba (nuevas instalaciones);
  // esto la saca también en bases ya existentes.
  await pool.query(`ALTER TABLE egresos DROP CONSTRAINT IF EXISTS egresos_categoria_check`).catch(() => {})
  await pool.query(`ALTER TABLE egresos ADD COLUMN IF NOT EXISTS periodo TEXT`).catch(() => {})
  await pool.query(`ALTER TABLE egresos ADD COLUMN IF NOT EXISTS datos_extra TEXT DEFAULT '{}'`).catch(() => {})
  // Campos personalizados por categoría (tipo texto/número/fecha/lista + etiqueta propia),
  // además de los campos fijos (proveedor, producto, vehiculo, empleado, fletero, periodo).
  await pool.query(`ALTER TABLE categorias_egreso ADD COLUMN IF NOT EXISTS campos_custom TEXT NOT NULL DEFAULT '[]'`).catch(() => {})

  // Pagos a empleados: cada pago queda en DOS lugares (el libro de compras / pagos y la
  // pestaña de pagos del chofer) y se vinculan entre sí. `monto` es el NETO pagado;
  // sueldo_base / descuentos / adiciones guardan cómo se llegó a ese neto (recibo de sueldo).
  await pool.query(`ALTER TABLE pagos_empleado ADD COLUMN IF NOT EXISTS sueldo_base REAL`).catch(() => {})
  await pool.query(`ALTER TABLE pagos_empleado ADD COLUMN IF NOT EXISTS descuentos REAL DEFAULT 0`).catch(() => {})
  await pool.query(`ALTER TABLE pagos_empleado ADD COLUMN IF NOT EXISTS adiciones REAL DEFAULT 0`).catch(() => {})
  await pool.query(`ALTER TABLE pagos_empleado ADD COLUMN IF NOT EXISTS metodo_pago TEXT`).catch(() => {})
  await pool.query(`ALTER TABLE pagos_empleado ADD COLUMN IF NOT EXISTS id_usuario BIGINT`).catch(() => {})
  await pool.query(`ALTER TABLE pagos_empleado ADD COLUMN IF NOT EXISTS id_egreso BIGINT`).catch(() => {})
  await pool.query(`ALTER TABLE egresos ADD COLUMN IF NOT EXISTS id_pago_empleado BIGINT`).catch(() => {})
  // Backfill: los egresos de sueldo cargados antes de este vínculo no figuraban en la
  // pestaña de pagos del chofer. Se crea (o se reutiliza, si el alta por alerta ya había
  // creado el pago suelto) el pago correspondiente y se vinculan. Idempotente.
  ;(async () => {
    const sueltos = (await pool.query(`
      SELECT id, fecha, monto, descripcion, metodo_pago, id_empleado, id_usuario
      FROM egresos WHERE categoria = 'sueldo' AND id_empleado IS NOT NULL AND id_pago_empleado IS NULL
    `)).rows
    for (const e of sueltos) {
      const igual = (await query(`
        SELECT id FROM pagos_empleado
        WHERE id_egreso IS NULL AND id_empleado = ? AND ABS(monto - ?) < 0.01 AND fecha = ? LIMIT 1
      `, [e.id_empleado, e.monto, e.fecha])).rows[0]
      let idPago = igual && igual.id
      if (!idPago) {
        // Un "vale" o adelanto se anota como anticipo; el resto como sueldo
        const tipo = /vale|adelanto|anticipo/i.test(e.descripcion || '') ? 'anticipo' : 'sueldo'
        idPago = (await query(`
          INSERT INTO pagos_empleado (id_empleado, tipo, periodo, monto, sueldo_base, fecha, descripcion, metodo_pago, id_usuario)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
        `, [e.id_empleado, tipo, String(e.fecha).slice(0, 7), e.monto, e.monto, e.fecha, e.descripcion || '', e.metodo_pago, e.id_usuario])).rows[0].id
      }
      await query(`UPDATE pagos_empleado SET id_egreso = ? WHERE id = ?`, [e.id, idPago])
      await query(`UPDATE egresos SET id_pago_empleado = ? WHERE id = ?`, [idPago, e.id])
    }
    if (sueltos.length) console.log(`✅ Backfill: ${sueltos.length} pago(s) de sueldo vinculados a la pestaña de pagos del empleado.`)
  })().catch(e => console.error('Backfill pagos de sueldo:', e.message))

  // Cheques: cartera de cheques recibidos (de clientes) y emitidos (a proveedores /
  // empleados). Guarda todos los datos del cheque y su estado en la cartera.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cheques (
      id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      tipo_cartera   TEXT NOT NULL CHECK (tipo_cartera IN ('recibido','emitido')),
      numero         TEXT,
      monto          REAL NOT NULL DEFAULT 0,
      tipo           TEXT NOT NULL DEFAULT 'fisico' CHECK (tipo IN ('fisico','echeq')),
      banco          TEXT,
      a_nombre_de    TEXT,
      fecha_pago     TEXT,
      fecha_vencimiento TEXT,
      estado         TEXT NOT NULL DEFAULT 'en_espera' CHECK (estado IN ('habilitado','deshabilitado','en_espera')),
      id_cliente     BIGINT REFERENCES clientes(id),
      id_proveedor   BIGINT REFERENCES proveedores(id),
      id_empleado    BIGINT REFERENCES empleados(id),
      descripcion    TEXT DEFAULT '',
      id_usuario     BIGINT,
      created_at     TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cheques_estado ON cheques(estado)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cheques_cartera ON cheques(tipo_cartera)`)
  // Movimiento de cuenta corriente que generó el cheque al habilitarse (para poder revertir).
  await pool.query(`ALTER TABLE cheques ADD COLUMN IF NOT EXISTS id_mov_cuenta BIGINT`).catch(() => {})
  // Unificación de actividades a 3 categorías: ventas / contenedores / maquinas
  const _mapAct = `CASE actividad
      WHEN 'camion_viajes' THEN 'ventas' WHEN 'camion_contenedores' THEN 'contenedores'
      WHEN 'maquina_deposito' THEN 'maquinas' WHEN 'maquina_alquiler' THEN 'maquinas'
      ELSE actividad END`
  await pool.query(`UPDATE flota_vehiculos SET actividad = ${_mapAct} WHERE actividad IN ('camion_viajes','camion_contenedores','maquina_deposito','maquina_alquiler')`).catch(() => {})
  await pool.query(`UPDATE maquinaria SET actividad = ${_mapAct} WHERE actividad IN ('camion_viajes','camion_contenedores','maquina_deposito','maquina_alquiler')`).catch(() => {})
  await pool.query(`UPDATE empleados SET tipo_operacion = CASE tipo_operacion
      WHEN 'camion_viajes' THEN 'ventas' WHEN 'camion_contenedores' THEN 'contenedores'
      WHEN 'maquina_deposito' THEN 'maquinas' WHEN 'maquina_alquiler' THEN 'maquinas'
      ELSE tipo_operacion END
    WHERE tipo_operacion IN ('camion_viajes','camion_contenedores','maquina_deposito','maquina_alquiler')`).catch(() => {})
  // Catálogo de zonas (con tarifa de flete configurable)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS zonas (
      id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      nombre       TEXT NOT NULL UNIQUE,
      tarifa_flete REAL DEFAULT 0,
      orden        INTEGER DEFAULT 0,
      activo       INTEGER DEFAULT 1,
      created_at   TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)
  // Seed de zonas estándar SOLO si la tabla está vacía: las zonas se administran desde
  // /zonas, así que reinsertarlas en cada arranque revertiría borrados y renombrados.
  if (Number((await pool.query(`SELECT COUNT(*) AS n FROM zonas`)).rows[0].n) === 0) {
    for (const [nombre, orden] of [['Norte', 1], ['Sur', 2], ['Este', 3], ['Oeste', 4], ['Centro', 5]]) {
      await pool.query(`INSERT INTO zonas (nombre, orden) VALUES ($1, $2) ON CONFLICT (nombre) DO NOTHING`, [nombre, orden])
    }
  }
  // Historial de kilometraje (auditoría de incrementos automáticos)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS historial_kilometraje (
      id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_vehiculo   BIGINT NOT NULL REFERENCES flota_vehiculos(id),
      id_op         BIGINT REFERENCES op_encabezado(id),
      km_anterior   INTEGER NOT NULL DEFAULT 0,
      km_nuevo      INTEGER NOT NULL DEFAULT 0,
      distancia     REAL DEFAULT 0,
      motivo        TEXT DEFAULT '',
      fecha         TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_histkm_vehiculo ON historial_kilometraje(id_vehiculo)`)

  // ─────────────────────────────────────────────────────────────────
  // SEEDS DE CONFIGURACIÓN
  // ─────────────────────────────────────────────────────────────────
  for (const [k, v] of [
    ['email_activo', '0'], ['email_destinatarios', ''], ['umbral_dias', '90,60,30'],
    ['alertas_licencias', '1'], ['alertas_documentos', '1'], ['alertas_mantenimiento', '1'],
  ]) {
    await pool.query(
      `INSERT INTO config_notificaciones (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO NOTHING`,
      [k, v]
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
      `INSERT INTO config_contenedores (clave, valor, descripcion) VALUES ($1, $2, $3) ON CONFLICT (clave) DO NOTHING`,
      [clave, valor, desc]
    )
  }

  for (const [clave, valor] of [
    ['precio_por_hora_default', '15000'],
    ['precio_por_dia_default', '80000'],
    ['modo_precio_default', 'hora'],
  ]) {
    // id_maquinaria NULL = config global. ON CONFLICT no sirve con NULL
    // (NULL ≠ NULL), por eso se usa un guard explícito para no duplicar.
    await pool.query(
      `INSERT INTO config_maquinaria (id_maquinaria, clave, valor)
       SELECT NULL, $1, $2
       WHERE NOT EXISTS (SELECT 1 FROM config_maquinaria WHERE id_maquinaria IS NULL AND clave = $1)`,
      [clave, valor]
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
    { usuario: 'eduardomezzavilla', nombre: 'Eduardo Mezzavilla', rol: 'dueno' },
  ]
  for (const u of seedUsuarios) {
    await pool.query(
      `INSERT INTO users (usuario, password_hash, nombre, rol) VALUES ($1,$2,$3,$4) ON CONFLICT (usuario) DO NOTHING`,
      [u.usuario, bcrypt.hashSync('suelosur123', 10), u.nombre, u.rol]
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
        `INSERT INTO productos (nombre, unidad_medida, precio_referencia) VALUES ($1,$2,$3)`,
        [nombre, um, precio]
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
      `INSERT INTO stock (id_producto, cantidad_actual, cant_pendiente_entregar, stock_minimo) VALUES ($1,0,0,0)`,
      [p.id]
    )
  }

  // Nota: el catálogo operativo (clientes, proveedores, flota, contenedores,
  // maquinaria) se carga desde la app. No se siembran datos de ejemplo para
  // que el arranque sea limpio.

  // ─────────────────────────────────────────────────────────────────
  // Backfill: todo usuario con rol chofer debe tener un empleado vinculado.
  // Necesario para que el chofer pueda ver remitos/tareas de sus ops asignadas.
  // ─────────────────────────────────────────────────────────────────
  const choferesSinEmpleado = (await pool.query(`
    SELECT u.id, u.usuario, u.nombre
    FROM users u
    WHERE u.rol = 'chofer' AND u.activo = 1
      AND NOT EXISTS (SELECT 1 FROM empleados e WHERE e.id_usuario = u.id)
  `)).rows
  for (const u of choferesSinEmpleado) {
    const partes = String(u.nombre || u.usuario).trim().split(/\s+/)
    const nombre = partes[0] || u.usuario
    const apellido = partes.slice(1).join(' ') || ''
    const proxLegajo = (await pool.query(`SELECT COALESCE(MAX(legajo), 0) + 1 AS n FROM empleados`)).rows[0].n
    await pool.query(`
      INSERT INTO empleados (legajo, nombre, apellido, es_chofer, cargo, sector, id_usuario, estado_laboral, activo)
      VALUES ($1, $2, $3, 1, 'Chofer', 'Operaciones', $4, 'activo', 1)
    `, [proxLegajo, nombre, apellido, u.id])
    console.log(`  ↳ Empleado-chofer creado para usuario "${u.usuario}"`)
  }

  // ─────────────────────────────────────────────────────────────────
  // VISTAS LEGIBLES — para consultar en Supabase con nombres en vez de UUIDs.
  // No tocan los datos: son "tablas traducidas" de solo lectura.
  // ─────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE OR REPLACE VIEW v_stock AS
    SELECT p.nombre AS producto, p.unidad_medida AS unidad,
           s.cantidad_actual, s.cant_pendiente_entregar, s.stock_minimo,
           p.precio_referencia, s.id
    FROM stock s JOIN productos p ON p.id = s.id_producto
  `)
  await pool.query(`
    CREATE OR REPLACE VIEW v_operaciones AS
    SELECT op.nro_op, op.fecha_emision, op.tipo_op, op.estado, op.modalidad, op.metodo_pago,
           COALESCE(c.nombre, 'Particular') AS cliente, c.numero AS nro_cliente,
           NULLIF(TRIM(COALESCE(e.nombre, '') || ' ' || COALESCE(e.apellido, '')), '') AS chofer,
           fv.nombre AS camion, u.nombre AS administrativo, op.id
    FROM op_encabezado op
    LEFT JOIN clientes c        ON c.id  = op.id_cliente
    LEFT JOIN empleados e       ON e.id  = op.id_chofer
    LEFT JOIN flota_vehiculos fv ON fv.id = op.id_camion
    LEFT JOIN users u           ON u.id  = op.id_administrativo
  `)
  await pool.query(`
    CREATE OR REPLACE VIEW v_detalle_material AS
    SELECT op.nro_op, p.nombre AS producto, d.cantidad_pedida, p.unidad_medida AS unidad,
           d.precio_unitario, (d.cantidad_pedida * d.precio_unitario) AS subtotal, d.id
    FROM op_detalle_material d
    JOIN op_encabezado op ON op.id = d.id_orden_pedido
    JOIN productos p      ON p.id  = d.id_producto
  `)
  await pool.query(`
    CREATE OR REPLACE VIEW v_movimientos_contenedor AS
    SELECT m.fecha_movimiento, cont.numero_contenedor, m.estado_paso,
           u.nombre AS chofer, fv.nombre AS camion, m.observaciones, m.id
    FROM movimiento_contenedor m
    JOIN contenedores cont       ON cont.id = m.id_contenedor
    LEFT JOIN users u            ON u.id    = m.id_chofer
    LEFT JOIN flota_vehiculos fv ON fv.id   = m.id_camion
  `)
  await pool.query(`
    CREATE OR REPLACE VIEW v_movimientos_cuenta AS
    SELECT m.created_at AS fecha, cl.numero AS nro_cliente, cl.nombre AS cliente,
           m.tipo, m.descripcion, m.monto, m.id
    FROM movimientos_cuenta m JOIN clientes cl ON cl.id = m.cliente_id
  `)
  await pool.query(`
    CREATE OR REPLACE VIEW v_transacciones AS
    SELECT t.numero, t.tipo, t.fecha, COALESCE(cl.nombre, t.cliente) AS cliente,
           t.monto, t.metodo_pago, t.nro_remito, t.descripcion, t.id
    FROM transacciones t LEFT JOIN clientes cl ON cl.id = t.cliente_id
  `)

  // ─────────────────────────────────────────────────────────────────
  // MIGRACIÓN: nuevo workflow de estados de contenedor (2025-07)
  // Ampliar el CHECK constraint para incluir los estados nuevos Y los viejos
  // (así la migración no rompe si alguno queda en el medio).
  // ─────────────────────────────────────────────────────────────────
  await pool.query(`ALTER TABLE movimiento_contenedor DROP CONSTRAINT IF EXISTS movimiento_contenedor_estado_paso_check`).catch(() => {})
  await pool.query(`ALTER TABLE movimiento_contenedor ADD CONSTRAINT movimiento_contenedor_estado_paso_check CHECK (estado_paso IN ('disponible','pendiente_despacho','despachado','en_alquiler','pendiente_retiro','vuelta_a_planta','en_planta','en_transito','entregado','a_retirar','vaciado'))`).catch(() => {})

  // Renombrar estados viejos a nuevos
  await pool.query(`UPDATE movimiento_contenedor SET estado_paso = 'disponible' WHERE estado_paso IN ('en_planta','vaciado')`).catch(() => {})
  await pool.query(`UPDATE movimiento_contenedor SET estado_paso = 'pendiente_retiro' WHERE estado_paso = 'a_retirar'`).catch(() => {})
  await pool.query(`UPDATE movimiento_contenedor SET estado_paso = 'en_alquiler' WHERE estado_paso = 'entregado'`).catch(() => {})
  // en_transito al retirar contenedor → vuelta_a_planta
  await pool.query(`
    UPDATE movimiento_contenedor mc SET estado_paso = 'vuelta_a_planta'
    FROM op_detalle_contenedor oc JOIN op_encabezado op ON op.id = oc.id_orden_pedido
    WHERE mc.id_op_contenedor = oc.id AND mc.estado_paso = 'en_transito' AND op.estado = 'entregado'
  `).catch(() => {})
  // en_transito al entregar contenedor → despachado
  await pool.query(`
    UPDATE movimiento_contenedor mc SET estado_paso = 'despachado'
    FROM op_detalle_contenedor oc JOIN op_encabezado op ON op.id = oc.id_orden_pedido
    WHERE mc.id_op_contenedor = oc.id AND mc.estado_paso = 'en_transito' AND op.estado IN ('pendiente','despachado')
  `).catch(() => {})
  // cualquier en_transito restante → disponible (borde)
  await pool.query(`UPDATE movimiento_contenedor SET estado_paso = 'disponible' WHERE estado_paso = 'en_transito'`).catch(() => {})

  // Insertar pendiente_despacho para contenedores asignados a órdenes pendientes que quedaron en disponible
  await pool.query(`
    WITH ultimo AS (
      SELECT DISTINCT ON (id_contenedor) id_contenedor, estado_paso, id AS id_mov
      FROM movimiento_contenedor ORDER BY id_contenedor, fecha_movimiento DESC, id DESC
    )
    INSERT INTO movimiento_contenedor (id_contenedor, id_op_contenedor, estado_paso, observaciones)
    SELECT oc.id_contenedor, oc.id, 'pendiente_despacho', 'Migración: reservado para despacho'
    FROM op_detalle_contenedor oc
    JOIN op_encabezado op ON op.id = oc.id_orden_pedido
    JOIN ultimo u ON u.id_contenedor = oc.id_contenedor
    WHERE op.estado = 'pendiente' AND oc.id_contenedor IS NOT NULL
      AND u.estado_paso = 'disponible' AND op.tipo_op = 'C'
      AND NOT EXISTS (
        SELECT 1 FROM movimiento_contenedor mc2
        WHERE mc2.id_contenedor = oc.id_contenedor AND mc2.id_op_contenedor = oc.id AND mc2.estado_paso = 'pendiente_despacho'
      )
  `).catch(() => {})

  // Ahora estrechar el CHECK a solo los nuevos estados
  await pool.query(`ALTER TABLE movimiento_contenedor DROP CONSTRAINT IF EXISTS movimiento_contenedor_estado_paso_check`).catch(() => {})
  await pool.query(`ALTER TABLE movimiento_contenedor ADD CONSTRAINT movimiento_contenedor_estado_paso_check CHECK (estado_paso IN ('disponible','pendiente_despacho','despachado','en_alquiler','pendiente_retiro','vuelta_a_planta'))`).catch(() => {})

  // MIGRACIÓN: remito de retiro (los alquileres de contenedor tienen 2 remitos:
  // el de entrega y el de retiro, cada uno con su firma y su foto).
  await pool.query(`ALTER TABLE op_encabezado ADD COLUMN IF NOT EXISTS firma_retiro TEXT`).catch(() => {})
  await pool.query(`ALTER TABLE op_encabezado ADD COLUMN IF NOT EXISTS firma_retiro_aclaracion TEXT`).catch(() => {})
  await pool.query(`ALTER TABLE op_encabezado ADD COLUMN IF NOT EXISTS archivo_remito_retiro TEXT`).catch(() => {})

  // ─────────────────────────────────────────────────────────────────
  // MIGRACIÓN: se elimina el estado 'vuelta_a_planta'. El contenedor queda en
  // 'pendiente_retiro' hasta que el retiro se completa, y ahí pasa directo a
  // 'disponible'. Que el chofer ya haya salido se marca en la operación.
  // ─────────────────────────────────────────────────────────────────
  await pool.query(`ALTER TABLE op_encabezado ADD COLUMN IF NOT EXISTS retiro_iniciado_en TEXT`).catch(() => {})
  // Los retiros que estaban en curso conservan esa marca antes de perder el estado
  await pool.query(`
    UPDATE op_encabezado op
    SET retiro_iniciado_en = to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')
    FROM op_detalle_contenedor oc
    JOIN (
      SELECT DISTINCT ON (id_contenedor) id_contenedor, estado_paso
      FROM movimiento_contenedor ORDER BY id_contenedor, fecha_movimiento DESC, id DESC
    ) u ON u.id_contenedor = oc.id_contenedor
    WHERE oc.id_orden_pedido = op.id AND u.estado_paso = 'vuelta_a_planta'
      AND op.retiro_iniciado_en IS NULL
  `).catch(() => {})
  await pool.query(`UPDATE movimiento_contenedor SET estado_paso = 'pendiente_retiro' WHERE estado_paso = 'vuelta_a_planta'`).catch(() => {})

  // ─────────────────────────────────────────────────────────────────
  // MIGRACIÓN: plazo_alquiler nulo = alquiler sin fecha de fin definida (sigue en
  // curso por tiempo indeterminado). Con NULL las cuentas de vencimiento dan NULL,
  // así que esos alquileres no se auto-vencen ni aparecen como "por finalizar".
  // ─────────────────────────────────────────────────────────────────
  await pool.query(`ALTER TABLE op_detalle_contenedor ALTER COLUMN plazo_alquiler DROP NOT NULL`).catch(() => {})
  // Las cargas históricas sin fecha de fin se guardaban con plazo 0: pasan a NULL.
  await pool.query(`
    UPDATE op_detalle_contenedor oc SET plazo_alquiler = NULL
    FROM op_encabezado op
    WHERE op.id = oc.id_orden_pedido AND op.tipo_op = 'C'
      AND oc.plazo_alquiler = 0 AND oc.id_contenedor IS NULL
  `).catch(() => {})
  await pool.query(`ALTER TABLE movimiento_contenedor DROP CONSTRAINT IF EXISTS movimiento_contenedor_estado_paso_check`).catch(() => {})
  await pool.query(`ALTER TABLE movimiento_contenedor ADD CONSTRAINT movimiento_contenedor_estado_paso_check CHECK (estado_paso IN ('disponible','pendiente_despacho','despachado','en_alquiler','pendiente_retiro'))`).catch(() => {})

  // Costo de flete de una compra de material, aparte del costo unitario del producto
  await pool.query(`ALTER TABLE stock_ingresos ADD COLUMN IF NOT EXISTS costo_flete REAL DEFAULT 0`).catch(() => {})

  // Fletero (persona/empresa que hizo el transporte) de una compra de material
  await pool.query(`ALTER TABLE egresos ADD COLUMN IF NOT EXISTS fletero TEXT`).catch(() => {})

  // Producto comprado (categoría material), para poder filtrar el libro de compras / pagos por producto
  await pool.query(`ALTER TABLE egresos ADD COLUMN IF NOT EXISTS id_producto BIGINT REFERENCES productos(id)`).catch(() => {})
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_egresos_producto ON egresos(id_producto)`).catch(() => {})

  // ─────────────────────────────────────────────────────────────────
  // MIGRACIÓN: precio único → precio distinto por canal de venta (cantera / viaje).
  // Las columnas se agregan sin default para poder distinguir "recién creada, todavía
  // sin migrar" (NULL) de "el usuario la dejó en 0 a propósito" — el backfill solo
  // toca las que siguen en NULL, así no pisa ediciones posteriores en reinicios futuros.
  // ─────────────────────────────────────────────────────────────────
  await pool.query(`ALTER TABLE productos ADD COLUMN IF NOT EXISTS precio_cantera REAL`).catch(() => {})
  await pool.query(`ALTER TABLE productos ADD COLUMN IF NOT EXISTS precio_viaje REAL`).catch(() => {})
  await pool.query(`UPDATE productos SET precio_cantera = COALESCE(precio_referencia, 0) WHERE precio_cantera IS NULL`).catch(() => {})
  await pool.query(`UPDATE productos SET precio_viaje   = COALESCE(precio_referencia, 0) WHERE precio_viaje   IS NULL`).catch(() => {})
  await pool.query(`ALTER TABLE productos ALTER COLUMN precio_cantera SET DEFAULT 0`).catch(() => {})
  await pool.query(`ALTER TABLE productos ALTER COLUMN precio_viaje   SET DEFAULT 0`).catch(() => {})

  console.log('✅ Base de datos PostgreSQL inicializada')
}

// Borra el rastreo GPS de los choferes con más de N días (default 7).
// Conserva la última semana y evita que la tabla crezca indefinidamente.
// LEFT(fecha_registro, 10) toma 'YYYY-MM-DD' (funciona con ambos formatos guardados).
async function limpiarRastreoViejo(dias = 7) {
  try {
    const r = await pool.query(
      `DELETE FROM rastreo_chofer WHERE LEFT(fecha_registro, 10)::date < CURRENT_DATE - $1::int`,
      [dias]
    )
    if (r.rowCount > 0) console.log(`🧹 Rastreo GPS: ${r.rowCount} registro(s) de más de ${dias} días eliminados`)
    return r.rowCount
  } catch (e) {
    console.error('Error al limpiar el rastreo GPS:', e.message)
    return 0
  }
}

module.exports = { pool, query, transaction, initDB, limpiarRastreoViejo }
