// ═══════════════════════════════════════════════════════════════════
// db.js — Base de datos unificada · Suelosur S.A.S.
// better-sqlite3 (síncrono) · SQLite local
//
// ORIGEN DE CADA TABLA
//   [S]  SeminarioFinal      → se mantiene íntegra o con pequeños ajustes
//   [G]  GestionSuelo        → se mantiene íntegra
//   [F]  Fusión S+G          → combina campos de ambos proyectos
//   [N]  Nueva               → diseñada desde cero para esta plataforma
//
// CONVENCIONES
//   - IDs: TEXT UUID (crypto.randomUUID())
//   - Fechas: TEXT ISO  → datetime('now') / date('now')
//   - Booleanos: INTEGER 0/1
//   - Montos: REAL
//   - FKs declaradas explícitamente (PRAGMA foreign_keys = ON)
// ═══════════════════════════════════════════════════════════════════

'use strict'

const path   = require('path')
const crypto = require('crypto')
const fs     = require('fs')
const Database = require('better-sqlite3')
const bcrypt   = require('bcryptjs')

// ── Ruta de la base de datos ─────────────────────────────────────
const dbPath = path.join(__dirname, '..', '..', 'data', 'suelosur.db')
fs.mkdirSync(path.dirname(dbPath), { recursive: true })

const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')


// ═══════════════════════════════════════════════════════════════════
// BLOQUE 1 — TABLAS CENTRALES
// ═══════════════════════════════════════════════════════════════════

db.exec(`

  -- ─────────────────────────────────────────────────────────────
  -- [G] Usuarios con roles y autenticación local
  -- ─────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    usuario       TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    nombre        TEXT NOT NULL,
    rol           TEXT NOT NULL CHECK (rol IN ('admin_ventas','admin_contable','chofer','dueno')),
    activo        INTEGER DEFAULT 1,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  -- ─────────────────────────────────────────────────────────────
  -- [F] Clientes
  --     GestionSuelo : nombre, domicilio_ppal, zona, tel_whatsapp, tipo_cliente
  --     Seminario    : apellido, dni, telefono, email, direccion, cuenta_corriente, saldo
  --     Fusión       : todos los campos útiles de ambos
  -- ─────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS clientes (
    id              TEXT PRIMARY KEY,
    nombre          TEXT NOT NULL,
    apellido        TEXT NOT NULL DEFAULT '',
    dni             TEXT,
    domicilio_ppal  TEXT,
    zona            TEXT,
    tel_whatsapp    TEXT,
    telefono        TEXT,
    email           TEXT,
    tipo_cliente    TEXT,
    cuenta_corriente INTEGER DEFAULT 0,
    saldo           REAL DEFAULT 0,
    activo          INTEGER DEFAULT 1,
    created_at      TEXT DEFAULT (datetime('now'))
  );

  -- ─────────────────────────────────────────────────────────────
  -- [S] Movimientos de cuenta corriente de clientes
  -- ─────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS movimientos_cuenta (
    id          TEXT PRIMARY KEY,
    cliente_id  TEXT NOT NULL REFERENCES clientes(id),
    tipo        TEXT NOT NULL CHECK (tipo IN ('deuda','pago','ajuste')),
    descripcion TEXT NOT NULL DEFAULT '',
    monto       REAL NOT NULL,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  -- ─────────────────────────────────────────────────────────────
  -- [G] Productos (áridos: arena, piedra, tosca, etc.)
  -- ─────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS productos (
    id                TEXT PRIMARY KEY,
    nombre            TEXT NOT NULL,
    unidad_medida     TEXT NOT NULL DEFAULT 'm³',
    precio_referencia REAL DEFAULT 0,
    activo            INTEGER DEFAULT 1,
    created_at        TEXT DEFAULT (datetime('now'))
  );

  -- ─────────────────────────────────────────────────────────────
  -- [F] Stock de áridos
  --     GestionSuelo : cantidad_actual, cant_pendiente_entregar, stock_minimo
  --     Seminario    : precio en tabla stock (acá queda en productos)
  -- ─────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS stock (
    id                      TEXT PRIMARY KEY,
    id_producto             TEXT NOT NULL UNIQUE REFERENCES productos(id),
    cantidad_actual         REAL DEFAULT 0,
    cant_pendiente_entregar REAL DEFAULT 0,
    stock_minimo            REAL DEFAULT 0
  );

  -- ─────────────────────────────────────────────────────────────
  -- [G] Flota de vehículos
  -- ─────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS flota_vehiculos (
    id            TEXT PRIMARY KEY,
    tipo_vehiculo TEXT NOT NULL CHECK (tipo_vehiculo IN ('camion','bobcat','utilitario','otro')),
    patente       TEXT NOT NULL,
    nombre        TEXT NOT NULL,
    kilometraje   INTEGER DEFAULT 0,
    activo        INTEGER DEFAULT 1,
    created_at    TEXT DEFAULT (datetime('now'))
  );

`)


// ═══════════════════════════════════════════════════════════════════
// BLOQUE 2 — OPERACIONES (corazón del sistema)
// ═══════════════════════════════════════════════════════════════════

db.exec(`

  -- ─────────────────────────────────────────────────────────────
  -- [F] Órdenes de Pedido — encabezado unificado
  --     tipo_op:
  --       'M'  → Venta de material (áridos)
  --       'C'  → Alquiler de contenedor
  --       'MA' → Alquiler de maquinaria  ← NUEVO
  --
  --     nro_remito: identificador administrativo/logístico universal
  --       Toda OP que genere movimiento económico tiene nro_remito.
  --
  --     domicilio_*: campos de entrega para ventas con flete y alquileres
  -- ─────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS op_encabezado (
    id                        TEXT PRIMARY KEY,
    id_cliente                TEXT NOT NULL REFERENCES clientes(id),
    id_administrativo         TEXT NOT NULL REFERENCES users(id),
    fecha_emision             TEXT NOT NULL DEFAULT (date('now')),
    tipo_op                   TEXT NOT NULL DEFAULT 'M'
                                CHECK (tipo_op IN ('M','C','MA')),
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
    created_at                TEXT DEFAULT (datetime('now'))
  );

  -- ─────────────────────────────────────────────────────────────
  -- [G] Detalle de material (áridos) por OP
  -- ─────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS op_detalle_material (
    id              TEXT PRIMARY KEY,
    id_orden_pedido TEXT NOT NULL REFERENCES op_encabezado(id),
    id_producto     TEXT NOT NULL REFERENCES productos(id),
    cantidad_pedida REAL NOT NULL,
    precio_unitario REAL NOT NULL
  );

  -- ─────────────────────────────────────────────────────────────
  -- [G] Detalle de contenedor por OP
  -- ─────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS op_detalle_contenedor (
    id                TEXT PRIMARY KEY,
    id_orden_pedido   TEXT NOT NULL REFERENCES op_encabezado(id),
    id_contenedor     TEXT REFERENCES contenedores(id),
    domicilio_entrega TEXT NOT NULL DEFAULT '',
    zona_entrega      TEXT NOT NULL DEFAULT '',
    plazo_alquiler    INTEGER NOT NULL DEFAULT 5,
    precio_alquiler   REAL DEFAULT 0
  );

  -- ─────────────────────────────────────────────────────────────
  -- [N] Detalle de maquinaria por OP
  --     Espejo estructural de op_detalle_contenedor.
  --     plazo_alquiler: días de uso pactados
  --     precio_por_hora / precio_total: la maquinaria puede
  --     cotizarse por hora O por trabajo cerrado
  -- ─────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS op_detalle_maquinaria (
    id                TEXT PRIMARY KEY,
    id_orden_pedido   TEXT NOT NULL REFERENCES op_encabezado(id),
    id_maquinaria     TEXT REFERENCES maquinaria(id),
    domicilio_entrega TEXT NOT NULL DEFAULT '',
    zona_entrega      TEXT NOT NULL DEFAULT '',
    plazo_alquiler    INTEGER NOT NULL DEFAULT 1,
    precio_por_hora   REAL DEFAULT 0,
    horas_pactadas    REAL DEFAULT 0,
    precio_total      REAL DEFAULT 0
  );

`)


// ═══════════════════════════════════════════════════════════════════
// BLOQUE 3 — CONTENEDORES
// ═══════════════════════════════════════════════════════════════════

db.exec(`

  -- ─────────────────────────────────────────────────────────────
  -- [G] Catálogo de contenedores
  -- ─────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS contenedores (
    id                   TEXT PRIMARY KEY,
    numero_contenedor    INTEGER NOT NULL UNIQUE,
    estado_general       TEXT NOT NULL DEFAULT 'operativo'
                           CHECK (estado_general IN ('operativo','en_reparacion','baja')),
    fecha_ultima_pintada TEXT,
    observaciones        TEXT DEFAULT '',
    activo               INTEGER DEFAULT 1,
    created_at           TEXT DEFAULT (datetime('now'))
  );

  -- ─────────────────────────────────────────────────────────────
  -- [G] Historial de movimientos de contenedores (log inmutable)
  --     NUNCA hacer UPDATE — siempre INSERT una nueva fila.
  --     Estado actual = estado_paso del último registro.
  --
  --     estados:
  --       en_planta   → disponible en depósito
  --       en_transito → en camino a entregar o a retirar
  --       entregado   → en domicilio del cliente (inicio alquiler)
  --       en_alquiler → confirmación de días en uso
  --       a_retirar   → plazo vencido, pendiente retiro
  --       vaciado     → devuelto y vaciado, listo para reasignar
  -- ─────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS movimiento_contenedor (
    id               TEXT PRIMARY KEY,
    id_contenedor    TEXT NOT NULL REFERENCES contenedores(id),
    id_op_contenedor TEXT REFERENCES op_detalle_contenedor(id),
    id_chofer        TEXT REFERENCES users(id),
    id_camion        TEXT REFERENCES flota_vehiculos(id),
    fecha_movimiento TEXT NOT NULL DEFAULT (datetime('now')),
    estado_paso      TEXT NOT NULL
                       CHECK (estado_paso IN (
                         'en_planta','en_transito','entregado',
                         'en_alquiler','a_retirar','vaciado'
                       )),
    observaciones    TEXT DEFAULT ''
  );

`)


// ═══════════════════════════════════════════════════════════════════
// BLOQUE 4 — MAQUINARIA (espejo de contenedores)
// ═══════════════════════════════════════════════════════════════════

db.exec(`

  -- ─────────────────────────────────────────────────────────────
  -- [N] Catálogo de maquinaria
  --     Incluye la Bobcat y cualquier equipo que se sume.
  --     tipo: permite diferenciar equipos en el futuro
  -- ─────────────────────────────────────────────────────────────
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
    created_at      TEXT DEFAULT (datetime('now'))
  );

  -- ─────────────────────────────────────────────────────────────
  -- [N] Historial de movimientos de maquinaria (log inmutable)
  --     Misma filosofía que movimiento_contenedor.
  --
  --     estados:
  --       en_planta   → disponible en depósito
  --       despachada  → salió hacia el trabajo
  --       en_uso      → operando en domicilio del cliente
  --       a_retirar   → trabajo terminado, pendiente retiro
  --       en_servicio → en taller / mantenimiento
  -- ─────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS movimiento_maquinaria (
    id                 TEXT PRIMARY KEY,
    id_maquinaria      TEXT NOT NULL REFERENCES maquinaria(id),
    id_op_maquinaria   TEXT REFERENCES op_detalle_maquinaria(id),
    id_operario        TEXT REFERENCES users(id),
    id_camion          TEXT REFERENCES flota_vehiculos(id),
    fecha_movimiento   TEXT NOT NULL DEFAULT (datetime('now')),
    estado_paso        TEXT NOT NULL
                         CHECK (estado_paso IN (
                           'en_planta','despachada','en_uso',
                           'a_retirar','en_servicio'
                         )),
    horas_trabajadas   REAL DEFAULT 0,
    km_registrados     INTEGER DEFAULT 0,
    observaciones      TEXT DEFAULT ''
  );

  -- ─────────────────────────────────────────────────────────────
  -- [N] Registro de mantenimiento de maquinaria
  --     Separado del historial operativo para no mezclar
  --     lógica de alquiler con lógica de servicio.
  -- ─────────────────────────────────────────────────────────────
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
    created_at    TEXT DEFAULT (datetime('now'))
  );

`)


// ═══════════════════════════════════════════════════════════════════
// BLOQUE 5 — TRANSACCIONES (trazabilidad económica)
// ═══════════════════════════════════════════════════════════════════

db.exec(`

  -- ─────────────────────────────────────────────────────────────
  -- [F] Transacciones económicas del sistema
  --     Seminario : tipo, cliente, monto, descripcion, metodo_pago
  --     Fusión    : + id_op_encabezado + nro_remito para trazabilidad
  --
  --     tipo:
  --       'Venta Cantera'  → venta directa en planta (sin flete)
  --       'Venta Viaje'    → venta con entrega planificada
  --       'Alquiler'       → alquiler de contenedor
  --       'Maquinaria'     → alquiler de maquinaria
  --       'Ajuste'         → corrección manual
  -- ─────────────────────────────────────────────────────────────
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
    fecha            TEXT DEFAULT (datetime('now')),
    created_at       TEXT DEFAULT (datetime('now'))
  );

`)


// ═══════════════════════════════════════════════════════════════════
// BLOQUE 6 — CIRCUITOS LOGÍSTICOS (placeholder Sprint 3)
// ═══════════════════════════════════════════════════════════════════
// Las tablas se crean ahora para evitar refactorizaciones.
// La lógica de negocio se implementa en Sprint 3.

db.exec(`

  -- ─────────────────────────────────────────────────────────────
  -- [N] Circuito del día: grupo de paradas lógicas para un camión
  --     Un circuito agrupa múltiples paradas (entregas + retiros)
  --     asignadas a un chofer y un vehículo para una fecha dada.
  -- ─────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS circuitos (
    id         TEXT PRIMARY KEY,
    fecha      TEXT NOT NULL DEFAULT (date('now')),
    id_chofer  TEXT REFERENCES users(id),
    id_camion  TEXT REFERENCES flota_vehiculos(id),
    estado     TEXT NOT NULL DEFAULT 'borrador'
                 CHECK (estado IN ('borrador','confirmado','en_curso','finalizado')),
    observaciones TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- ─────────────────────────────────────────────────────────────
  -- [N] Paradas dentro de un circuito
  --     Una parada puede ser: entrega de material, entrega/retiro
  --     de contenedor, entrega/retiro de maquinaria.
  --     id_op_encabezado referencia la OP correspondiente.
  -- ─────────────────────────────────────────────────────────────
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
    created_at       TEXT DEFAULT (datetime('now'))
  );

`)


// ═══════════════════════════════════════════════════════════════════
// BLOQUE 7 — COMPRAS Y PROVEEDORES (Sprint 5)
// ═══════════════════════════════════════════════════════════════════

db.exec(`

  -- ─────────────────────────────────────────────────────────────
  -- [G] Proveedores
  -- ─────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS proveedores (
    id         TEXT PRIMARY KEY,
    nombre     TEXT NOT NULL,
    cuit       TEXT,
    domicilio  TEXT,
    telefono   TEXT,
    email      TEXT,
    activo     INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- ─────────────────────────────────────────────────────────────
  -- [G] Órdenes de compra — encabezado
  -- ─────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS compras_encabezado (
    id            TEXT PRIMARY KEY,
    id_proveedor  TEXT NOT NULL REFERENCES proveedores(id),
    fecha         TEXT NOT NULL DEFAULT (date('now')),
    estado        TEXT NOT NULL DEFAULT 'emitida'
                    CHECK (estado IN ('emitida','recibida','cancelada')),
    observaciones TEXT DEFAULT '',
    created_at    TEXT DEFAULT (datetime('now'))
  );

  -- ─────────────────────────────────────────────────────────────
  -- [G] Detalle de compra
  -- ─────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS compras_detalle (
    id           TEXT PRIMARY KEY,
    id_compra    TEXT NOT NULL REFERENCES compras_encabezado(id),
    id_producto  TEXT NOT NULL REFERENCES productos(id),
    cantidad     REAL NOT NULL,
    precio_unitario REAL NOT NULL
  );

  -- ─────────────────────────────────────────────────────────────
  -- [G] Cuenta corriente de proveedores
  -- ─────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS cc_proveedores (
    id                TEXT PRIMARY KEY,
    id_proveedor      TEXT NOT NULL REFERENCES proveedores(id),
    tipo_movimiento   TEXT NOT NULL CHECK (tipo_movimiento IN ('debito','credito')),
    nro_comprobante   TEXT,
    monto_debito      REAL DEFAULT 0,
    monto_credito     REAL DEFAULT 0,
    saldo_resultante  REAL DEFAULT 0,
    descripcion       TEXT DEFAULT '',
    fecha             TEXT DEFAULT (date('now')),
    created_at        TEXT DEFAULT (datetime('now'))
  );

`)


// ═══════════════════════════════════════════════════════════════════
// BLOQUE 8 — FLOTA Y MANTENIMIENTO (Sprint 6)
// ═══════════════════════════════════════════════════════════════════

db.exec(`

  -- ─────────────────────────────────────────────────────────────
  -- [G] Registro de mantenimiento de vehículos de flota
  -- ─────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS mantenimiento_vehiculo (
    id           TEXT PRIMARY KEY,
    id_vehiculo  TEXT NOT NULL REFERENCES flota_vehiculos(id),
    tipo_service TEXT NOT NULL DEFAULT 'preventivo'
                   CHECK (tipo_service IN ('preventivo','correctivo','revision')),
    fecha        TEXT NOT NULL,
    costo        REAL DEFAULT 0,
    km           INTEGER DEFAULT 0,
    proxima_fecha TEXT,
    taller       TEXT DEFAULT '',
    observaciones TEXT DEFAULT '',
    created_at   TEXT DEFAULT (datetime('now'))
  );

  -- ─────────────────────────────────────────────────────────────
  -- [G] Registro de carga de combustible
  -- ─────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS combustible (
    id          TEXT PRIMARY KEY,
    id_vehiculo TEXT NOT NULL REFERENCES flota_vehiculos(id),
    id_chofer   TEXT REFERENCES users(id),
    litros      REAL NOT NULL,
    costo_total REAL NOT NULL,
    km_al_cargar INTEGER DEFAULT 0,
    fecha       TEXT NOT NULL DEFAULT (date('now')),
    created_at  TEXT DEFAULT (datetime('now'))
  );

`)


// ═══════════════════════════════════════════════════════════════════
// BLOQUE 9 — FLOTA DE PERSONAL (RRHH)
// Empleados de la empresa, usen o no el sistema. Independiente de
// `users`, con vínculo opcional 1:1 a un usuario del sistema.
// ═══════════════════════════════════════════════════════════════════

db.exec(`

  CREATE TABLE IF NOT EXISTS empleados (
    id                   TEXT PRIMARY KEY,
    legajo               INTEGER UNIQUE,

    -- Información personal
    nombre               TEXT NOT NULL,
    apellido             TEXT NOT NULL DEFAULT '',
    dni                  TEXT,
    fecha_nacimiento     TEXT,
    direccion            TEXT,
    telefono             TEXT,
    email                TEXT,

    -- Información laboral
    cargo                TEXT,
    sector               TEXT,
    fecha_ingreso        TEXT,
    estado_laboral       TEXT NOT NULL DEFAULT 'activo'
                           CHECK (estado_laboral IN ('activo','licencia','suspendido','baja')),
    tipo_contratacion    TEXT,

    -- Información económica
    salario              REAL DEFAULT 0,
    bonificaciones       REAL DEFAULT 0,
    descuentos           REAL DEFAULT 0,
    viaticos             REAL DEFAULT 0,
    horas_extras         REAL DEFAULT 0,

    -- Información operativa
    vehiculo_asignado    TEXT,
    licencia_categoria   TEXT,
    licencia_vencimiento TEXT,
    certificaciones      TEXT,

    -- Vínculo opcional con un usuario del sistema
    id_usuario           TEXT REFERENCES users(id),

    activo               INTEGER DEFAULT 1,
    created_at           TEXT DEFAULT (datetime('now'))
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_empleados_legajo ON empleados(legajo);

`)


// ═══════════════════════════════════════════════════════════════════
// BLOQUE 10 — CHOFERES Y FLOTA (gestión integral)
// ═══════════════════════════════════════════════════════════════════

db.exec(`

  -- [N] Gestión documental polimórfica (choferes y camiones)
  CREATE TABLE IF NOT EXISTS documentos (
    id               TEXT PRIMARY KEY,
    entidad_tipo     TEXT NOT NULL CHECK (entidad_tipo IN ('empleado','vehiculo')),
    entidad_id       TEXT NOT NULL,
    tipo             TEXT NOT NULL,
    descripcion      TEXT DEFAULT '',
    archivo          TEXT,
    fecha_emision    TEXT,
    fecha_vencimiento TEXT,
    created_at       TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_documentos_entidad ON documentos(entidad_tipo, entidad_id);

  -- [N] Asignación chofer ↔ camión (historial)
  CREATE TABLE IF NOT EXISTS asignaciones_chofer (
    id            TEXT PRIMARY KEY,
    id_empleado   TEXT NOT NULL REFERENCES empleados(id),
    id_vehiculo   TEXT NOT NULL REFERENCES flota_vehiculos(id),
    tipo          TEXT NOT NULL DEFAULT 'principal' CHECK (tipo IN ('principal','alternativo')),
    fecha_desde   TEXT NOT NULL DEFAULT (date('now')),
    fecha_hasta   TEXT,
    activo        INTEGER DEFAULT 1,
    observaciones TEXT DEFAULT '',
    created_at    TEXT DEFAULT (datetime('now'))
  );

  -- [N] Control horario / jornadas
  CREATE TABLE IF NOT EXISTS control_horario (
    id             TEXT PRIMARY KEY,
    id_empleado    TEXT NOT NULL REFERENCES empleados(id),
    fecha          TEXT NOT NULL DEFAULT (date('now')),
    hora_ingreso   TEXT,
    hora_egreso    TEXT,
    horas_normales REAL DEFAULT 0,
    horas_extra    REAL DEFAULT 0,
    motivo_extra   TEXT DEFAULT '',
    aprobado       INTEGER DEFAULT 0,
    aprobado_por   TEXT,
    observaciones  TEXT DEFAULT '',
    created_at     TEXT DEFAULT (datetime('now'))
  );

  -- [N] Pagos a empleados (sueldos, anticipos, viáticos, HE, etc.)
  CREATE TABLE IF NOT EXISTS pagos_empleado (
    id           TEXT PRIMARY KEY,
    id_empleado  TEXT NOT NULL REFERENCES empleados(id),
    tipo         TEXT NOT NULL CHECK (tipo IN ('sueldo','anticipo','viatico','horas_extra','bonificacion','descuento','liquidacion')),
    periodo      TEXT,
    monto        REAL NOT NULL DEFAULT 0,
    fecha        TEXT NOT NULL DEFAULT (date('now')),
    descripcion  TEXT DEFAULT '',
    created_at   TEXT DEFAULT (datetime('now'))
  );

  -- [N] Historial de estados operativos de vehículos
  CREATE TABLE IF NOT EXISTS estado_vehiculo_hist (
    id            TEXT PRIMARY KEY,
    id_vehiculo   TEXT NOT NULL REFERENCES flota_vehiculos(id),
    estado        TEXT NOT NULL,
    fecha         TEXT NOT NULL DEFAULT (datetime('now')),
    id_usuario    TEXT,
    observaciones TEXT DEFAULT ''
  );

  -- [N] Reglas de mantenimiento por km / fecha (NULL id_vehiculo = global)
  CREATE TABLE IF NOT EXISTS config_mantenimiento (
    id           TEXT PRIMARY KEY,
    id_vehiculo  TEXT REFERENCES flota_vehiculos(id),
    tipo         TEXT NOT NULL,
    cada_km      INTEGER,
    cada_meses   INTEGER,
    descripcion  TEXT DEFAULT '',
    created_at   TEXT DEFAULT (datetime('now'))
  );

  -- [N] Gastos del vehículo (seguros, impuestos, peajes, multas, ...)
  CREATE TABLE IF NOT EXISTS gastos_vehiculo (
    id           TEXT PRIMARY KEY,
    id_vehiculo  TEXT NOT NULL REFERENCES flota_vehiculos(id),
    categoria    TEXT NOT NULL CHECK (categoria IN ('seguro','impuesto','peaje','estacionamiento','multa','otro')),
    descripcion  TEXT DEFAULT '',
    monto        REAL NOT NULL DEFAULT 0,
    fecha        TEXT NOT NULL DEFAULT (date('now')),
    vencimiento  TEXT,
    estado       TEXT DEFAULT 'pagado',
    archivo      TEXT,
    created_at   TEXT DEFAULT (datetime('now'))
  );

  -- [N] Posiciones GPS (vacía — preparada para integración futura)
  CREATE TABLE IF NOT EXISTS gps_posiciones (
    id           TEXT PRIMARY KEY,
    id_vehiculo  TEXT NOT NULL REFERENCES flota_vehiculos(id),
    lat          REAL,
    lng          REAL,
    velocidad    REAL,
    estado       TEXT,
    fecha        TEXT DEFAULT (datetime('now'))
  );

  -- [N] Auditoría de cambios (choferes, flota, etc.)
  CREATE TABLE IF NOT EXISTS auditoria (
    id           TEXT PRIMARY KEY,
    entidad_tipo TEXT NOT NULL,
    entidad_id   TEXT NOT NULL,
    accion       TEXT NOT NULL,
    id_usuario   TEXT,
    detalle      TEXT DEFAULT '',
    created_at   TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_auditoria_entidad ON auditoria(entidad_tipo, entidad_id);

  -- [N] Configuración de notificaciones (email diferido)
  CREATE TABLE IF NOT EXISTS config_notificaciones (
    id          TEXT PRIMARY KEY,
    clave       TEXT NOT NULL UNIQUE,
    valor       TEXT NOT NULL DEFAULT '',
    created_at  TEXT DEFAULT (datetime('now'))
  );

  -- [N] Asignación polimórfica de recursos a choferes (camión / máquina)
  CREATE TABLE IF NOT EXISTS asignaciones_recurso (
    id            TEXT PRIMARY KEY,
    id_empleado   TEXT NOT NULL REFERENCES empleados(id),
    recurso_tipo  TEXT NOT NULL CHECK (recurso_tipo IN ('camion','maquina')),
    recurso_id    TEXT NOT NULL,
    fecha_desde   TEXT NOT NULL DEFAULT (date('now')),
    fecha_hasta   TEXT,
    activo        INTEGER DEFAULT 1,
    observaciones TEXT DEFAULT '',
    created_at    TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_asig_recurso ON asignaciones_recurso(recurso_tipo, recurso_id, activo);
  CREATE INDEX IF NOT EXISTS idx_asig_empleado ON asignaciones_recurso(id_empleado, activo);

  -- [N] Ingresos de stock con trazabilidad de proveedor
  CREATE TABLE IF NOT EXISTS stock_ingresos (
    id             TEXT PRIMARY KEY,
    id_producto    TEXT NOT NULL REFERENCES productos(id),
    id_proveedor   TEXT REFERENCES proveedores(id),
    cantidad       REAL NOT NULL,
    costo_unitario REAL DEFAULT 0,
    id_usuario     TEXT,
    observaciones  TEXT DEFAULT '',
    fecha          TEXT NOT NULL DEFAULT (date('now')),
    created_at     TEXT DEFAULT (datetime('now'))
  );

`)

// Seed de configuración de notificaciones (valores por defecto)
;(() => {
  const defaults = [
    ['email_activo', '0'],
    ['email_destinatarios', ''],
    ['umbral_dias', '90,60,30'],
    ['alertas_licencias', '1'],
    ['alertas_documentos', '1'],
    ['alertas_mantenimiento', '1'],
  ]
  const ins = db.prepare(`INSERT OR IGNORE INTO config_notificaciones (id, clave, valor) VALUES (?, ?, ?)`)
  defaults.forEach(([k, v]) => ins.run(crypto.randomUUID(), k, v))
})()


// ═══════════════════════════════════════════════════════════════════
// MIGRACIONES — columnas añadidas en sprints posteriores
// Se ejecutan con try/catch: si la columna ya existe, SQLite lanza
// error y se ignora silenciosamente.
// ═══════════════════════════════════════════════════════════════════

const migrations = [
  // op_encabezado — columnas que existían en GestionSuelo como ALTER
  `ALTER TABLE op_encabezado ADD COLUMN fecha_entrega_planificada TEXT`,
  `ALTER TABLE op_encabezado ADD COLUMN nro_remito INTEGER`,
  `ALTER TABLE op_encabezado ADD COLUMN modalidad TEXT`,
  `ALTER TABLE op_encabezado ADD COLUMN domicilio_calle TEXT`,
  `ALTER TABLE op_encabezado ADD COLUMN domicilio_altura INTEGER`,
  `ALTER TABLE op_encabezado ADD COLUMN domicilio_sin_numero INTEGER DEFAULT 0`,
  `ALTER TABLE op_encabezado ADD COLUMN domicilio_lat REAL`,
  `ALTER TABLE op_encabezado ADD COLUMN domicilio_lng REAL`,
  `ALTER TABLE op_encabezado ADD COLUMN metodo_pago TEXT`,
  // clientes — campos de Seminario que no estaban en GestionSuelo
  `ALTER TABLE clientes ADD COLUMN apellido TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE clientes ADD COLUMN dni TEXT`,
  `ALTER TABLE clientes ADD COLUMN telefono TEXT`,
  `ALTER TABLE clientes ADD COLUMN email TEXT`,
  `ALTER TABLE clientes ADD COLUMN cuenta_corriente INTEGER DEFAULT 0`,
  `ALTER TABLE clientes ADD COLUMN saldo REAL DEFAULT 0`,
  // clientes — número secuencial visible para humanos (Sprint 2)
  `ALTER TABLE clientes ADD COLUMN numero INTEGER`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_numero ON clientes(numero)`,
  // maquinaria — columnas opcionales para futuras ampliaciones
  `ALTER TABLE maquinaria ADD COLUMN modelo TEXT`,
  `ALTER TABLE maquinaria ADD COLUMN anio INTEGER`,
  `ALTER TABLE maquinaria ADD COLUMN proximo_service TEXT`,

  // ── Sprint 2+ — Precios en catálogo maquinaria ──────────────────
  `ALTER TABLE maquinaria ADD COLUMN precio_por_hora REAL DEFAULT 0`,
  `ALTER TABLE maquinaria ADD COLUMN precio_por_dia REAL DEFAULT 0`,
  `ALTER TABLE maquinaria ADD COLUMN modo_precio TEXT DEFAULT 'hora'`,

  // ── Sprint 2+ — Chofer para alquiler de maquinaria ──────────────
  `ALTER TABLE op_detalle_maquinaria ADD COLUMN id_chofer TEXT REFERENCES users(id)`,
  `ALTER TABLE op_detalle_maquinaria ADD COLUMN domicilio_calle TEXT`,
  `ALTER TABLE op_detalle_maquinaria ADD COLUMN domicilio_numero TEXT`,

  // ── Sprint 2+ — Dirección split en alquiler contenedores ────────
  `ALTER TABLE op_detalle_contenedor ADD COLUMN domicilio_calle TEXT`,
  `ALTER TABLE op_detalle_contenedor ADD COLUMN domicilio_numero TEXT`,
  `ALTER TABLE op_detalle_contenedor ADD COLUMN domicilio_lat REAL`,
  `ALTER TABLE op_detalle_contenedor ADD COLUMN domicilio_lng REAL`,

  // ── Sprint 2+ — Encadenamiento de alquileres ───────────────────
  `ALTER TABLE op_detalle_contenedor ADD COLUMN alquiler_siguiente_id TEXT`,
  `ALTER TABLE op_encabezado ADD COLUMN estado_programacion TEXT DEFAULT NULL`,

  // ── Sprint 2+ — Método de pago en alquileres ───────────────────
  `ALTER TABLE op_detalle_contenedor ADD COLUMN metodo_pago TEXT`,
  `ALTER TABLE op_detalle_maquinaria ADD COLUMN metodo_pago TEXT`,

  // ── Fase 3 — Remito firmado (archivo subido) por operación ──────
  `ALTER TABLE op_encabezado ADD COLUMN archivo_remito TEXT`,

  // ── Normalización de IDs legibles en transacciones (numero por tipo) ─
  `ALTER TABLE transacciones ADD COLUMN numero INTEGER`,

  // ── Recursos asignados a la operación (camión + chofer) ─────────
  `ALTER TABLE op_encabezado ADD COLUMN id_chofer TEXT`,
  `ALTER TABLE op_encabezado ADD COLUMN id_camion TEXT`,
  `ALTER TABLE op_encabezado ADD COLUMN asignacion_fecha TEXT`,
  `ALTER TABLE op_encabezado ADD COLUMN asignacion_usuario TEXT`,

  // ── Módulo Choferes — campos extra en empleados ─────────────────
  `ALTER TABLE empleados ADD COLUMN cuil TEXT`,
  `ALTER TABLE empleados ADD COLUMN contacto_emergencia TEXT`,
  `ALTER TABLE empleados ADD COLUMN contacto_emergencia_tel TEXT`,
  `ALTER TABLE empleados ADD COLUMN convenio TEXT`,
  `ALTER TABLE empleados ADD COLUMN categoria_laboral TEXT`,
  `ALTER TABLE empleados ADD COLUMN sueldo_basico REAL DEFAULT 0`,
  `ALTER TABLE empleados ADD COLUMN supervisor_id TEXT`,
  `ALTER TABLE empleados ADD COLUMN es_chofer INTEGER DEFAULT 0`,
  `ALTER TABLE empleados ADD COLUMN licencia_numero TEXT`,
  `ALTER TABLE empleados ADD COLUMN licencia_fecha_emision TEXT`,
  `ALTER TABLE empleados ADD COLUMN licencia_organismo TEXT`,
  `ALTER TABLE empleados ADD COLUMN fecha_baja TEXT`,
  `ALTER TABLE empleados ADD COLUMN motivo_baja TEXT`,

  // ── Módulo Flota — campos extra en flota_vehiculos ──────────────
  `ALTER TABLE flota_vehiculos ADD COLUMN marca TEXT`,
  `ALTER TABLE flota_vehiculos ADD COLUMN modelo TEXT`,
  `ALTER TABLE flota_vehiculos ADD COLUMN anio INTEGER`,
  `ALTER TABLE flota_vehiculos ADD COLUMN nro_chasis TEXT`,
  `ALTER TABLE flota_vehiculos ADD COLUMN nro_motor TEXT`,
  `ALTER TABLE flota_vehiculos ADD COLUMN tipo_unidad TEXT`,
  `ALTER TABLE flota_vehiculos ADD COLUMN capacidad_carga REAL`,
  `ALTER TABLE flota_vehiculos ADD COLUMN estado_operativo TEXT DEFAULT 'disponible'`,

  // ── Flota — combustible y mantenimiento ─────────────────────────
  `ALTER TABLE combustible ADD COLUMN estacion TEXT`,
  `ALTER TABLE mantenimiento_vehiculo ADD COLUMN categoria TEXT DEFAULT 'preventivo'`,
  `ALTER TABLE mantenimiento_vehiculo ADD COLUMN descripcion TEXT DEFAULT ''`,
  `ALTER TABLE mantenimiento_vehiculo ADD COLUMN proximo_km INTEGER`,
  `ALTER TABLE mantenimiento_vehiculo ADD COLUMN archivo TEXT`,

  // ── Flota de Personal — campos de gestión de flota ──────────────
  `ALTER TABLE flota_vehiculos ADD COLUMN numero_interno INTEGER`,
  `ALTER TABLE flota_vehiculos ADD COLUMN fecha_ultimo_mant TEXT`,
  `ALTER TABLE flota_vehiculos ADD COLUMN fecha_proximo_mant TEXT`,
  `ALTER TABLE flota_vehiculos ADD COLUMN observaciones TEXT DEFAULT ''`,
  `ALTER TABLE maquinaria ADD COLUMN numero_interno INTEGER`,
  `ALTER TABLE maquinaria ADD COLUMN horas_uso REAL DEFAULT 0`,
  `ALTER TABLE maquinaria ADD COLUMN estado_operativo TEXT DEFAULT 'disponible'`,
  `ALTER TABLE maquinaria ADD COLUMN marca TEXT`,

  // ── Circuitos — chofer como empleado (además del id_chofer→users heredado) ─
  `ALTER TABLE circuitos ADD COLUMN id_empleado TEXT`,
]

for (const sql of migrations) {
  try { db.exec(sql) } catch (_) { /* columna ya existe */ }
}

// ═══════════════════════════════════════════════════════════════════
// TABLAS DE CONFIGURACIÓN
// ═══════════════════════════════════════════════════════════════════

db.exec(`
  CREATE TABLE IF NOT EXISTS config_contenedores (
    id          TEXT PRIMARY KEY,
    clave       TEXT NOT NULL UNIQUE,
    valor       TEXT NOT NULL DEFAULT '',
    descripcion TEXT DEFAULT '',
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS config_maquinaria (
    id             TEXT PRIMARY KEY,
    id_maquinaria  TEXT REFERENCES maquinaria(id),
    clave          TEXT NOT NULL,
    valor          TEXT NOT NULL DEFAULT '',
    created_at     TEXT DEFAULT (datetime('now')),
    UNIQUE(id_maquinaria, clave)
  );
`)

// Seed config contenedores (valores actuales hardcodeados)
;(() => {
  const defaults = [
    ['precio_dia', '30000', 'Precio por día de alquiler'],
    ['precio_alquiler', '250000', 'Precio base alquiler (9+ días)'],
    ['plazo_minimo', '4', 'Plazo mínimo en días'],
    ['plazo_maximo', '9', 'Plazo máximo en días'],
    ['tiempo_entre_alquileres', '0', 'Horas mínimas entre alquileres'],
    ['costo_extra_dia', '30000', 'Costo extra por día adicional'],
  ]
  const ins = db.prepare(`INSERT OR IGNORE INTO config_contenedores (id, clave, valor, descripcion) VALUES (?, ?, ?, ?)`)
  defaults.forEach(([clave, valor, desc]) => ins.run(crypto.randomUUID(), clave, valor, desc))
})()

// Seed config maquinaria global
;(() => {
  const defaults = [
    ['precio_por_hora_default', '15000', null],
    ['precio_por_dia_default', '80000', null],
    ['modo_precio_default', 'hora', null],
  ]
  const ins = db.prepare(`INSERT OR IGNORE INTO config_maquinaria (id, id_maquinaria, clave, valor) VALUES (?, NULL, ?, ?)`)
  defaults.forEach(([clave, valor]) => ins.run(crypto.randomUUID(), clave, valor))
})()


// ── Backfill: número interno de camiones y maquinaria ─────────────
;(() => {
  const tablas = ['flota_vehiculos', 'maquinaria']
  tablas.forEach(t => {
    const pend = db.prepare(`SELECT id FROM ${t} WHERE numero_interno IS NULL ORDER BY created_at, id`).all()
    if (!pend.length) return
    let next = (db.prepare(`SELECT COALESCE(MAX(numero_interno),0) AS m FROM ${t}`).get().m || 0) + 1
    const upd = db.prepare(`UPDATE ${t} SET numero_interno = ? WHERE id = ?`)
    db.transaction(() => { pend.forEach(r => { upd.run(next, r.id); next++ }) })()
  })
})()

// ── Backfill: numerar transacciones por tipo (numero secuencial) ──
;(() => {
  const pend = db.prepare(`SELECT id, tipo FROM transacciones WHERE numero IS NULL ORDER BY created_at, id`).all()
  if (!pend.length) return
  const maxPorTipo = {}
  db.prepare(`SELECT tipo, COALESCE(MAX(numero),0) AS m FROM transacciones WHERE numero IS NOT NULL GROUP BY tipo`).all()
    .forEach(r => { maxPorTipo[r.tipo] = r.m })
  const upd = db.prepare(`UPDATE transacciones SET numero = ? WHERE id = ?`)
  db.transaction(() => {
    pend.forEach(t => { const n = (maxPorTipo[t.tipo] || 0) + 1; maxPorTipo[t.tipo] = n; upd.run(n, t.id) })
  })()
})()

// ── Backfill: numerar clientes sin numero asignado ────────────────
;(() => {
  const pendientes = db.prepare(`SELECT id FROM clientes WHERE numero IS NULL ORDER BY created_at, id`).all()
  if (!pendientes.length) return
  const maxRow = db.prepare(`SELECT COALESCE(MAX(numero), 0) AS m FROM clientes`).get()
  let next = (maxRow.m || 0) + 1
  const upd = db.prepare(`UPDATE clientes SET numero = ? WHERE id = ?`)
  db.transaction(() => {
    pendientes.forEach(c => { upd.run(next, c.id); next++ })
  })()
})()


// ═══════════════════════════════════════════════════════════════════
// SEED DE DESARROLLO
// Datos iniciales para poder correr el proyecto localmente.
// En producción se pueden limpiar o conservar como referencia.
// ═══════════════════════════════════════════════════════════════════

// ── Usuarios por rol ─────────────────────────────────────────────
const seedUsuarios = [
  { usuario: 'valentino',      nombre: 'Valentino Mezzavilla', rol: 'dueno'          },
  { usuario: 'admin_ventas',   nombre: 'Admin Ventas',         rol: 'admin_ventas'   },
  { usuario: 'admin_contable', nombre: 'Admin Contable',       rol: 'admin_contable' },
  { usuario: 'chofer1',        nombre: 'Chofer Demo',          rol: 'chofer'         },
]

const insUser = db.prepare(`
  INSERT OR IGNORE INTO users (id, usuario, password_hash, nombre, rol)
  VALUES (?, ?, ?, ?, ?)
`)
seedUsuarios.forEach(u => {
  insUser.run(
    crypto.randomUUID(),
    u.usuario,
    bcrypt.hashSync('suelosur123', 10),
    u.nombre,
    u.rol
  )
})

// ── Productos (áridos) ───────────────────────────────────────────
const cantProductos = db.prepare('SELECT COUNT(*) AS n FROM productos').get().n
if (cantProductos === 0) {
  const insProd = db.prepare(`
    INSERT INTO productos (id, nombre, unidad_medida, precio_referencia)
    VALUES (?, ?, ?, ?)
  `)
  ;[
    ['Arena Fina',     'm³',  8500],
    ['Arena Gruesa',   'm³',  7800],
    ['Piedra Partida', 'm³',  9200],
    ['Piedra Bola',    'm³',  8800],
    ['Canto Rodado',   'm³', 10500],
    ['Tosca',          'm³',  5500],
  ].forEach(([nombre, um, precio]) =>
    insProd.run(crypto.randomUUID(), nombre, um, precio)
  )
}

// ── Stock inicial (una fila por producto) ────────────────────────
const productosParaStock = db.prepare(`
  SELECT p.id FROM productos p
  WHERE p.activo = 1
    AND NOT EXISTS (SELECT 1 FROM stock s WHERE s.id_producto = p.id)
`).all()

if (productosParaStock.length) {
  const insStock = db.prepare(`
    INSERT INTO stock (id, id_producto, cantidad_actual, cant_pendiente_entregar, stock_minimo)
    VALUES (?, ?, 0, 0, 0)
  `)
  productosParaStock.forEach(p => insStock.run(crypto.randomUUID(), p.id))
}

// ── Clientes de ejemplo ──────────────────────────────────────────
const cantClientes = db.prepare('SELECT COUNT(*) AS n FROM clientes').get().n
if (cantClientes === 0) {
  const insCli = db.prepare(`
    INSERT INTO clientes (id, nombre, apellido, domicilio_ppal, zona, tel_whatsapp, tipo_cliente)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  ;[
    ['Construcciones Norte', 'SRL', 'Av. Vélez Sársfield 3200', 'Norte',  '3514001234', 'Empresa'   ],
    ['García',               'Roberto', 'Colón 1420',           'Centro', '3513009876', 'Particular'],
    ['Obra Bv. Chacabuco',   '',   'Bv. Chacabuco 890',         'Sur',    '3512005678', 'Obra'      ],
  ].forEach(([nombre, apellido, dom, zona, tel, tipo]) =>
    insCli.run(crypto.randomUUID(), nombre, apellido, dom, zona, tel, tipo)
  )
}

// ── Proveedores de ejemplo ───────────────────────────────────────
const cantProv = db.prepare('SELECT COUNT(*) AS n FROM proveedores').get().n
if (cantProv === 0) {
  const insProv = db.prepare(`INSERT INTO proveedores (id, nombre, cuit, domicilio, telefono, email) VALUES (?, ?, ?, ?, ?, ?)`)
  ;[
    ['Cantera del Centro S.A.', '30-11223344-5', 'Ruta 9 Km 12',        '3514112233', 'ventas@canteracentro.com'],
    ['Áridos del Sur SRL',      '30-55667788-9', 'Camino a Alta Gracia', '3515667788', 'info@aridosdelsur.com'],
    ['Transporte Norte',        '20-99887766-5', 'Av. Japón 1500',       '3513445566', 'contacto@transportenorte.com'],
  ].forEach(([nombre, cuit, dom, tel, email]) => insProv.run(crypto.randomUUID(), nombre, cuit, dom, tel, email))
}

// ── Flota (5 camiones + 1 Bobcat) ───────────────────────────────
const cantFlota = db.prepare('SELECT COUNT(*) AS n FROM flota_vehiculos').get().n
if (cantFlota === 0) {
  const insFlota = db.prepare(`
    INSERT INTO flota_vehiculos (id, tipo_vehiculo, patente, nombre)
    VALUES (?, ?, ?, ?)
  `)
  ;[
    ['camion', 'ABC123', 'Camión 1'],
    ['camion', 'DEF456', 'Camión 2'],
    ['camion', 'GHI789', 'Camión 3'],
    ['camion', 'JKL012', 'Camión 4'],
    ['camion', 'MNO345', 'Camión 5'],
    ['bobcat', 'PQR678', 'Bobcat'],
  ].forEach(([tipo, patente, nombre]) =>
    insFlota.run(crypto.randomUUID(), tipo, patente, nombre)
  )
}

// ── Contenedores (10 de ejemplo) ────────────────────────────────
const cantContenedores = db.prepare('SELECT COUNT(*) AS n FROM contenedores').get().n
if (cantContenedores === 0) {
  const insCont = db.prepare(`
    INSERT INTO contenedores (id, numero_contenedor, estado_general)
    VALUES (?, ?, 'operativo')
  `)
  const insMov = db.prepare(`
    INSERT INTO movimiento_contenedor (id, id_contenedor, estado_paso, observaciones)
    VALUES (?, ?, 'en_planta', 'Alta inicial')
  `)
  for (let n = 1; n <= 10; n++) {
    const id = crypto.randomUUID()
    insCont.run(id, n)
    insMov.run(crypto.randomUUID(), id)
  }
}

// ── Maquinaria (1 Bobcat de ejemplo) ────────────────────────────
const cantMaquinaria = db.prepare('SELECT COUNT(*) AS n FROM maquinaria').get().n
if (cantMaquinaria === 0) {
  const insMaq = db.prepare(`
    INSERT INTO maquinaria (id, nombre, tipo, patente, estado_general)
    VALUES (?, ?, ?, ?, 'operativo')
  `)
  const insMovMaq = db.prepare(`
    INSERT INTO movimiento_maquinaria (id, id_maquinaria, estado_paso, observaciones)
    VALUES (?, ?, 'en_planta', 'Alta inicial')
  `)
  const id = crypto.randomUUID()
  insMaq.run(id, 'Bobcat S650', 'bobcat', 'PQR678')
  insMovMaq.run(crypto.randomUUID(), id)
}

// ════════════════════════════════════════════════════════════════
module.exports = db
