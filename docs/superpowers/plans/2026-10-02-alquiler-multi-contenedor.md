# Alquiler con varios contenedores — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Poder cargar varios contenedores en un mismo alquiler, cada uno con su propio ciclo, con cobro por contenedor o por alquiler elegido al crear.

**Architecture:** Un alquiler agrupado es un registro en `alquiler_grupos` más N operaciones `tipo_op = 'C'` (una por contenedor) enlazadas por `op_encabezado.id_grupo`. Cada OP conserva todo el workflow actual (estado, chofer, camión, vencimiento, retiro); el grupo agrega el alta atómica, el cobro "por alquiler" (una transacción por OP + un solo cargo de cuenta corriente por el total) y la vista agrupada. Un alquiler de un solo contenedor no tiene grupo y funciona exactamente como hoy.

**Tech Stack:** Node.js 24, Express 4, EJS, PostgreSQL (Supabase) vía `pg` con el helper `query`/`transaction` de `src/config/db.js`, SCSS (`npm run build`), pruebas con `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-10-02-alquiler-multi-contenedor-design.md`

## Global Constraints

- Alquiler de un solo contenedor: `id_grupo` NULL y comportamiento idéntico al actual (alta, retiro, cobro, hoja de ruta).
- Nada del workflow se bloquea por remitos: firma y foto siguen opcionales; un N° de remito compartido por todas las OP del grupo.
- Cada OP mantiene su estado, chofer, camión, vencimiento y retiro. La hoja de ruta del chofer no se modifica.
- El selector de cobro aparece solo con 2 o más contenedores; valores exactos: `'contenedor'` | `'alquiler'`.
- Cobro por alquiler: una fila en `transacciones` por OP y **un solo** movimiento en `movimientos_cuenta` (cuenta corriente o saldo a favor) por el total, anclado a la OP principal (la de menor `id`).
- v1: altas con varios contenedores solo "normal" y "ya en curso". Programado encadenado e histórico finalizado siguen de a uno.
- Migraciones en `initDB()` con `IF NOT EXISTS` + copia en `migrations/`.
- Fechas: `ahora_local()` en SQL y `hoyISO()` en Node; nunca `new Date().toISOString()` para "hoy".
- **El `.env` apunta a la base de PRODUCCIÓN.** Las pruebas corren siempre dentro de una transacción con ROLLBACK (`tests/helpers/db.js`); nunca persisten nada.
- **No correr pruebas ni editar `src/config/db.js` con `npm run dev` levantado:** nodemon reinicia el servidor en cada guardado y corre `initDB()` contra producción. Verificar antes con `Get-CimInstance Win32_Process -Filter "Name='node.exe'"`.
- Toda escritura directa en la base de producción (fuera de un deploy) la ejecuta el usuario; el agente no la corre.
- Push a `main` solo con OK explícito del usuario.
- Textos de pantalla en español rioplatense, como el resto de la app; montos con `toLocaleString('es-AR')`.
- Commits en español, terminados en `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Cobro del grupo ejecutado dos veces** (doble clic en "Registrar retiro", o el chofer y la oficina cerrando a la vez): tiene que quedar un solo cobro. → prueba en la Tarea 7.
2. **Contenedor del grupo que se retira directo al próximo alquiler encadenado** (no vuelve a planta): el grupo igual tiene que cobrarse al retirar el último. → prueba en la Tarea 7.
3. **Contenedor del grupo repuesto por otra unidad** ("Reponer"): sigue abierto hasta que se retire la unidad nueva. → prueba en la Tarea 7.
4. **IDs chicos en los formularios** (`qs` convierte `precio_c[3]` en un array y pierde a qué contenedor iba cada valor): precios y montos tienen que seguir asociados a su contenedor/OP. → pruebas en la Tarea 2.
5. **Alquileres existentes de un contenedor** (`id_grupo` NULL): alta, retiro y cobro idénticos a hoy. → pruebas en las Tareas 2, 3 y 7.

---

## Mapa de archivos

| Archivo | Responsabilidad |
|---|---|
| `tests/helpers/db.js` (nuevo) | Arnés: transacción con ROLLBACK, savepoint por sentencia, restaura `op_nro_seq` |
| `tests/helpers/datos.js` (nuevo) | Contenedores, cliente y datos comunes de prueba (dentro de la transacción) |
| `tests/helpers/vistas.js` (nuevo) | Render de vistas/parciales EJS con los helpers de `res.locals` |
| `src/config/db.js` | `migrarGruposAlquiler()` (tabla + columna + índice) |
| `migrations/2026-10-02_alquiler_grupos.sql` (nuevo) | Copia manual de la migración |
| `src/config/alquiler.js` | `calcularPlazoAlquiler()` (reglas de plazo del alta) |
| `src/utils/contenedoresForm.js` (nuevo) | Lectura de la selección de contenedores y de montos por OP del formulario |
| `src/models/alquileres.model.js` | `_insertarAlquiler`, `crearGrupo`, `grupoDe`, ubicación compartida, cobro del grupo, cobranzas agrupadas, anular/editar/agrupar |
| `src/models/transacciones.model.js` | `crear(datos, q)`; bloqueo de borrado en cobros agrupados |
| `src/models/clientes.model.js` | `agregarMovimiento(id, datos, q)`; `SQL_OP_SIN_CARGO` contempla el grupo |
| `src/controllers/alquileres.controller.js` | Alta agrupada, detalle, retiro, cobranzas, anular, editar, mapa |
| `src/routes/alquileres.routes.js` | `POST /contenedores/:id/anular-grupo` |
| `views/pages/alquileres/nuevo.ejs` + `public/js/alquilerService.js` + `src/scss/pages/_alquileres.scss` | Selección múltiple en el alta |
| `views/partials/alquiler_grupo.ejs` (nuevo) | Panel "Alquiler agrupado" del detalle |
| `views/partials/alquiler_cierre.ejs` (nuevo) | Cierre (retiro + cobro), extraído de `detalle.ejs` y con soporte de grupo |
| `views/pages/alquileres/index.ejs`, `detalle.ejs`, `cobranzas.ejs`, `editar.ejs` | Insignia, panel, filas agrupadas, "aplicar a todos" |
| `public/js/mapaUtils.js` (nuevo) + `public/js/mapaContenedores.js` | Separar pines superpuestos |
| `scripts/agrupar-alquileres.js` (nuevo) | Agrupar alquileres ya cargados por separado |

Comandos de prueba:
- Un archivo: `node --test --test-concurrency=1 tests/<archivo>.test.js`
- Todo: `npm test`

---

# Fase 1 — Modelo y alta

### Task 1: Arnés de pruebas y migración de grupos

**Files:**
- Create: `tests/helpers/db.js`
- Create: `tests/alquiler-grupos-migracion.test.js`
- Create: `migrations/2026-10-02_alquiler_grupos.sql`
- Modify: `src/config/db.js` (nueva función antes de `migrarHorasALocal`, llamada en `initDB`, export)
- Modify: `package.json` (script `test`)

**Interfaces:**
- Produces: `tests/helpers/db.js` → `{ abrir(): Promise<void>, cerrar(): Promise<void>, q(sql, params): Promise<QueryResult> }` (placeholders `?`). `src/config/db.js` exporta `migrarGruposAlquiler(): Promise<void>`. Tabla `alquiler_grupos(id BIGINT, cobro_modo TEXT, created_at TEXT)` y columna `op_encabezado.id_grupo BIGINT NULL`.

- [ ] **Step 0: Verificar que no haya un servidor local corriendo**

Run (PowerShell): `Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -match 'SUELOSUR|server.js|nodemon' } | Select-Object ProcessId, CommandLine`
Expected: sin resultados. Si aparece `nodemon`/`server.js`, pedirle al usuario que lo frene antes de seguir.

- [ ] **Step 1: Crear el arnés `tests/helpers/db.js`**

```js
'use strict'
// Arnés de pruebas contra la base de datos.
//
// No hay base de desarrollo: el .env apunta a PRODUCCIÓN. Por eso cada archivo de prueba
// trabaja dentro de UNA transacción que se deshace al final (ROLLBACK): nada de lo que
// hacen las pruebas queda guardado. Cada sentencia corre en su propio SAVEPOINT, así un
// error esperado (ej. "contenedor ocupado") no aborta la transacción entera.
//
// IMPORTANTE: requerir este archivo ANTES que cualquier modelo: los modelos copian `query`
// y `transaction` de src/config/db en el momento en que se cargan.
const path = require('path')
process.env.TZ = process.env.TZ || 'America/Argentina/Cordoba'
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') })
const db = require('../../src/config/db')

let cliente = null
let contador = 0
let secuenciaInicial = null

const aPostgres = (sql) => { let i = 0; return String(sql).replace(/\?/g, () => `$${++i}`) }

async function enSavepoint(fn) {
  const sp = `sp_${++contador}`
  await cliente.query(`SAVEPOINT ${sp}`)
  try {
    const r = await fn()
    await cliente.query(`RELEASE SAVEPOINT ${sp}`)
    return r
  } catch (e) {
    await cliente.query(`ROLLBACK TO SAVEPOINT ${sp}`)
    throw e
  }
}

const correr = (sql, params = []) => enSavepoint(() => cliente.query(sql, params))

// Mientras dura la prueba, todo el código de la app pasa por la transacción de prueba.
db.query = (sql, params) => correr(aPostgres(sql), params)
db.pool.query = (sql, params) => correr(sql, params)
db.transaction = (fn) => enSavepoint(() => fn((sql, params) => correr(aPostgres(sql), params)))

async function abrir() {
  cliente = await db.pool.connect()
  // Cualquier otra conexión escribiría FUERA de la transacción de prueba (en producción).
  db.pool.connect = async () => { throw new Error('Prueba: el código intentó abrir otra conexión a la base') }
  await cliente.query('BEGIN')
  // nextval() no se deshace con ROLLBACK: se guarda la secuencia de N° de OP para
  // devolverla al final y no dejar huecos en la numeración real.
  secuenciaInicial = (await cliente.query(`SELECT last_value FROM op_nro_seq`)).rows[0]?.last_value ?? null
  // Si la migración de grupos todavía no está desplegada, se aplica dentro de la prueba
  // (y se deshace con el ROLLBACK). Mientras tanto bloquea op_encabezado en producción:
  // por eso la Tarea 1 se despliega antes de seguir con el resto.
  const hayGrupos = (await cliente.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'op_encabezado' AND column_name = 'id_grupo'`)).rowCount
  if (!hayGrupos && typeof db.migrarGruposAlquiler === 'function') await db.migrarGruposAlquiler()
}

async function cerrar() {
  if (!cliente) return
  try {
    if (secuenciaInicial != null) await cliente.query(`SELECT setval('op_nro_seq', $1)`, [secuenciaInicial])
  } finally {
    await cliente.query('ROLLBACK')
    cliente.release()
    cliente = null
    await db.pool.end()
  }
}

module.exports = { abrir, cerrar, q: (sql, params) => db.query(sql, params) }
```

- [ ] **Step 2: Escribir la prueba `tests/alquiler-grupos-migracion.test.js`**

```js
'use strict'
const prueba = require('./helpers/db')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { migrarGruposAlquiler } = require('../src/config/db')

describe('migración: alquileres agrupados', () => {
  before(prueba.abrir)
  after(prueba.cerrar)

  it('crea alquiler_grupos y op_encabezado.id_grupo, y se puede correr dos veces', async () => {
    await migrarGruposAlquiler()
    await migrarGruposAlquiler()
    const cols = (await prueba.q(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE (table_name = 'alquiler_grupos' AND column_name IN ('id', 'cobro_modo', 'created_at'))
         OR (table_name = 'op_encabezado' AND column_name = 'id_grupo')`)).rows
    assert.equal(cols.length, 4)
  })

  it('cobro_modo solo acepta contenedor o alquiler, y created_at queda en hora local', async () => {
    await assert.rejects(prueba.q(`INSERT INTO alquiler_grupos (cobro_modo) VALUES ('otro')`))
    const r = (await prueba.q(`INSERT INTO alquiler_grupos (cobro_modo) VALUES ('alquiler') RETURNING id, created_at`)).rows[0]
    assert.ok(r.id)
    assert.match(r.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })
})
```

- [ ] **Step 3: Agregar el script de pruebas a `package.json`**

En `"scripts"`, agregar después de `"geocodificar:alquileres"`:

```json
    "test": "node --test --test-concurrency=1 \"tests/**/*.test.js\""
```

(`--test-concurrency=1`: los archivos comparten la base; en paralelo se bloquearían entre sí.)

- [ ] **Step 4: Correr la prueba y verificar que falla**

Run: `node --test --test-concurrency=1 tests/alquiler-grupos-migracion.test.js`
Expected: FAIL con `TypeError: migrarGruposAlquiler is not a function`.

- [ ] **Step 5: Implementar `migrarGruposAlquiler` en `src/config/db.js`**

Agregar justo antes del bloque `// MIGRACIÓN: fechas/horas en hora de Argentina` (antes de `const COLUMNAS_CON_DEFAULT_HORA`):

```js
// ─────────────────────────────────────────────────────────────────
// MIGRACIÓN: alquileres con varios contenedores. Un alquiler agrupado es un grupo de
// operaciones (una por contenedor) que comparten cliente, dirección, remito y modo de
// cobro. Un alquiler de un solo contenedor no tiene grupo (id_grupo NULL).
// Sin .catch(): si falla, initDB falla y Render no levanta la versión nueva (la vieja
// sigue andando), en vez de arrancar sin las columnas que el código necesita.
// ─────────────────────────────────────────────────────────────────
async function migrarGruposAlquiler() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS alquiler_grupos (
      id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      cobro_modo TEXT NOT NULL DEFAULT 'contenedor' CHECK (cobro_modo IN ('contenedor', 'alquiler')),
      created_at TEXT DEFAULT ahora_local()
    )
  `)
  await pool.query(`ALTER TABLE op_encabezado ADD COLUMN IF NOT EXISTS id_grupo BIGINT REFERENCES alquiler_grupos(id)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_op_encabezado_id_grupo ON op_encabezado (id_grupo) WHERE id_grupo IS NOT NULL`)
}
```

En `initDB()`, reemplazar:

```js
  await migrarHorasALocal()

  console.log('✅ Base de datos PostgreSQL inicializada')
```

por:

```js
  await migrarGruposAlquiler()
  await migrarHorasALocal()

  console.log('✅ Base de datos PostgreSQL inicializada')
```

Reemplazar el export final:

```js
module.exports = { pool, query, transaction, initDB, limpiarRastreoViejo, migrarHorasALocal }
```

por:

```js
module.exports = { pool, query, transaction, initDB, limpiarRastreoViejo, migrarHorasALocal, migrarGruposAlquiler }
```

- [ ] **Step 6: Crear `migrations/2026-10-02_alquiler_grupos.sql`**

```sql
-- Alquileres con varios contenedores: un alquiler agrupado es un grupo de operaciones
-- (una por contenedor). Se aplica sola al arrancar la app (initDB en src/config/db.js);
-- este archivo es para correrla a mano en el SQL Editor de Supabase si hace falta.
-- Idempotente. Requiere la función ahora_local() (migración de hora local).

CREATE TABLE IF NOT EXISTS alquiler_grupos (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- 'contenedor': cada OP se cobra al retirarla. 'alquiler': todo junto al retirar la última.
  cobro_modo TEXT NOT NULL DEFAULT 'contenedor' CHECK (cobro_modo IN ('contenedor', 'alquiler')),
  created_at TEXT DEFAULT ahora_local()
);

-- NULL = alquiler de un solo contenedor (como siempre).
ALTER TABLE op_encabezado ADD COLUMN IF NOT EXISTS id_grupo BIGINT REFERENCES alquiler_grupos(id);
CREATE INDEX IF NOT EXISTS idx_op_encabezado_id_grupo ON op_encabezado (id_grupo) WHERE id_grupo IS NOT NULL;
```

- [ ] **Step 7: Correr la prueba y verificar que pasa**

Run: `node --test --test-concurrency=1 tests/alquiler-grupos-migracion.test.js`
Expected: `ℹ pass 2`, `ℹ fail 0`.

Run: `node --check src/config/db.js`
Expected: sin salida.

- [ ] **Step 8: Commit**

```bash
git add tests/helpers/db.js tests/alquiler-grupos-migracion.test.js migrations/2026-10-02_alquiler_grupos.sql src/config/db.js package.json
git commit -m "Alquileres agrupados: migración (alquiler_grupos + op_encabezado.id_grupo) y arnés de pruebas

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 9: Desplegar solo la migración**

La migración es aditiva (tabla nueva y columna NULL) y no cambia ningún comportamiento. Desplegarla ya evita que las pruebas siguientes tengan que crear la columna dentro de su transacción (eso bloquea `op_encabezado` en producción mientras dura la prueba).

1. Pedir OK al usuario para el push.
2. `git checkout main && git pull --ff-only origin main && git merge --no-ff feat/alquiler-multi-contenedor -m "Merge feat/alquiler-multi-contenedor (migración de grupos)" && git push origin main && git checkout feat/alquiler-multi-contenedor`
3. Esperar el deploy de Render y verificar (solo lectura): `SELECT to_regclass('alquiler_grupos') AS t, (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'op_encabezado' AND column_name = 'id_grupo') AS c` → `t = 'alquiler_grupos'`, `c = 1`.

---

### Task 2: Reglas del alta como funciones puras

**Files:**
- Modify: `src/config/alquiler.js`
- Create: `src/utils/contenedoresForm.js`
- Modify: `src/controllers/alquileres.controller.js` (imports; cálculo de plazo en `crear`)
- Create: `tests/helpers/datos.js`
- Create: `tests/helpers/controlador.js`
- Create: `tests/alquiler-plazo.test.js`
- Create: `tests/alquiler-form.test.js`
- Create: `tests/alquiler-grupos-controlador.test.js`

**Interfaces:**
- Consumes: `diasHabilesEntre(ini, fin)` y `sumarDiasHabiles(ini, dias)` de `src/utils/diasHabiles.js`.
- Produces:
  - `calcularPlazoAlquiler({ fechaInicio, fechaFin, sinFechaFin, esHistorico, fechaFinManual, tieneCC }) → { plazo: number|null } | { error: string }` (en `src/config/alquiler.js`).
  - `leerContenedoresDelForm(body) → { contenedores: Array<{ id_contenedor: string, precio: string, fin: string }> } | { error: string }`.
  - `leerMontosPorOp(valor) → valor` (string sin cambios; objeto `{ op<ID>: monto }` → `{ <ID>: monto }`).
  - `tests/helpers/datos.js` → `crearContenedores(n): Promise<number[]>`, `crearCliente({ cuentaCorriente }): Promise<number>`, `idAdministrativo(): Promise<number>`, `datosComunes({ id_cliente, id_administrativo, metodo_pago, fecha_inicio }): object`.
  - `tests/helpers/controlador.js` → `llamar(accion, { body, params, user }) → Promise<{ url, flashes } | { vista, data, flashes } | { json, flashes }>` (cada flash: `{ tipo, msg }`). Se requiere DESPUÉS de `./helpers/db`.

- [ ] **Step 1: Escribir `tests/alquiler-plazo.test.js`**

```js
'use strict'
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { calcularPlazoAlquiler, PLAZO_ESTANDAR, PLAZO_CUENTA_CORRIENTE } = require('../src/config/alquiler')
const { sumarDiasHabiles } = require('../src/utils/diasHabiles')

const INICIO = '2026-10-05' // lunes

describe('calcularPlazoAlquiler', () => {
  it('sin cuenta corriente usa el plazo estándar', () => {
    assert.deepEqual(calcularPlazoAlquiler({ fechaInicio: INICIO, tieneCC: false }), { plazo: PLAZO_ESTANDAR })
  })

  it('con cuenta corriente usa el plazo largo por defecto', () => {
    assert.deepEqual(calcularPlazoAlquiler({ fechaInicio: INICIO, tieneCC: true }), { plazo: PLAZO_CUENTA_CORRIENTE })
  })

  it('con cuenta corriente y fin editado a mano cuenta los días hábiles', () => {
    const fin = sumarDiasHabiles(INICIO, 7)
    assert.deepEqual(calcularPlazoAlquiler({ fechaInicio: INICIO, fechaFin: fin, fechaFinManual: true, tieneCC: true }), { plazo: 7 })
  })

  it('sin cuenta corriente el fin editado a mano no alarga el plazo', () => {
    const fin = sumarDiasHabiles(INICIO, 9)
    assert.deepEqual(calcularPlazoAlquiler({ fechaInicio: INICIO, fechaFin: fin, fechaFinManual: true, tieneCC: false }), { plazo: PLAZO_ESTANDAR })
  })

  it('sin fecha de fin devuelve null', () => {
    assert.deepEqual(calcularPlazoAlquiler({ fechaInicio: INICIO, fechaFin: '2026-10-20', sinFechaFin: true, tieneCC: true }), { plazo: null })
  })

  it('histórico: sin fin es null; con fin cuenta los días aunque no tenga cuenta corriente', () => {
    assert.deepEqual(calcularPlazoAlquiler({ fechaInicio: INICIO, esHistorico: true }), { plazo: null })
    const fin = sumarDiasHabiles(INICIO, 12)
    assert.deepEqual(calcularPlazoAlquiler({ fechaInicio: INICIO, fechaFin: fin, esHistorico: true, tieneCC: false }), { plazo: 12 })
  })

  it('fin anterior al inicio es un error', () => {
    assert.deepEqual(
      calcularPlazoAlquiler({ fechaInicio: INICIO, fechaFin: '2026-10-01', fechaFinManual: true, tieneCC: true }),
      { error: 'La fecha de fin no puede ser anterior a la de inicio.' })
  })
})
```

- [ ] **Step 2: Escribir `tests/alquiler-form.test.js`**

```js
'use strict'
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const qs = require('qs') // el mismo parser que usa express.urlencoded({ extended: true })
const { leerContenedoresDelForm, leerMontosPorOp } = require('../src/utils/contenedoresForm')

describe('leerContenedoresDelForm', () => {
  it('sin selección devuelve una lista vacía', () => {
    assert.deepEqual(leerContenedoresDelForm({}), { contenedores: [] })
  })

  it('un solo id (string) se lee como un contenedor', () => {
    assert.deepEqual(leerContenedoresDelForm({ ids_contenedor: '7' }),
      { contenedores: [{ id_contenedor: '7', precio: '', fin: '' }] })
  })

  it('con ids chicos, precio y fin propios siguen asociados a su contenedor', () => {
    // Con claves numéricas qs armaría un array y perdería el contenedor: por eso el prefijo "c".
    const body = qs.parse('ids_contenedor[]=3&ids_contenedor[]=5&precio_c[c5]=150&fin_c[c3]=2026-10-20&precio_c[c3]=')
    assert.deepEqual(leerContenedoresDelForm(body), {
      contenedores: [
        { id_contenedor: '3', precio: '', fin: '2026-10-20' },
        { id_contenedor: '5', precio: '150', fin: '' },
      ],
    })
  })

  it('un contenedor repetido es un error', () => {
    assert.deepEqual(leerContenedoresDelForm({ ids_contenedor: ['4', '4'] }),
      { error: 'Elegiste el mismo contenedor más de una vez.' })
  })
})

describe('leerMontosPorOp', () => {
  it('deja igual un monto suelto o vacío', () => {
    assert.equal(leerMontosPorOp('1500'), '1500')
    assert.equal(leerMontosPorOp(undefined), undefined)
  })

  it('convierte { op<ID>: monto } en { <ID>: monto }, también con ids chicos', () => {
    const body = qs.parse('precio_final[op3]=100&precio_final[op12]=250')
    assert.deepEqual(leerMontosPorOp(body.precio_final), { 3: '100', 12: '250' })
  })
})
```

- [ ] **Step 3: Crear `tests/helpers/datos.js`**

```js
'use strict'
// Datos de prueba: se crean dentro de la transacción de la prueba y desaparecen con el
// ROLLBACK. Los N° de contenedor de prueba arrancan en 90001 para no chocar con los reales.
const { q } = require('./db')

let proximoNumero = 90001

// Contenedores nuevos, disponibles (último movimiento 'disponible').
async function crearContenedores(n) {
  const ids = []
  for (let i = 0; i < n; i++) {
    const { id } = (await q(`INSERT INTO contenedores (numero_contenedor) VALUES (?) RETURNING id`, [proximoNumero++])).rows[0]
    await q(`INSERT INTO movimiento_contenedor (id_contenedor, estado_paso, observaciones) VALUES (?, 'disponible', 'Prueba')`, [id])
    ids.push(id)
  }
  return ids
}

async function crearCliente({ cuentaCorriente = false } = {}) {
  return (await q(
    `INSERT INTO clientes (nombre, apellido, cuenta_corriente, activo, saldo) VALUES ('PRUEBA', 'GRUPOS', ?, 1, 0) RETURNING id`,
    [cuentaCorriente ? 1 : 0])).rows[0].id
}

async function idAdministrativo() {
  return (await q(`SELECT id FROM users ORDER BY id LIMIT 1`)).rows[0].id
}

// Datos compartidos de un alta (dirección, método de pago, fechas, etc.).
function datosComunes({ id_cliente, id_administrativo, metodo_pago = 'efectivo', fecha_inicio = '2026-10-05' }) {
  return {
    id_cliente, id_administrativo,
    domicilio_entrega: 'San Lorenzo 501', domicilio_calle: 'San Lorenzo', domicilio_numero: '501',
    zona_entrega: '', metodo_pago, observaciones: 'PRUEBA', obra: null,
    fecha_inicio, fecha_entrega_planificada: fecha_inicio,
  }
}

module.exports = { crearContenedores, crearCliente, idAdministrativo, datosComunes }
```

- [ ] **Step 4: Crear `tests/helpers/controlador.js` y escribir `tests/alquiler-grupos-controlador.test.js` (regresión del alta de un contenedor)**

`tests/helpers/controlador.js`:

```js
'use strict'
// Llama una acción del controlador de alquileres con req/res mínimos.
// Resuelve con { url, flashes } (redirect), { vista, data, flashes } (render) o { json, flashes }.
// Requerirlo DESPUÉS de ./db (el controlador carga los modelos).
const Controller = require('../../src/controllers/alquileres.controller')

function llamar(accion, { body = {}, params = {}, user }) {
  return new Promise((resolve, reject) => {
    const flashes = []
    const req = { body, params, session: { user }, flash: (tipo, msg) => flashes.push({ tipo, msg }) }
    const res = {
      redirect: (url) => resolve({ url, flashes }),
      render: (vista, data) => resolve({ vista, data, flashes }),
      json: (data) => resolve({ json: data, flashes }),
      status() { return this },
    }
    Promise.resolve(Controller[accion](req, res)).catch(reject)
  })
}

module.exports = { llamar }
```

`tests/alquiler-grupos-controlador.test.js`:

```js
'use strict'
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const AlquileresModel = require('../src/models/alquileres.model')
const { llamar } = require('./helpers/controlador')
const { hoyISO } = require('../src/utils/fecha')
const { sumarDiasHabiles } = require('../src/utils/diasHabiles')

describe('controlador de alquileres: alta', () => {
  let admin
  const inicio = sumarDiasHabiles(hoyISO(), 3) // a futuro: alta normal, no "ya en curso"

  before(async () => {
    await prueba.abrir()
    admin = { id: await datos.idAdministrativo(), rol: 'dueno' }
    AlquileresModel.ubicar = async () => null // sin llamadas a Nominatim en las pruebas
  })
  after(prueba.cerrar)

  const opsDe = async (id_cliente) => (await prueba.q(`
    SELECT op.id, op.nro_op, op.id_grupo, op.estado, oc.plazo_alquiler, oc.precio_alquiler, oc.id_contenedor
    FROM op_encabezado op JOIN op_detalle_contenedor oc ON oc.id_orden_pedido = op.id
    WHERE op.id_cliente = ? ORDER BY op.id`, [id_cliente])).rows

  const cuerpo = (extra) => ({
    calle: 'San Lorenzo', numero: '501', fechaInicio: inicio, fechaFin: sumarDiasHabiles(inicio, 4),
    precio_alquiler: '100', metodoPago: 'efectivo', ...extra,
  })

  it('un contenedor, sin cuenta corriente: plazo estándar aunque se edite el fin', async () => {
    const id_cliente = await datos.crearCliente()
    const [cont] = await datos.crearContenedores(1)
    const r = await llamar('crear', { user: admin, body: cuerpo({
      clienteId: String(id_cliente), id_contenedor: String(cont),
      editar_fecha_fin: '1', fechaFin: sumarDiasHabiles(inicio, 9),
    }) })
    assert.equal(r.url, '/alquileres/contenedores')
    const [op] = await opsDe(id_cliente)
    assert.equal(op.plazo_alquiler, 4)
    assert.equal(op.id_grupo, null)
  })

  it('un contenedor, con cuenta corriente y fin a mano: cuenta los días hábiles', async () => {
    const id_cliente = await datos.crearCliente({ cuentaCorriente: true })
    const [cont] = await datos.crearContenedores(1)
    await llamar('crear', { user: admin, body: cuerpo({
      clienteId: String(id_cliente), id_contenedor: String(cont),
      editar_fecha_fin: '1', fechaFin: sumarDiasHabiles(inicio, 7),
    }) })
    const [op] = await opsDe(id_cliente)
    assert.equal(op.plazo_alquiler, 7)
  })

  it('fin anterior al inicio vuelve al formulario con el error', async () => {
    const id_cliente = await datos.crearCliente({ cuentaCorriente: true })
    const [cont] = await datos.crearContenedores(1)
    const r = await llamar('crear', { user: admin, body: cuerpo({
      clienteId: String(id_cliente), id_contenedor: String(cont), editar_fecha_fin: '1', fechaFin: '2020-01-01',
    }) })
    assert.equal(r.url, '/alquileres/contenedores/nuevo')
    assert.deepEqual(r.flashes, [{ tipo: 'error', msg: 'La fecha de fin no puede ser anterior a la de inicio.' }])
  })
})
```

- [ ] **Step 5: Correr las pruebas y verificar que fallan**

Run: `node --test --test-concurrency=1 tests/alquiler-plazo.test.js tests/alquiler-form.test.js`
Expected: FAIL (`calcularPlazoAlquiler is not a function`; `Cannot find module '../src/utils/contenedoresForm'`).

Run: `node --test --test-concurrency=1 tests/alquiler-grupos-controlador.test.js`
Expected: PASS (es la regresión del comportamiento actual; tiene que seguir pasando después del refactor).

- [ ] **Step 6: Implementar `calcularPlazoAlquiler` en `src/config/alquiler.js`**

Reemplazar el contenido completo del archivo por:

```js
'use strict'
const { diasHabilesEntre } = require('../utils/diasHabiles')

// Plazo del alquiler de contenedores, en DÍAS HÁBILES: cuánto se le da al cliente
// antes de que el contenedor se marque "Para retirar". Lo determina si el cliente
// tiene cuenta corriente habilitada (no la forma de pago elegida en este alquiler).
// Con cuenta corriente se puede elegir entre PLAZO_ESTANDAR (4) o PLAZO_CUENTA_CORRIENTE
// (10) — ver PLAZOS_CUENTA_CORRIENTE_OPCIONES; sin ella, siempre PLAZO_ESTANDAR.
const PLAZO_CUENTA_CORRIENTE = 10
const PLAZO_ESTANDAR         = 4
const PLAZOS_CUENTA_CORRIENTE_OPCIONES = [PLAZO_ESTANDAR, PLAZO_CUENTA_CORRIENTE]

function plazoPorCuentaCorriente(tieneCuentaCorriente) {
  return tieneCuentaCorriente ? PLAZO_CUENTA_CORRIENTE : PLAZO_ESTANDAR
}

// Plazo con el que se guarda un alquiler nuevo, según las reglas del alta.
// Devuelve { plazo } (null = sin fecha de fin) o { error }.
//  - Sin fecha de fin, o histórico sin fecha de fin → null.
//  - Por defecto, el plazo que le corresponde al cliente (cuenta corriente o estándar).
//  - Histórico o fecha de fin editada a mano → los días hábiles entre inicio y fin
//    (el plazo se guarda en DÍAS HÁBILES, ver sumar_dias_habiles: no los corridos).
//  - Sin cuenta corriente (y no histórico) el plazo es SIEMPRE el estándar: pase lo que
//    pase en el formulario nunca se guarda uno mayor. En carga histórica no rige: ahí se
//    registra la duración real de un alquiler que ya terminó.
function calcularPlazoAlquiler({ fechaInicio, fechaFin, sinFechaFin = false, esHistorico = false, fechaFinManual = false, tieneCC = false }) {
  const fechaFinReal = sinFechaFin ? null : (fechaFin || null)
  let plazo = (sinFechaFin || (esHistorico && !fechaFinReal)) ? null : plazoPorCuentaCorriente(tieneCC)
  if (!sinFechaFin && (esHistorico || fechaFinManual) && fechaInicio && fechaFinReal) {
    plazo = diasHabilesEntre(fechaInicio, fechaFinReal)
    if (plazo < 0) return { error: 'La fecha de fin no puede ser anterior a la de inicio.' }
  }
  if (!tieneCC && !esHistorico && plazo != null) plazo = PLAZO_ESTANDAR
  return { plazo }
}

module.exports = { PLAZO_CUENTA_CORRIENTE, PLAZO_ESTANDAR, PLAZOS_CUENTA_CORRIENTE_OPCIONES, plazoPorCuentaCorriente, calcularPlazoAlquiler }
```

- [ ] **Step 7: Crear `src/utils/contenedoresForm.js`**

```js
'use strict'

// Lectura de los formularios de alquileres con varios contenedores.
//
// Las claves llevan una letra adelante a propósito ("c3", "op12"): con claves numéricas
// el parser del formulario (qs) arma un array, compacta los huecos y se pierde a qué
// contenedor u OP correspondía cada valor.

// Selección del alta (Nuevo alquiler):
//  - ids_contenedor[]  → contenedores elegidos (string si es uno, array si son varios)
//  - precio_c[c<ID>]   → precio propio de ese contenedor (vacío = el precio general)
//  - fin_c[c<ID>]      → fecha de fin propia (vacío = la fecha de fin general)
function leerContenedoresDelForm(body = {}) {
  const crudo = body.ids_contenedor
  const lista = Array.isArray(crudo) ? crudo : (crudo == null ? [] : [crudo])
  const ids = lista.map(v => String(v).trim()).filter(Boolean)
  if (new Set(ids).size !== ids.length) return { error: 'Elegiste el mismo contenedor más de una vez.' }
  const precios = (body.precio_c && typeof body.precio_c === 'object') ? body.precio_c : {}
  const fines = (body.fin_c && typeof body.fin_c === 'object') ? body.fin_c : {}
  return {
    contenedores: ids.map(id => ({
      id_contenedor: id,
      precio: String(precios['c' + id] ?? '').trim(),
      fin: String(fines['c' + id] ?? '').trim(),
    })),
  }
}

// Montos de cierre por OP (precio_final[op<ID>]) → { <ID>: monto }. Un monto suelto
// (string) o vacío se devuelve tal cual.
function leerMontosPorOp(valor) {
  if (!valor || typeof valor !== 'object') return valor
  const montos = {}
  for (const [clave, monto] of Object.entries(valor)) montos[String(clave).replace(/^op/, '')] = monto
  return montos
}

module.exports = { leerContenedoresDelForm, leerMontosPorOp }
```

- [ ] **Step 8: Usar `calcularPlazoAlquiler` en el controlador**

En `src/controllers/alquileres.controller.js`, reemplazar:

```js
const { plazoPorCuentaCorriente, PLAZO_CUENTA_CORRIENTE, PLAZO_ESTANDAR } = require('../config/alquiler')
```

por:

```js
const { plazoPorCuentaCorriente, PLAZO_CUENTA_CORRIENTE, PLAZO_ESTANDAR, calcularPlazoAlquiler } = require('../config/alquiler')
const { leerContenedoresDelForm, leerMontosPorOp } = require('../utils/contenedoresForm')
```

En `crear`, reemplazar el bloque que va desde `let plazo_alquiler = (sinFechaFin || (esHistorico && !fechaFinReal))` hasta `if (!tieneCC && !esHistorico && plazo_alquiler != null) plazo_alquiler = PLAZO_ESTANDAR` (inclusive, con sus comentarios) por:

```js
      // Plazo en días hábiles según las reglas del alta (ver calcularPlazoAlquiler).
      const rPlazo = calcularPlazoAlquiler({ fechaInicio, fechaFin, sinFechaFin, esHistorico, fechaFinManual, tieneCC })
      if (rPlazo.error) {
        req.flash('error', rPlazo.error)
        return res.redirect('/alquileres/contenedores/nuevo')
      }
      const plazo_alquiler = rPlazo.plazo
```

(`leerContenedoresDelForm` y `leerMontosPorOp` se usan en las Tareas 4, 8 y 9; `diasHabilesEntre` sigue en uso en `actualizar`.)

- [ ] **Step 9: Correr las pruebas y verificar que pasan**

Run: `node --test --test-concurrency=1 tests/alquiler-plazo.test.js tests/alquiler-form.test.js tests/alquiler-grupos-controlador.test.js`
Expected: `ℹ fail 0` (7 + 6 + 3 pruebas).

- [ ] **Step 10: Commit**

```bash
git add src/config/alquiler.js src/utils/contenedoresForm.js src/controllers/alquileres.controller.js tests/helpers/datos.js tests/helpers/controlador.js tests/alquiler-plazo.test.js tests/alquiler-form.test.js tests/alquiler-grupos-controlador.test.js
git commit -m "Alquileres: reglas de plazo y lectura del formulario como funciones puras

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Alta en el modelo — `_insertarAlquiler` y `crearGrupo`

**Files:**
- Modify: `src/models/alquileres.model.js` (`contenedorOcupado`, `crear`, `crearEnCurso`; nuevos `_insertarAlquiler`, `crearGrupo`)
- Create: `tests/alquiler-grupos-alta.test.js`

**Interfaces:**
- Consumes: `tests/helpers/db.js`, `tests/helpers/datos.js` (Tareas 1 y 2).
- Produces:
  - `contenedorOcupado(id_contenedor, q = query): Promise<boolean>`
  - `_insertarAlquiler(q, datos, { enCurso }) → Promise<{ id, nro_op, id_oc }>`
  - `crearGrupo({ cobro_modo, en_curso, contenedores: [{ id_contenedor, plazo_alquiler, precio_alquiler }], nro_remito, id_cliente, id_administrativo, domicilio_entrega, domicilio_calle, domicilio_numero, zona_entrega, metodo_pago, observaciones, obra, fecha_inicio, id_chofer, id_camion }) → Promise<{ id_grupo, nro_remito, ops: [{ id, nro_op, id_oc, id_contenedor, precio_alquiler }] }>` (ops ordenadas por id: `ops[0]` es la principal).
  - `crear(...)` y `crearEnCurso(...)`: misma firma y resultado que hoy (`{ id, nro_op, nro_remito }`).

- [ ] **Step 1: Escribir `tests/alquiler-grupos-alta.test.js`**

```js
'use strict'
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const AlquileresModel = require('../src/models/alquileres.model')

describe('alta de alquileres en el modelo', () => {
  let id_cliente, comunes

  before(async () => {
    await prueba.abrir()
    id_cliente = await datos.crearCliente()
    comunes = datos.datosComunes({ id_cliente, id_administrativo: await datos.idAdministrativo() })
  })
  after(prueba.cerrar)

  const opDe = async (id) => (await prueba.q(`
    SELECT op.estado, op.id_grupo, op.nro_remito, oc.id_contenedor, oc.plazo_alquiler, oc.precio_alquiler,
           (SELECT estado_paso FROM movimiento_contenedor m WHERE m.id_op_contenedor = oc.id ORDER BY m.id DESC LIMIT 1) AS mov
    FROM op_encabezado op JOIN op_detalle_contenedor oc ON oc.id_orden_pedido = op.id WHERE op.id = ?`, [id])).rows[0]
  const contar = async (sql, params) => (await prueba.q(sql, params)).rows[0].n

  it('un contenedor (crear): pendiente, reservado y sin grupo, como siempre', async () => {
    const [cont] = await datos.crearContenedores(1)
    const r = await AlquileresModel.crear({ ...comunes, id_contenedor: cont, plazo_alquiler: 4, precio_alquiler: 100 })
    const op = await opDe(r.id)
    assert.deepEqual([op.estado, op.id_grupo, op.mov], ['pendiente', null, 'pendiente_despacho'])
    assert.deepEqual([op.plazo_alquiler, op.precio_alquiler, op.nro_remito], [4, 100, r.nro_remito])
  })

  it('un contenedor ya en curso (crearEnCurso): entregado y en el domicilio', async () => {
    const [cont] = await datos.crearContenedores(1)
    const r = await AlquileresModel.crearEnCurso({ ...comunes, id_contenedor: cont, plazo_alquiler: null, precio_alquiler: 100 })
    const op = await opDe(r.id)
    assert.deepEqual([op.estado, op.id_grupo, op.mov, op.plazo_alquiler], ['entregado', null, 'en_alquiler', null])
  })

  it('crearGrupo: una OP por contenedor, mismo grupo y remito, precio y plazo propios', async () => {
    const conts = await datos.crearContenedores(2)
    const r = await AlquileresModel.crearGrupo({
      ...comunes, cobro_modo: 'alquiler', en_curso: false,
      contenedores: [
        { id_contenedor: conts[0], plazo_alquiler: 4, precio_alquiler: 100 },
        { id_contenedor: conts[1], plazo_alquiler: 10, precio_alquiler: 150 },
      ],
    })
    assert.equal(r.ops.length, 2)
    assert.ok(r.ops[0].id < r.ops[1].id)
    assert.notEqual(r.ops[0].nro_op, r.ops[1].nro_op)
    const [a, b] = [await opDe(r.ops[0].id), await opDe(r.ops[1].id)]
    assert.deepEqual([a.id_grupo, b.id_grupo], [r.id_grupo, r.id_grupo])
    assert.deepEqual([a.nro_remito, b.nro_remito], [r.nro_remito, r.nro_remito])
    assert.deepEqual([a.estado, b.estado], ['pendiente', 'pendiente'])
    assert.deepEqual([a.mov, b.mov], ['pendiente_despacho', 'pendiente_despacho'])
    assert.deepEqual([a.plazo_alquiler, b.plazo_alquiler], [4, 10])
    assert.deepEqual([a.precio_alquiler, b.precio_alquiler], [100, 150])
    const g = (await prueba.q(`SELECT cobro_modo FROM alquiler_grupos WHERE id = ?`, [r.id_grupo])).rows[0]
    assert.equal(g.cobro_modo, 'alquiler')
  })

  it('crearGrupo ya en curso: todas las OP entregadas y en el domicilio', async () => {
    const conts = await datos.crearContenedores(2)
    const r = await AlquileresModel.crearGrupo({
      ...comunes, cobro_modo: 'contenedor', en_curso: true,
      contenedores: conts.map(id_contenedor => ({ id_contenedor, plazo_alquiler: 4, precio_alquiler: 100 })),
    })
    for (const op of r.ops) {
      const o = await opDe(op.id)
      assert.deepEqual([o.estado, o.mov], ['entregado', 'en_alquiler'])
    }
  })

  it('crearGrupo usa el remito cargado a mano en todas las OP', async () => {
    const conts = await datos.crearContenedores(2)
    const r = await AlquileresModel.crearGrupo({
      ...comunes, cobro_modo: 'contenedor', en_curso: false, nro_remito: 7777777,
      contenedores: conts.map(id_contenedor => ({ id_contenedor, plazo_alquiler: 4, precio_alquiler: 100 })),
    })
    assert.equal(r.nro_remito, 7777777)
    for (const op of r.ops) assert.equal((await opDe(op.id)).nro_remito, 7777777)
  })

  it('crearGrupo con un contenedor ocupado no crea nada y nombra el contenedor', async () => {
    const conts = await datos.crearContenedores(2)
    await AlquileresModel.crear({ ...comunes, id_contenedor: conts[1], plazo_alquiler: 4, precio_alquiler: 100 })
    const numero = (await prueba.q(`SELECT numero_contenedor FROM contenedores WHERE id = ?`, [conts[1]])).rows[0].numero_contenedor
    const opsAntes = await contar(`SELECT COUNT(*)::int n FROM op_encabezado WHERE id_cliente = ?`, [id_cliente])
    const gruposAntes = await contar(`SELECT COUNT(*)::int n FROM alquiler_grupos`)
    await assert.rejects(
      AlquileresModel.crearGrupo({
        ...comunes, cobro_modo: 'contenedor', en_curso: false,
        contenedores: conts.map(id_contenedor => ({ id_contenedor, plazo_alquiler: 4, precio_alquiler: 100 })),
      }),
      new RegExp(`N° ${numero} ya está alquilado`))
    assert.equal(await contar(`SELECT COUNT(*)::int n FROM op_encabezado WHERE id_cliente = ?`, [id_cliente]), opsAntes)
    assert.equal(await contar(`SELECT COUNT(*)::int n FROM alquiler_grupos`), gruposAntes)
  })

  it('crearGrupo rechaza contenedores repetidos y grupos de uno solo', async () => {
    const [cont] = await datos.crearContenedores(1)
    await assert.rejects(AlquileresModel.crearGrupo({ ...comunes, cobro_modo: 'contenedor',
      contenedores: [{ id_contenedor: cont, plazo_alquiler: 4, precio_alquiler: 100 }, { id_contenedor: cont, plazo_alquiler: 4, precio_alquiler: 100 }] }),
      /mismo contenedor más de una vez/)
    await assert.rejects(AlquileresModel.crearGrupo({ ...comunes, cobro_modo: 'contenedor',
      contenedores: [{ id_contenedor: cont, plazo_alquiler: 4, precio_alquiler: 100 }] }),
      /al menos dos contenedores/)
  })
})
```

- [ ] **Step 2: Correr la prueba y verificar que falla**

Run: `node --test --test-concurrency=1 tests/alquiler-grupos-alta.test.js`
Expected: las dos primeras pasan (comportamiento actual) y las de `crearGrupo` fallan con `AlquileresModel.crearGrupo is not a function`.

- [ ] **Step 3: `contenedorOcupado` acepta un cliente de transacción**

En `src/models/alquileres.model.js`, reemplazar la cabecera y el `query(` de `contenedorOcupado`:

```js
  // ¿El contenedor está ocupado? (último movimiento no 'disponible' O hay una op activa sin cerrar)
  async contenedorOcupado(id_contenedor) {
    if (!id_contenedor) return false
    const r = (await query(`
```

por:

```js
  // ¿El contenedor está ocupado? (último movimiento no 'disponible' O hay una op activa sin cerrar)
  // `q` permite hacer el chequeo dentro de la transacción del alta (crearGrupo).
  async contenedorOcupado(id_contenedor, q = query) {
    if (!id_contenedor) return false
    const r = (await q(`
```

- [ ] **Step 4: Agregar `_insertarAlquiler` y reescribir `crear` sobre él**

Reemplazar la función `crear` completa (desde `async crear({ id_cliente, id_administrativo, domicilio_entrega,` hasta su `},` final) por:

```js
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
        d.zona_entrega || '', normalizarPlazo(d.plazo_alquiler, 5), parseFloat(d.precio_alquiler) || 0, d.metodo_pago || null])
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
        ops.push({ ...r, id_contenedor: c.id_contenedor, precio_alquiler: parseFloat(c.precio_alquiler) || 0 })
      }
      return { id_grupo, nro_remito: nro_rem, ops }
    })
  },
```

- [ ] **Step 5: Reescribir `crearEnCurso` sobre `_insertarAlquiler`**

Reemplazar la función `crearEnCurso` completa (desde `async crearEnCurso({ id_cliente,` hasta su `},`; conservar el comentario que la precede) por:

```js
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
```

- [ ] **Step 6: Correr las pruebas y verificar que pasan**

Run: `node --test --test-concurrency=1 tests/alquiler-grupos-alta.test.js tests/alquiler-grupos-controlador.test.js`
Expected: `ℹ fail 0` (7 + 3).

Run: `node --check src/models/alquileres.model.js`
Expected: sin salida.

- [ ] **Step 7: Commit**

```bash
git add src/models/alquileres.model.js tests/alquiler-grupos-alta.test.js
git commit -m "Alquileres: alta agrupada en el modelo (crearGrupo) sobre un insert común

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Alta agrupada en el controlador y ubicación compartida

**Files:**
- Modify: `src/controllers/alquileres.controller.js` (`crear`)
- Modify: `src/models/alquileres.model.js` (`ubicar`; nuevo `copiarUbicacionAlGrupo`)
- Modify: `tests/alquiler-grupos-controlador.test.js`
- Modify: `tests/alquiler-grupos-alta.test.js`

**Interfaces:**
- Consumes: `crearGrupo` (Tarea 3), `calcularPlazoAlquiler`, `leerContenedoresDelForm` (Tarea 2).
- Produces: `copiarUbicacionAlGrupo(id_op): Promise<void>`. Formulario: `ids_contenedor[]` (2+), `precio_c[c<ID>]`, `fin_c[c<ID>]`, `cobro_modo`.

- [ ] **Step 1: Agregar las pruebas del alta agrupada al controlador**

En `tests/alquiler-grupos-controlador.test.js`, agregar dentro del `describe`, después de la última prueba:

```js
  it('varios contenedores: un grupo, precio y fin propios, cobro elegido', async () => {
    const id_cliente = await datos.crearCliente({ cuentaCorriente: true })
    const [c1, c2] = await datos.crearContenedores(2)
    const r = await llamar('crear', { user: admin, body: cuerpo({
      clienteId: String(id_cliente),
      ids_contenedor: [String(c1), String(c2)],
      precio_c: { ['c' + c2]: '150' },
      fin_c: { ['c' + c2]: sumarDiasHabiles(inicio, 7) },
      cobro_modo: 'alquiler',
    }) })
    assert.equal(r.url, '/alquileres/contenedores')
    assert.equal(r.flashes[0].tipo, 'success')
    assert.match(r.flashes[0].msg, /Alquiler de 2 contenedores creado: OP-\d{4}, OP-\d{4}\. Cobro por alquiler\./)
    const ops = await opsDe(id_cliente)
    assert.equal(ops.length, 2)
    assert.ok(ops[0].id_grupo)
    assert.equal(ops[0].id_grupo, ops[1].id_grupo)
    assert.deepEqual(ops.map(o => o.precio_alquiler), [100, 150])
    assert.deepEqual(ops.map(o => o.plazo_alquiler), [10, 7]) // cuenta corriente: 10 por defecto; el segundo, a mano
    const g = (await prueba.q(`SELECT cobro_modo FROM alquiler_grupos WHERE id = ?`, [ops[0].id_grupo])).rows[0]
    assert.equal(g.cobro_modo, 'alquiler')
  })

  it('varios contenedores con fecha de inicio pasada: se cargan como en curso', async () => {
    const id_cliente = await datos.crearCliente()
    const [c1, c2] = await datos.crearContenedores(2)
    const r = await llamar('crear', { user: admin, body: cuerpo({
      clienteId: String(id_cliente), fechaInicio: '2026-09-28', fechaFin: sumarDiasHabiles('2026-09-28', 4),
      ids_contenedor: [String(c1), String(c2)],
    }) })
    assert.match(r.flashes[0].msg, /cargado como en curso/)
    assert.deepEqual((await opsDe(id_cliente)).map(o => o.estado), ['entregado', 'entregado'])
  })

  it('varios contenedores en carga histórica: error, es de a uno', async () => {
    const id_cliente = await datos.crearCliente()
    const [c1, c2] = await datos.crearContenedores(2)
    const r = await llamar('crear', { user: admin, body: cuerpo({
      clienteId: String(id_cliente), finalizado: '1', ids_contenedor: [String(c1), String(c2)],
    }) })
    assert.equal(r.url, '/alquileres/contenedores/nuevo')
    assert.deepEqual(r.flashes, [{ tipo: 'error', msg: 'La carga histórica es de a un contenedor por alquiler.' }])
    assert.equal((await opsDe(id_cliente)).length, 0)
  })

  it('varios contenedores con un precio en cero: error y no se crea nada', async () => {
    const id_cliente = await datos.crearCliente()
    const [c1, c2] = await datos.crearContenedores(2)
    const r = await llamar('crear', { user: admin, body: cuerpo({
      clienteId: String(id_cliente), ids_contenedor: [String(c1), String(c2)], precio_c: { ['c' + c1]: '0' },
    }) })
    assert.deepEqual(r.flashes, [{ tipo: 'error', msg: 'Revisá el precio de cada contenedor: tiene que ser mayor a cero.' }])
    assert.equal((await opsDe(id_cliente)).length, 0)
  })
```

- [ ] **Step 2: Agregar la prueba de ubicación compartida al modelo**

En `tests/alquiler-grupos-alta.test.js`, agregar dentro del `describe`:

```js
  it('copiarUbicacionAlGrupo: copia las coordenadas a las OP del grupo con la misma dirección', async () => {
    const conts = await datos.crearContenedores(3)
    const r = await AlquileresModel.crearGrupo({
      ...comunes, cobro_modo: 'contenedor', en_curso: false,
      contenedores: conts.map(id_contenedor => ({ id_contenedor, plazo_alquiler: 4, precio_alquiler: 100 })),
    })
    const [op1, op2, op3] = r.ops.map(o => o.id)
    await prueba.q(`UPDATE op_detalle_contenedor SET domicilio_calle = 'Otra calle' WHERE id_orden_pedido = ?`, [op3])
    await AlquileresModel.guardarUbicacion(op1, { lat: -31.41, lng: -64.19, estado: 'ok', detalle: 'Prueba' })
    await AlquileresModel.copiarUbicacionAlGrupo(op1)
    const geo = async (id) => (await prueba.q(`SELECT domicilio_lat AS lat, geo_estado FROM op_detalle_contenedor WHERE id_orden_pedido = ?`, [id])).rows[0]
    assert.deepEqual(await geo(op2), { lat: -31.41, geo_estado: 'ok' })
    assert.deepEqual(await geo(op3), { lat: null, geo_estado: null })
  })
```

- [ ] **Step 3: Correr las pruebas y verificar que fallan**

Run: `node --test --test-concurrency=1 tests/alquiler-grupos-controlador.test.js tests/alquiler-grupos-alta.test.js`
Expected: FAIL en las 4 pruebas nuevas del controlador (crea una sola OP con `id_contenedor` vacío, o no muestra los errores esperados) y en `copiarUbicacionAlGrupo is not a function`.

- [ ] **Step 4: Rama de alta agrupada en `crear`**

En `src/controllers/alquileres.controller.js`, dentro de `crear`, insertar justo antes de `// ── Carga histórica: alquiler ya finalizado (ingreso + historial, sin contenedor) ──`:

```js
      // ── Varios contenedores: alquiler agrupado (una OP por contenedor) ──
      const seleccion = leerContenedoresDelForm(req.body)
      if (seleccion.error) {
        req.flash('error', seleccion.error)
        return res.redirect('/alquileres/contenedores/nuevo')
      }
      if (seleccion.contenedores.length >= 2) {
        if (esHistorico) {
          req.flash('error', 'La carga histórica es de a un contenedor por alquiler.')
          return res.redirect('/alquileres/contenedores/nuevo')
        }
        if (alquiler_actual_id) {
          req.flash('error', 'El próximo alquiler encadenado ("próximos a finalizar") es de a un contenedor.')
          return res.redirect('/alquileres/contenedores/nuevo')
        }
        // Cada contenedor puede traer precio y fecha de fin propios; vacíos = los generales.
        const contenedores = []
        for (const c of seleccion.contenedores) {
          const precio = c.precio !== '' ? parseFloat(c.precio) : precioAlquilerNum
          if (!(precio > 0)) {
            req.flash('error', 'Revisá el precio de cada contenedor: tiene que ser mayor a cero.')
            return res.redirect('/alquileres/contenedores/nuevo')
          }
          const rp = calcularPlazoAlquiler({
            fechaInicio, fechaFin: c.fin || fechaFin, sinFechaFin, esHistorico: false,
            fechaFinManual: fechaFinManual || !!c.fin, tieneCC,
          })
          if (rp.error) {
            req.flash('error', rp.error)
            return res.redirect('/alquileres/contenedores/nuevo')
          }
          contenedores.push({ id_contenedor: c.id_contenedor, precio_alquiler: precio, plazo_alquiler: rp.plazo })
        }
        const cobroModo = req.body.cobro_modo === 'alquiler' ? 'alquiler' : 'contenedor'
        const grupo = await AlquileresModel.crearGrupo({
          cobro_modo: cobroModo, en_curso: esEnCurso, contenedores, nro_remito: remitoLeido.nro,
          id_cliente: clienteIdClean, id_administrativo: req.session.user.id,
          domicilio_entrega, domicilio_calle: calle, domicilio_numero: numero, zona_entrega,
          metodo_pago: metodoPago, observaciones, obra, fecha_inicio: fechaInicio || null,
          id_chofer: id_chofer || null, id_camion: id_camion || null,
        })
        const FacturacionModel = require('../models/facturacion.model')
        for (const op of grupo.ops) await FacturacionModel.marcarAlCrear(op.id, req.body.paraFacturar, op.precio_alquiler)
        // Se geocodifica una sola vez; ubicar copia las coordenadas al resto del grupo.
        ubicarEnSegundoPlano(grupo.ops[0].id)
        const nros = grupo.ops.map(o => 'OP-' + String(o.nro_op).padStart(4, '0')).join(', ')
        req.flash('success', `Alquiler de ${grupo.ops.length} contenedores ${esEnCurso ? 'cargado como en curso' : 'creado'}: ${nros}. Cobro por ${cobroModo}.`)
        return res.redirect('/alquileres/contenedores')
      }

```

- [ ] **Step 5: Ubicación compartida en el modelo**

En `src/models/alquileres.model.js`, agregar después de `guardarUbicacion` (antes del comentario de `ubicar`):

```js
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
```

En `ubicar`, reemplazar:

```js
    await this.guardarUbicacion(id_op, geo)
    return geo
```

por:

```js
    await this.guardarUbicacion(id_op, geo)
    await this.copiarUbicacionAlGrupo(id_op)
    return geo
```

- [ ] **Step 6: Correr las pruebas y verificar que pasan**

Run: `node --test --test-concurrency=1 tests/alquiler-grupos-controlador.test.js tests/alquiler-grupos-alta.test.js`
Expected: `ℹ fail 0` (7 + 8).

- [ ] **Step 7: Commit**

```bash
git add src/controllers/alquileres.controller.js src/models/alquileres.model.js tests/alquiler-grupos-controlador.test.js tests/alquiler-grupos-alta.test.js
git commit -m "Alquileres: alta de varios contenedores en el controlador y ubicación compartida del grupo

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Pantalla de alta con selección múltiple

**Files:**
- Modify: `views/pages/alquileres/nuevo.ejs`
- Modify: `public/js/alquilerService.js`
- Modify: `src/scss/pages/_alquileres.scss`
- Create: `tests/helpers/vistas.js`
- Create: `tests/alquiler-grupos-vistas.test.js`

**Interfaces:**
- Consumes: el formulario que espera el controlador (Tarea 4): `ids_contenedor[]`, `precio_c[c<ID>]`, `fin_c[c<ID>]`, `cobro_modo`.
- Produces: `tests/helpers/vistas.js` → `renderVista(rutaRelativaSinExtension, locals): Promise<string>`.

- [ ] **Step 1: Crear `tests/helpers/vistas.js`**

```js
'use strict'
// Renderiza vistas y parciales EJS con los mismos helpers que pone src/app.js en res.locals.
const path = require('path')
const ejs = require('ejs')
const { icon } = require('../../src/config/icons')
const { fmtFecha, fmtFechaHora, hoyISO } = require('../../src/utils/fecha')
const { sumarDiasHabiles } = require('../../src/utils/diasHabiles')

const VISTAS = path.join(__dirname, '..', '..', 'views')

function renderVista(relativa, locals = {}) {
  return ejs.renderFile(path.join(VISTAS, relativa + '.ejs'), {
    icon, formatFecha: fmtFecha, formatFechaHora: fmtFechaHora, hoyISO, sumarDiasHabiles,
    user: { rol: 'dueno', nombre: 'Prueba' }, success: [], error: [], warning: [],
    ...locals,
  })
}

module.exports = { renderVista }
```

- [ ] **Step 2: Escribir `tests/alquiler-grupos-vistas.test.js`**

```js
'use strict'
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { renderVista } = require('./helpers/vistas')

describe('vistas de alquileres agrupados', () => {
  it('nuevo: barra de selección múltiple y bloque de varios contenedores con selector de cobro', async () => {
    const html = await renderVista('pages/alquileres/nuevo', {
      disponibles: [{ id: 3, numero_contenedor: 19 }, { id: 5, numero_contenedor: 20 }],
      porLiberar: [], choferesDisp: [], camionesDisp: [], zonas: [],
      configPlazos: { cuenta_corriente: 10, estandar: 4 },
    })
    assert.match(html, /id="barraSeleccion"/)
    assert.match(html, /id="btnContinuarSeleccion"/)
    assert.match(html, /id="bloqueVariosContenedores"/)
    assert.match(html, /id="inputsContenedores"/)
    assert.match(html, /name="cobro_modo" value="contenedor" checked/)
    assert.match(html, /name="cobro_modo" value="alquiler"/)
    assert.match(html, /id="rowCheckFinalizado"/)
  })
})
```

- [ ] **Step 3: Correr la prueba y verificar que falla**

Run: `node --test --test-concurrency=1 tests/alquiler-grupos-vistas.test.js`
Expected: FAIL en `id="barraSeleccion"`.

- [ ] **Step 4: Modificar `views/pages/alquileres/nuevo.ejs`**

4a. Reemplazar el título y la ayuda del paso 1:

```ejs
  <h3 class="form-section__title">Seleccioná un contenedor</h3>
```

por:

```ejs
  <h3 class="form-section__title">Seleccioná uno o varios contenedores</h3>
```

y agregar al final del párrafo `form-hint` que explica "Próximos a finalizar" (antes de `</p>`):

```ejs
    En <strong>Disponibles</strong> podés elegir varios contenedores para un mismo alquiler y seguir con <strong>Continuar</strong>.
```

4b. Después del cierre de `<div id="listaDisponibles" ...>` (su `</div>`) y antes de `<div id="listaPorFinalizar"`, agregar:

```ejs
  <div id="barraSeleccion" class="seleccion-bar" style="display:none">
    <span id="seleccionTexto"></span>
    <button type="button" id="btnLimpiarSeleccion" class="btn-secondary btn-sm">Limpiar</button>
    <button type="button" id="btnContinuarSeleccion" class="btn-primary btn-sm">Continuar</button>
  </div>
```

4c. En el formulario, debajo de `<input type="hidden" name="lng" id="inputLng">`, agregar:

```ejs
      <div id="inputsContenedores"></div>
```

4d. Reemplazar:

```ejs
      <label class="toggle-row" style="margin-bottom:0.4rem">
        <input type="checkbox" id="checkFinalizado" name="finalizado" value="1">
```

por:

```ejs
      <label class="toggle-row" id="rowCheckFinalizado" style="margin-bottom:0.4rem">
        <input type="checkbox" id="checkFinalizado" name="finalizado" value="1">
```

4e. Después del cierre de la sección "Precio" (el `</div>` que cierra `<div class="form-section">` con `id="precioAlquilerInput"`) y antes de `<%- include('../../partials/metodo_pago', { conAConvenir: true }) %>`, agregar:

```ejs
      <!-- Varios contenedores (solo con 2 o más elegidos) -->
      <div class="form-section" id="bloqueVariosContenedores" style="display:none">
        <h3 class="form-section__title">Contenedores del alquiler</h3>
        <p class="form-hint">
          Cada contenedor se entrega, vence y se retira por su cuenta. Precio y fecha de fin vacíos
          toman los generales de arriba.
        </p>
        <div id="listaVariosContenedores" class="multi-cont-lista"></div>
        <div class="form-group" style="margin-top:0.75rem">
          <label>¿Cómo se cobra?</label>
          <label class="toggle-row">
            <input type="radio" name="cobro_modo" value="contenedor" checked>
            <span>Por contenedor — cada uno se cobra al retirarlo</span>
          </label>
          <label class="toggle-row">
            <input type="radio" name="cobro_modo" value="alquiler">
            <span>Por alquiler — todo junto al retirar el último</span>
          </label>
        </div>
      </div>
```

- [ ] **Step 5: Modificar `public/js/alquilerService.js`**

5a. Reemplazar:

```js
let contenedorSeleccionado = null; // { id, numero, fin, alquilerActualId }
```

por:

```js
let contenedorSeleccionado = null; // { id, numero, fin, alquilerActualId }
// Alquiler con varios contenedores: los elegidos en "Disponibles", en orden de selección.
let seleccionMultiple = []; // [{ id, numero }]
function esMultiple() { return seleccionMultiple.length >= 2; }
```

5b. En `actualizarResumen`, reemplazar:

```js
        elCont.textContent = textoHist || (contenedorSeleccionado ? `#${contenedorSeleccionado.numero}` : '—');
```

por:

```js
        elCont.textContent = textoHist
            || (esMultiple() ? seleccionMultiple.map(c => `#${c.numero}`).join(', ')
                : (contenedorSeleccionado ? `#${contenedorSeleccionado.numero}` : '—'));
```

y reemplazar:

```js
    const precio = Number(precioInput?.value) || 0;
```

por:

```js
    // Con varios contenedores, el total es la suma de cada uno (vacío = el precio general).
    const precioGeneral = Number(precioInput?.value) || 0;
    const precio = esMultiple()
        ? Array.from(document.querySelectorAll('.multi-cont-precio'))
            .reduce((suma, inp) => suma + (Number(inp.value) || precioGeneral), 0)
        : precioGeneral;
```

5c. Reemplazar el bloque completo `// ── Selección de contenedor → abre el modal ───────────────────` (desde ese comentario hasta el `});` que cierra el `forEach` de `.btn-seleccionar-cont`) por:

```js
// ── Selección de contenedores ─────────────────────────────────
// En "Disponibles" se pueden elegir varios contenedores para un mismo alquiler (se sigue
// con "Continuar"). En "Próximos a finalizar" es de a uno y abre el modal directo: el
// próximo alquiler encadenado es de a un contenedor.
const barraSeleccion = document.getElementById('barraSeleccion');
const seleccionTexto = document.getElementById('seleccionTexto');
const bloqueVarios   = document.getElementById('bloqueVariosContenedores');
const listaVarios    = document.getElementById('listaVariosContenedores');
const inputsConts    = document.getElementById('inputsContenedores');
const rowCheckFinal  = document.getElementById('rowCheckFinalizado');

function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function actualizarBarraSeleccion() {
    const n = seleccionMultiple.length;
    if (barraSeleccion) barraSeleccion.style.display = n ? 'flex' : 'none';
    if (seleccionTexto) {
        const nums = seleccionMultiple.map(c => `#${c.numero}`).join(', ');
        seleccionTexto.textContent = n === 1 ? `1 contenedor elegido (${nums})` : `${n} contenedores elegidos (${nums})`;
    }
    document.querySelectorAll('#listaDisponibles .alquiler-card').forEach(card => {
        const elegido = seleccionMultiple.some(c => c.id === card.dataset.id);
        card.classList.toggle('alquiler-card--selected', elegido);
        const btn = card.querySelector('.btn-seleccionar-cont');
        if (btn) btn.textContent = elegido ? 'Quitar' : 'Seleccionar';
    });
}

// Con 2 o más contenedores: una fila por contenedor (precio y fin propios, opcionales) y
// los hidden ids_contenedor[]. Con 0 o 1, el bloque queda oculto y vacío. Las claves
// llevan "c" adelante (precio_c[c<ID>]): con claves numéricas el servidor perdería a qué
// contenedor corresponde cada valor.
function armarBloqueVarios() {
    if (inputsConts) inputsConts.innerHTML = '';
    if (listaVarios) listaVarios.innerHTML = '';
    if (bloqueVarios) bloqueVarios.style.display = esMultiple() ? '' : 'none';
    if (rowCheckFinal) rowCheckFinal.style.display = esMultiple() ? 'none' : '';
    if (!esMultiple()) return;
    seleccionMultiple.forEach(c => {
        const id = escHtml(c.id);
        inputsConts?.insertAdjacentHTML('beforeend', `<input type="hidden" name="ids_contenedor[]" value="${id}">`);
        listaVarios?.insertAdjacentHTML('beforeend', `
            <div class="multi-cont-fila">
                <span class="multi-cont-fila__num">#${escHtml(c.numero)}</span>
                <label>Precio ($)
                    <input type="number" name="precio_c[c${id}]" class="input-sm multi-cont-precio" min="0.01" step="any" placeholder="El general">
                </label>
                <label>Fin
                    <input type="date" name="fin_c[c${id}]" class="input-sm multi-cont-fin">
                </label>
            </div>`);
    });
    listaVarios?.querySelectorAll('input').forEach(inp => {
        inp.addEventListener('input', actualizarResumen);
        inp.addEventListener('change', actualizarResumen);
    });
}

function limpiarSeleccionMultiple() {
    seleccionMultiple = [];
    actualizarBarraSeleccion();
    armarBloqueVarios();
}

// Un solo contenedor: carga los hidden y abre el modal (igual que siempre).
function abrirConUnContenedor(card) {
    document.querySelectorAll('.alquiler-card').forEach(c => c.classList.remove('alquiler-card--selected'));
    card.classList.add('alquiler-card--selected');

    contenedorSeleccionado = {
        id:               card.dataset.id,
        numero:           card.dataset.numero,
        fin:              card.dataset.fin || null,
        alquilerActualId: card.dataset.alquilerActual || '',
    };

    const inputId  = document.getElementById('inputContenedorId');
    const inputAct = document.getElementById('inputAlquilerActualId');
    if (inputId)  inputId.value  = contenedorSeleccionado.id;
    if (inputAct) inputAct.value = contenedorSeleccionado.alquilerActualId;

    const labelModal = document.getElementById('modal-cont-label');
    if (labelModal) labelModal.textContent = `Contenedor #${contenedorSeleccionado.numero}`;

    // si es "por finalizar", el alquiler nuevo arranca después de la liberación
    if (contenedorSeleccionado.fin && fechaInicio) {
        fechaInicio.min   = contenedorSeleccionado.fin;
        fechaInicio.value = '';
    }
    aplicarFechaFinAutomatica();
    armarBloqueVarios();
    abrirModalAlquiler();
    actualizarResumen();
}

// Varios contenedores: sin contenedor único ni encadenado; los ids van en las filas.
function abrirConVariosContenedores() {
    contenedorSeleccionado = null;
    const inputId  = document.getElementById('inputContenedorId');
    const inputAct = document.getElementById('inputAlquilerActualId');
    if (inputId)  inputId.value  = '';
    if (inputAct) inputAct.value = '';
    if (fechaInicio) fechaInicio.min = '';
    const labelModal = document.getElementById('modal-cont-label');
    if (labelModal) labelModal.textContent = `${seleccionMultiple.length} contenedores (${seleccionMultiple.map(c => '#' + c.numero).join(', ')})`;
    // La carga histórica es de a un contenedor
    if (checkFinalizado?.checked) { checkFinalizado.checked = false; aplicarModoFinalizado(false); }
    aplicarFechaFinAutomatica();
    armarBloqueVarios();
    abrirModalAlquiler();
    actualizarResumen();
}

document.querySelectorAll('#listaDisponibles .btn-seleccionar-cont').forEach(btn => {
    btn.addEventListener('click', () => {
        const card = btn.closest('.alquiler-card');
        if (!card) return;
        const i = seleccionMultiple.findIndex(c => c.id === card.dataset.id);
        if (i >= 0) seleccionMultiple.splice(i, 1);
        else seleccionMultiple.push({ id: card.dataset.id, numero: card.dataset.numero });
        actualizarBarraSeleccion();
    });
});

document.querySelectorAll('#listaPorFinalizar .btn-seleccionar-cont').forEach(btn => {
    btn.addEventListener('click', () => {
        const card = btn.closest('.alquiler-card');
        if (!card) return;
        limpiarSeleccionMultiple();
        abrirConUnContenedor(card);
    });
});

document.getElementById('btnLimpiarSeleccion')?.addEventListener('click', limpiarSeleccionMultiple);
document.getElementById('btnContinuarSeleccion')?.addEventListener('click', () => {
    if (esMultiple()) { abrirConVariosContenedores(); return; }
    if (seleccionMultiple.length === 1) {
        const card = Array.from(document.querySelectorAll('#listaDisponibles .alquiler-card'))
            .find(c => c.dataset.id === seleccionMultiple[0].id);
        if (card) abrirConUnContenedor(card);
    }
});
```

5d. En el handler de las pestañas, reemplazar:

```js
        document.querySelectorAll('.alquiler-card').forEach(c => c.classList.remove('alquiler-card--selected'));
        contenedorSeleccionado = null;
    });
});
```

por:

```js
        document.querySelectorAll('.alquiler-card').forEach(c => c.classList.remove('alquiler-card--selected'));
        contenedorSeleccionado = null;
        limpiarSeleccionMultiple();
    });
});
```

5e. En el handler de `btnCargarFinalizado`, reemplazar:

```js
document.getElementById('btnCargarFinalizado')?.addEventListener('click', () => {
    contenedorSeleccionado = null;
```

por:

```js
document.getElementById('btnCargarFinalizado')?.addEventListener('click', () => {
    limpiarSeleccionMultiple();
    contenedorSeleccionado = null;
```

5f. En la validación al enviar, reemplazar:

```js
    } else if (!modoFinalizado() && !contenedorSeleccionado) {
```

por:

```js
    } else if (!modoFinalizado() && !contenedorSeleccionado && !esMultiple()) {
```

- [ ] **Step 6: Estilos en `src/scss/pages/_alquileres.scss`**

Agregar después del bloque `.alquiler-card { ... }` (después de su `}` de cierre):

```scss
// Selección múltiple en "Nuevo alquiler": barra con los elegidos + filas por contenedor
.seleccion-bar {
  position: sticky;
  bottom: 0.75rem;
  z-index: 5;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 1rem;
  padding: 0.6rem 0.9rem;
  background: #fff;
  border: 1px solid $accent;
  border-radius: $radius-md;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.08);

  #seleccionTexto { font-weight: 600; margin-right: auto; }
}

.multi-cont-lista { display: flex; flex-direction: column; gap: 0.4rem; }

.multi-cont-fila {
  display: flex;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: 0.6rem;
  padding: 0.45rem 0.6rem;
  border: 1px solid $border;
  border-radius: $radius-md;

  &__num { font-weight: 700; min-width: 3.5rem; align-self: center; }

  label { display: flex; flex-direction: column; gap: 0.15rem; font-size: 0.8rem; }
}
```

- [ ] **Step 7: Verificar**

Run: `node --test --test-concurrency=1 tests/alquiler-grupos-vistas.test.js`
Expected: `ℹ pass 1`.

Run: `node --check public/js/alquilerService.js && npm run build`
Expected: sin errores de sintaxis; `sass` compila sin errores.

Verificación manual (la hace el usuario, o se deja para después de la Tarea 11): en Nuevo alquiler, elegir dos contenedores → aparece la barra "2 contenedores elegidos (#N, #M)" → "Continuar" → el modal muestra "2 contenedores (…)", las filas con precio/fin y el selector de cobro, sin el check de histórico; "Limpiar" vacía la selección; en "Próximos a finalizar" el clic abre el modal de un solo contenedor como siempre.

- [ ] **Step 8: Commit**

```bash
git add views/pages/alquileres/nuevo.ejs public/js/alquilerService.js src/scss/pages/_alquileres.scss tests/helpers/vistas.js tests/alquiler-grupos-vistas.test.js
git commit -m "Nuevo alquiler: selección de varios contenedores con precio/fin propios y selector de cobro

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: El grupo en listados y en el detalle

**Files:**
- Modify: `src/models/alquileres.model.js` (constante `SQL_OP_ABIERTA`; `grupoDe`; `obtener`; `listarPorEstado`)
- Create: `views/partials/alquiler_grupo.ejs`
- Modify: `views/pages/alquileres/detalle.ejs`
- Modify: `views/pages/alquileres/index.ejs`
- Modify: `tests/alquiler-grupos-alta.test.js`
- Modify: `tests/alquiler-grupos-vistas.test.js`

**Interfaces:**
- Consumes: `crearGrupo` (Tarea 3).
- Produces:
  - Constante `SQL_OP_ABIERTA` (usa alias `op`, `oc` y `um` = último movimiento del contenedor).
  - `grupoDe(id_op) → Promise<null | { id, cobro_modo, abiertas: number, ops: [{ id, nro_op, estado, id_contenedor, numero_contenedor, contenedor_estado, dias_restantes, abierta: boolean, cobrada: boolean }] }>` (ops por id).
  - `obtener(id)` agrega `grupo` (resultado de `grupoDe` o `null`).
  - `listarPorEstado` agrega por fila `id_grupo` y `grupo_cant` (OP no anuladas del grupo).
  - Parcial `partials/alquiler_grupo` con locals `{ grupo, opActualId }`.

- [ ] **Step 1: Pruebas del modelo**

En `tests/alquiler-grupos-alta.test.js`, agregar dentro del `describe`:

```js
  it('grupoDe: OP del grupo con abierta/cobrada; obtener y listarPorEstado lo reflejan', async () => {
    const conts = await datos.crearContenedores(2)
    const r = await AlquileresModel.crearGrupo({
      ...comunes, cobro_modo: 'alquiler', en_curso: true,
      contenedores: conts.map(id_contenedor => ({ id_contenedor, plazo_alquiler: 4, precio_alquiler: 100 })),
    })
    const [op1, op2] = r.ops.map(o => o.id)
    let g = await AlquileresModel.grupoDe(op1)
    assert.equal(g.id, r.id_grupo)
    assert.equal(g.cobro_modo, 'alquiler')
    assert.deepEqual(g.ops.map(o => o.id), [op1, op2])
    assert.deepEqual(g.ops.map(o => [o.abierta, o.cobrada, o.contenedor_estado]), [[true, false, 'en_alquiler'], [true, false, 'en_alquiler']])
    assert.equal(g.abiertas, 2)

    await AlquileresModel.devolverAPlanta(op1)
    g = await AlquileresModel.grupoDe(op2)
    assert.deepEqual(g.ops.map(o => o.abierta), [false, true])
    assert.equal(g.abiertas, 1)

    assert.equal((await AlquileresModel.obtener(op2)).grupo.id, r.id_grupo)
    const [suelto] = await datos.crearContenedores(1)
    const s = await AlquileresModel.crearEnCurso({ ...comunes, id_contenedor: suelto, plazo_alquiler: 4, precio_alquiler: 100 })
    assert.equal((await AlquileresModel.obtener(s.id)).grupo, null)

    const { actuales, porFinalizar } = await AlquileresModel.listarPorEstado({})
    const filas = [...actuales, ...porFinalizar]
    const fila2 = filas.find(f => f.id === op2)
    const filaSuelta = filas.find(f => f.id === s.id)
    assert.deepEqual([fila2.id_grupo, fila2.grupo_cant], [r.id_grupo, 2])
    assert.deepEqual([filaSuelta.id_grupo, filaSuelta.grupo_cant], [null, 0])
  })
```

- [ ] **Step 2: Pruebas de vistas**

En `tests/alquiler-grupos-vistas.test.js`, agregar dentro del `describe`:

```js
  const grupoEjemplo = {
    id: 9, cobro_modo: 'alquiler', abiertas: 1,
    ops: [
      { id: 101, nro_op: 261, estado: 'entregado', id_contenedor: 1, numero_contenedor: 19, contenedor_estado: 'en_alquiler', dias_restantes: 3, abierta: true, cobrada: false },
      { id: 102, nro_op: 262, estado: 'entregado', id_contenedor: 2, numero_contenedor: 20, contenedor_estado: null, dias_restantes: null, abierta: false, cobrada: false },
    ],
  }

  it('panel del grupo: OP, contenedores, estados y aviso de cobro por alquiler', async () => {
    const html = await renderVista('partials/alquiler_grupo', { grupo: grupoEjemplo, opActualId: 101 })
    assert.match(html, /Alquiler agrupado — 2 contenedores · cobro por alquiler/)
    assert.match(html, /OP-0261/)
    assert.match(html, /OP-0262/)
    assert.match(html, /En el domicilio/)
    assert.match(html, /Retirado/)
    assert.match(html, /\(esta\)/)
    assert.match(html, /Faltan retirar 1\./)
  })

  it('listado: insignia de grupo solo en los alquileres agrupados', async () => {
    const fila = (extra) => ({
      id: 101, nro_op: 261, nro_remito: 5, cliente_nombre: 'Cliente', numero_contenedor: 19,
      domicilio_entrega: 'San Lorenzo 501', obra: null, plazo_alquiler: 4, fecha_entrega_real: '2026-09-28',
      fecha_entrega_planificada: '2026-09-28', fecha_fin_estimada: '2026-10-08', dias_restantes: 6,
      estado: 'entregado', contenedor_estado: 'en_alquiler', id_grupo: null, grupo_cant: 0, ...extra,
    })
    const html = await renderVista('pages/alquileres/index', {
      grupos: { porFinalizar: [], programados: [], actuales: [fila({ id_grupo: 9, grupo_cant: 2 }), fila({ id: 102, nro_op: 262 })] },
      filtros: { q: '' },
    })
    assert.equal((html.match(/Grupo · 2 contenedores/g) || []).length, 1)
    assert.match(html, /href="\/alquileres\/contenedores\/101#grupo"/)
  })
```

- [ ] **Step 3: Correr las pruebas y verificar que fallan**

Run: `node --test --test-concurrency=1 tests/alquiler-grupos-alta.test.js tests/alquiler-grupos-vistas.test.js`
Expected: FAIL (`grupoDe is not a function`; no existe el parcial `alquiler_grupo`; no aparece la insignia).

- [ ] **Step 4: `SQL_OP_ABIERTA` y `grupoDe` en el modelo**

En `src/models/alquileres.model.js`, agregar después de la definición de `SQL_MOV_ALQUILER_OP`:

```js
// Una OP de un alquiler agrupado está ABIERTA mientras no terminó su ciclo: todavía sin
// contenedor (no se entregó), o su contenedor sigue con un movimiento de ESTA OP que no
// es 'disponible'. Si el contenedor volvió a planta, o pasó directo al próximo alquiler
// encadenado (su último movimiento es de otra OP), la OP está cerrada. Un contenedor
// repuesto ("Reponer") cuenta por la unidad nueva. Las anuladas nunca están abiertas.
// Alias: op = op_encabezado, oc = op_detalle_contenedor, um = último movimiento del
// contenedor (SQL_ULTIMO_MOV unido por id_contenedor).
const SQL_OP_ABIERTA = `(op.estado <> 'anulado' AND (oc.id_contenedor IS NULL
  OR (um.id_op_contenedor = oc.id AND um.estado_paso <> 'disponible')))`
```

Agregar como método, después de `obtener`:

```js
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
```

En `obtener`, reemplazar el final:

```js
      op.fechaFinAlquiler = null; op.diasRestantes = null
    }
    return op
  },
```

por:

```js
      op.fechaFinAlquiler = null; op.diasRestantes = null
    }
    op.grupo = op.id_grupo ? await this.grupoDe(op.id) : null
    return op
  },
```

En `listarPorEstado`, dentro de `baseSelect`, reemplazar:

```js
      SELECT op.id, op.nro_op, op.nro_remito, op.estado, op.fecha_emision, op.fecha_entrega_planificada, op.obra,
```

por:

```js
      SELECT op.id, op.nro_op, op.nro_remito, op.estado, op.fecha_emision, op.fecha_entrega_planificada, op.obra,
             op.id_grupo,
             (SELECT COUNT(*) FROM op_encabezado g WHERE g.id_grupo = op.id_grupo AND g.estado <> 'anulado')::int AS grupo_cant,
```

- [ ] **Step 5: Crear `views/partials/alquiler_grupo.ejs`**

```ejs
<%#
  Panel "Alquiler agrupado" del detalle de una OP.
  Locals: grupo (AlquileresModel.grupoDe) y opActualId (la OP que se está viendo).
%>
<%
  const ETIQUETA = { pendiente_despacho: 'Pendiente', despachado: 'En camino', en_alquiler: 'En el domicilio', pendiente_retiro: 'Para retirar' }
  const estadoDe = (o) => o.estado === 'anulado' ? 'Anulado'
    : !o.abierta ? 'Retirado'
    : !o.id_contenedor ? 'Sin contenedor'
    : (ETIQUETA[o.contenedor_estado] || o.contenedor_estado || '—')
  const activas = grupo.ops.filter(o => o.estado !== 'anulado').length
%>
<div class="card shadow-sm mb-3" id="grupo">
  <div class="card-header-orange px-3 py-2">🧩 Alquiler agrupado — <%= activas %> contenedor<%= activas === 1 ? '' : 'es' %> · cobro por <%= grupo.cobro_modo %></div>
  <div class="card-body p-0">
    <table class="table-modern mb-0">
      <thead>
        <tr>
          <th>OP</th>
          <th class="text-center">Contenedor</th>
          <th class="text-center">Estado</th>
          <th class="text-center">Días restantes</th>
          <th class="text-center">Cobro</th>
        </tr>
      </thead>
      <tbody>
        <% grupo.ops.forEach(o => { const esta = Number(o.id) === Number(opActualId) %>
          <tr<%- esta ? ' class="fw-semibold"' : '' %>>
            <td>
              <a href="/alquileres/contenedores/<%= o.id %>" class="text-decoration-none text-orange">OP-<%= String(o.nro_op).padStart(4, '0') %></a>
              <%= esta ? '(esta)' : '' %>
            </td>
            <td class="text-center"><%= o.numero_contenedor ? 'N° ' + o.numero_contenedor : '—' %></td>
            <td class="text-center"><%= estadoDe(o) %></td>
            <td class="text-center"><%= o.abierta && o.dias_restantes != null ? o.dias_restantes + 'd' : '—' %></td>
            <td class="text-center"><%= o.cobrada ? 'Cobrado' : (o.estado === 'anulado' ? '—' : 'Pendiente') %></td>
          </tr>
        <% }) %>
      </tbody>
    </table>
    <% if (grupo.cobro_modo === 'alquiler') { %>
      <p class="form-hint px-3 py-2 mb-0">
        Cobro por alquiler: se cobra todo junto al retirar el último contenedor.<%= grupo.abiertas ? ` Faltan retirar ${grupo.abiertas}.` : '' %>
      </p>
    <% } %>
  </div>
</div>
```

- [ ] **Step 6: Incluir el panel en `detalle.ejs`**

En `views/pages/alquileres/detalle.ejs`, reemplazar:

```ejs
<!-- Timeline de movimientos -->
```

por:

```ejs
<% if (alquiler.grupo) { %>
  <%- include('../../partials/alquiler_grupo', { grupo: alquiler.grupo, opActualId: alquiler.id }) %>
<% } %>

<!-- Timeline de movimientos -->
```

- [ ] **Step 7: Insignia en `index.ejs`**

En `views/pages/alquileres/index.ejs`, dentro del bloque `<% ... %>` del principio, agregar antes de `// Tarjetas para "Por finalizar"`:

```js
  // Insignia de alquiler agrupado (varios contenedores): lleva al panel del grupo en el detalle.
  function insigniaGrupo(a) {
    if (!a.id_grupo) return ''
    return `<a href="/alquileres/contenedores/${a.id}#grupo" class="badge rounded-pill px-2 badge-en-transito text-decoration-none ms-1" title="Alquiler con varios contenedores">Grupo · ${a.grupo_cant} contenedores</a>`
  }

```

En `cardsFinalizar`, reemplazar:

```js
        <div class="finalizar-card__cliente">${a.cliente_nombre}</div>
```

por:

```js
        <div class="finalizar-card__cliente">${a.cliente_nombre}</div>
        ${a.id_grupo ? `<div class="mb-1">${insigniaGrupo(a)}</div>` : ''}
```

En `tabla`, reemplazar:

```js
              <a href="/alquileres/contenedores/${a.id}" class="text-decoration-none text-orange">OP-${String(a.nro_op).padStart(4,'0')}</a>
```

por:

```js
              <a href="/alquileres/contenedores/${a.id}" class="text-decoration-none text-orange">OP-${String(a.nro_op).padStart(4,'0')}</a>${insigniaGrupo(a)}
```

- [ ] **Step 8: Correr las pruebas y verificar que pasan**

Run: `node --test --test-concurrency=1 tests/alquiler-grupos-alta.test.js tests/alquiler-grupos-vistas.test.js`
Expected: `ℹ fail 0` (9 + 3).

Run: `node -e "const ejs=require('ejs'),fs=require('fs');for(const f of ['views/pages/alquileres/detalle.ejs','views/pages/alquileres/index.ejs','views/partials/alquiler_grupo.ejs'])ejs.compile(fs.readFileSync(f,'utf8'),{filename:f});console.log('ok')"`
Expected: `ok`.

- [ ] **Step 9: Commit**

```bash
git add src/models/alquileres.model.js views/partials/alquiler_grupo.ejs views/pages/alquileres/detalle.ejs views/pages/alquileres/index.ejs tests/alquiler-grupos-alta.test.js tests/alquiler-grupos-vistas.test.js
git commit -m "Alquileres agrupados: panel del grupo en el detalle e insignia en el listado

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

# Fase 2 — Cobro

### Task 7: Cobro del grupo en el modelo

**Files:**
- Modify: `src/models/transacciones.model.js` (`crear`)
- Modify: `src/models/clientes.model.js` (`agregarMovimiento`)
- Modify: `src/models/alquileres.model.js` (`grupoConCobroPorAlquiler`, `cobrarGrupo`, `cobrarAlCerrar`)
- Create: `tests/alquiler-grupos-cobro.test.js`

**Interfaces:**
- Consumes: `crearGrupo` (Tarea 3), `SQL_OP_ABIERTA` (Tarea 6), `datosCierre(id_op)` (existente), `crearProgramado`, `iniciarProximoAlquiler`, `reponerContenedor`, `registrarRetiro`, `entregar`, `anular`, `devolverAPlanta` (existentes).
- Produces:
  - `TransaccionesModel.crear(datos, q = query)` y `ClientesModel.agregarMovimiento(id, datos, q = query)` (mismo resultado que hoy sin `q`).
  - `grupoConCobroPorAlquiler(id_op) → Promise<{ id } | null>`
  - `cobrarGrupo(id_grupo, { montos = {}, metodoPagoFinal = null }) → Promise<number | null>` (total cobrado; null si falta retirar alguno, si es "a convenir" sin método, o si ya estaba cobrado).
  - `cobrarAlCerrar(id_op, montoManual, metodoPagoFinal)`: en OP de grupo con cobro por alquiler delega en `cobrarGrupo`; `montoManual` puede ser `{ [id_op]: monto }`.

- [ ] **Step 1: Escribir `tests/alquiler-grupos-cobro.test.js`**

```js
'use strict'
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const AlquileresModel = require('../src/models/alquileres.model')

describe('cobro de alquileres agrupados', () => {
  let admin

  before(async () => {
    await prueba.abrir()
    admin = await datos.idAdministrativo()
  })
  after(prueba.cerrar)

  // Grupo ya en curso (contenedores en el domicilio), listo para retirar.
  async function grupoEnCurso({ cobro_modo, metodo_pago = 'efectivo', cuentaCorriente = false, en_curso = true }) {
    const id_cliente = await datos.crearCliente({ cuentaCorriente })
    const conts = await datos.crearContenedores(2)
    const g = await AlquileresModel.crearGrupo({
      ...datos.datosComunes({ id_cliente, id_administrativo: admin, metodo_pago, fecha_inicio: '2026-09-28' }),
      cobro_modo, en_curso,
      contenedores: conts.map(id_contenedor => ({ id_contenedor, plazo_alquiler: 4, precio_alquiler: 100 })),
    })
    return { id_cliente, conts, id_grupo: g.id_grupo, ops: g.ops.map(o => o.id) }
  }
  const retirar = (id) => AlquileresModel.devolverAPlanta(id)
  const txDe = async (id) => (await prueba.q(`SELECT monto, metodo_pago FROM transacciones WHERE id_op_encabezado = ? ORDER BY id`, [id])).rows
  const movsDe = async (id_cliente) => (await prueba.q(`SELECT tipo, monto, id_op_encabezado FROM movimientos_cuenta WHERE cliente_id = ? ORDER BY id`, [id_cliente])).rows
  const saldoDe = async (id_cliente) => (await prueba.q(`SELECT saldo FROM clientes WHERE id = ?`, [id_cliente])).rows[0].saldo
  const precioCierre = async (id) => (await AlquileresModel.datosCierre(id)).precioActual

  it('un contenedor sin grupo: se cobra al retirarlo, como siempre', async () => {
    const id_cliente = await datos.crearCliente()
    const [cont] = await datos.crearContenedores(1)
    const r = await AlquileresModel.crearEnCurso({ ...datos.datosComunes({ id_cliente, id_administrativo: admin, fecha_inicio: '2026-09-28' }), id_contenedor: cont, plazo_alquiler: 4, precio_alquiler: 100 })
    await retirar(r.id)
    const esperado = await precioCierre(r.id)
    assert.equal(await AlquileresModel.cobrarAlCerrar(r.id), esperado)
    assert.equal((await txDe(r.id)).length, 1)
  })

  it('por contenedor: cada OP se cobra al retirarla', async () => {
    const g = await grupoEnCurso({ cobro_modo: 'contenedor', metodo_pago: 'cuenta_corriente', cuentaCorriente: true })
    await retirar(g.ops[0])
    assert.equal(await AlquileresModel.cobrarAlCerrar(g.ops[0]), await precioCierre(g.ops[0]))
    assert.deepEqual([(await txDe(g.ops[0])).length, (await txDe(g.ops[1])).length], [1, 0])
    await retirar(g.ops[1])
    assert.equal(await AlquileresModel.cobrarAlCerrar(g.ops[1]), await precioCierre(g.ops[1]))
    assert.equal((await movsDe(g.id_cliente)).length, 2) // un cargo por contenedor
  })

  it('por alquiler: no cobra hasta el último; después una transacción por OP y un solo cargo por el total', async () => {
    const g = await grupoEnCurso({ cobro_modo: 'alquiler', metodo_pago: 'cuenta_corriente', cuentaCorriente: true })
    await retirar(g.ops[0])
    assert.equal(await AlquileresModel.cobrarAlCerrar(g.ops[0]), null)
    assert.deepEqual([(await txDe(g.ops[0])).length, (await movsDe(g.id_cliente)).length], [0, 0])
    await retirar(g.ops[1])
    const total = (await precioCierre(g.ops[0])) + 1500
    assert.equal(await AlquileresModel.cobrarAlCerrar(g.ops[1], '1500'), total)
    assert.equal((await txDe(g.ops[0])).length, 1)
    assert.deepEqual((await txDe(g.ops[1])).map(t => t.monto), [1500])
    const movs = await movsDe(g.id_cliente)
    assert.deepEqual(movs.map(m => [m.tipo, m.monto, m.id_op_encabezado]), [['deuda', -total, g.ops[0]]])
    assert.equal(await saldoDe(g.id_cliente), -total)
  })

  it('por alquiler: cobrar dos veces no duplica nada', async () => {
    const g = await grupoEnCurso({ cobro_modo: 'alquiler', metodo_pago: 'cuenta_corriente', cuentaCorriente: true })
    await retirar(g.ops[0]); await retirar(g.ops[1])
    assert.notEqual(await AlquileresModel.cobrarAlCerrar(g.ops[1]), null)
    assert.equal(await AlquileresModel.cobrarAlCerrar(g.ops[1]), null)
    assert.equal(await AlquileresModel.cobrarGrupo(g.id_grupo), null)
    assert.deepEqual([(await txDe(g.ops[0])).length, (await txDe(g.ops[1])).length, (await movsDe(g.id_cliente)).length], [1, 1, 1])
  })

  it('por alquiler "a convenir": sin método queda pendiente; con método se cobra el grupo entero', async () => {
    const g = await grupoEnCurso({ cobro_modo: 'alquiler', metodo_pago: 'a_convenir' })
    await retirar(g.ops[0]); await retirar(g.ops[1])
    assert.equal(await AlquileresModel.cobrarAlCerrar(g.ops[1]), null) // el chofer no manda método
    assert.equal((await txDe(g.ops[0])).length, 0)
    assert.equal(await AlquileresModel.cobrarAlCerrar(g.ops[0], { [g.ops[0]]: '100', [g.ops[1]]: '200' }, 'efectivo'), 300)
    const metodos = (await prueba.q(`SELECT metodo_pago FROM op_encabezado WHERE id_grupo = ? ORDER BY id`, [g.id_grupo])).rows.map(r => r.metodo_pago)
    assert.deepEqual(metodos, ['efectivo', 'efectivo'])
    assert.deepEqual([(await txDe(g.ops[0]))[0].monto, (await txDe(g.ops[1]))[0].monto], [100, 200])
  })

  it('por alquiler: un contenedor repuesto sigue abierto', async () => {
    await datos.crearContenedores(1) // garantiza una unidad disponible para reponer
    const g = await grupoEnCurso({ cobro_modo: 'alquiler' })
    await AlquileresModel.reponerContenedor(g.ops[0])
    await retirar(g.ops[1])
    assert.equal(await AlquileresModel.cobrarAlCerrar(g.ops[1]), null)
    const grupo = await AlquileresModel.grupoDe(g.ops[0])
    assert.deepEqual(grupo.ops.map(o => o.abierta), [true, false])
  })

  it('por alquiler: un contenedor que pasa directo al próximo alquiler cuenta como retirado', async () => {
    const g = await grupoEnCurso({ cobro_modo: 'alquiler' })
    const otroCliente = await datos.crearCliente()
    await AlquileresModel.crearProgramado({
      ...datos.datosComunes({ id_cliente: otroCliente, id_administrativo: admin }),
      id_contenedor: g.conts[0], alquiler_actual_id: g.ops[0], plazo_alquiler: 4, precio_alquiler: 100,
    })
    await AlquileresModel.registrarRetiro(g.ops[0])
    await AlquileresModel.iniciarProximoAlquiler(g.ops[0])
    assert.equal(await AlquileresModel.cobrarAlCerrar(g.ops[0]), null) // falta el otro contenedor
    await retirar(g.ops[1])
    const total = (await precioCierre(g.ops[0])) + (await precioCierre(g.ops[1]))
    assert.equal(await AlquileresModel.cobrarAlCerrar(g.ops[1]), total)
    assert.deepEqual([(await txDe(g.ops[0])).length, (await txDe(g.ops[1])).length], [1, 1])
  })

  it('por alquiler: anulado un contenedor pendiente, se cobra lo retirado', async () => {
    const g = await grupoEnCurso({ cobro_modo: 'alquiler', en_curso: false })
    await AlquileresModel.entregar(g.ops[0])
    await retirar(g.ops[0])
    assert.equal(await AlquileresModel.cobrarAlCerrar(g.ops[0]), null)
    await AlquileresModel.anular(g.ops[1])
    assert.equal(await AlquileresModel.cobrarGrupo(g.id_grupo), await precioCierre(g.ops[0]))
    assert.deepEqual([(await txDe(g.ops[0])).length, (await txDe(g.ops[1])).length], [1, 0])
  })
})
```

- [ ] **Step 2: Correr la prueba y verificar que falla**

Run: `node --test --test-concurrency=1 tests/alquiler-grupos-cobro.test.js`
Expected: pasan "un contenedor sin grupo" y "por contenedor"; fallan las de "por alquiler" (hoy cobra cada OP al retirarla) y `cobrarGrupo is not a function`.

- [ ] **Step 3: `TransaccionesModel.crear` acepta un cliente de transacción**

En `src/models/transacciones.model.js`, reemplazar la función `crear` completa por:

```js
  // `q` permite registrarla dentro de una transacción (cobro de un alquiler agrupado).
  async crear({ tipo, id_op_encabezado, nro_remito, cliente_id, cliente, monto, descripcion, metodo_pago, fecha }, q = query) {
    // Con cliente cargado, el texto del cliente sale siempre de la ficha (nombre + apellido):
    // cada camino de venta/alquiler pasaba un nombre armado distinto (a veces solo el de pila).
    if (cliente_id) {
      const c = (await q(`SELECT nombre, apellido FROM clientes WHERE id = ?`, [cliente_id])).rows[0]
      if (c) cliente = ClientesModel.nombreCompleto(c)
    }
    const { n } = (await q(`SELECT COALESCE(MAX(numero),0) + 1 AS n FROM transacciones WHERE tipo = ?`, [tipo])).rows[0]
    // fecha opcional: si no se pasa, usa la fecha/hora actual (carga histórica la puede fijar en el pasado).
    const { rows } = await q(`
      INSERT INTO transacciones (tipo, numero, id_op_encabezado, nro_remito, cliente_id, cliente, monto, descripcion, metodo_pago, fecha)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, ahora_local()))
      RETURNING id
    `, [tipo, n, id_op_encabezado || null, nro_remito || null, cliente_id || null,
        cliente || '', monto || 0, descripcion || '', metodo_pago || 'efectivo', fecha || null])
    return rows[0].id
  },
```

- [ ] **Step 4: `ClientesModel.agregarMovimiento` acepta un cliente de transacción**

En `src/models/clientes.model.js`, reemplazar:

```js
  async agregarMovimiento(id, { tipo, descripcion, monto, metodo_pago, id_op_encabezado }) {
    const { rows } = await query(`INSERT INTO movimientos_cuenta (cliente_id, tipo, descripcion, monto, metodo_pago, id_op_encabezado) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      [id, tipo, descripcion, Number(monto), metodo_pago || null, id_op_encabezado || null])
    await query(`UPDATE clientes SET saldo = saldo + ? WHERE id = ?`, [Number(monto), id])
    return rows[0].id
  },
```

por:

```js
  // `q` permite registrarlo dentro de una transacción (cobro de un alquiler agrupado).
  async agregarMovimiento(id, { tipo, descripcion, monto, metodo_pago, id_op_encabezado }, q = query) {
    const { rows } = await q(`INSERT INTO movimientos_cuenta (cliente_id, tipo, descripcion, monto, metodo_pago, id_op_encabezado) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      [id, tipo, descripcion, Number(monto), metodo_pago || null, id_op_encabezado || null])
    await q(`UPDATE clientes SET saldo = saldo + ? WHERE id = ?`, [Number(monto), id])
    return rows[0].id
  },
```

- [ ] **Step 5: `grupoConCobroPorAlquiler` y `cobrarGrupo`**

En `src/models/alquileres.model.js`, agregar justo antes del comentario `// Genera el ingreso del alquiler al cerrarlo (cuando se retira el contenedor).`:

```js
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
  // retirar alguno, si es "a convenir" y no viene el método, o si ya estaba cobrado.
  //  - Una transacción por OP, cada una con su monto (la facturación, el borrado y el
  //    control de "ya cobrada" funcionan por operación).
  //  - UN solo movimiento de cuenta corriente / saldo a favor por el total, anclado a la
  //    OP principal (la de menor id), con el detalle de contenedores en la descripción.
  // Todo en una transacción y con el grupo bloqueado (FOR UPDATE): un doble clic, o el
  // chofer y la oficina cerrando a la vez, no pueden cobrar dos veces.
  // `montos`: { [id_op]: monto } para ajustar el precio de cierre de cada contenedor.
  async cobrarGrupo(id_grupo, { montos = {}, metodoPagoFinal = null } = {}) {
    return await transaction(async (q) => {
      await q(`SELECT id FROM alquiler_grupos WHERE id = ? FOR UPDATE`, [id_grupo])
      const ops = (await q(`
        SELECT op.id, op.nro_op, op.nro_remito, op.id_cliente, op.metodo_pago,
               ${nombreCompleto('cli')} AS cliente_nombre,
               ${SQL_OP_ABIERTA} AS abierta,
               EXISTS (SELECT 1 FROM transacciones t WHERE t.id_op_encabezado = op.id) AS cobrada
        FROM op_encabezado op
        JOIN clientes cli ON cli.id = op.id_cliente
        JOIN op_detalle_contenedor oc ON oc.id_orden_pedido = op.id
        LEFT JOIN (${SQL_ULTIMO_MOV}) um ON um.id_contenedor = oc.id_contenedor
        WHERE op.id_grupo = ? AND op.estado <> 'anulado'
        ORDER BY op.id
      `, [id_grupo])).rows
      if (!ops.length || ops.some(o => o.abierta)) return null
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
        const cierre = await this.datosCierre(o.id)
        const valor = montos[o.id]
        const manual = valor != null && String(valor).trim() !== ''
        const monto = manual ? (parseFloat(valor) || 0) : cierre.precioActual
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
    })
  },

```

- [ ] **Step 6: `cobrarAlCerrar` delega en el grupo**

Reemplazar:

```js
  async cobrarAlCerrar(id_op, montoManual, metodoPagoFinal) {
    if (await TransaccionesModel.existePorOperacion(id_op)) return null
```

por:

```js
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
    if (await TransaccionesModel.existePorOperacion(id_op)) return null
```

- [ ] **Step 7: Correr las pruebas y verificar que pasan**

Run: `node --test --test-concurrency=1 tests/alquiler-grupos-cobro.test.js`
Expected: `ℹ pass 8`, `ℹ fail 0`.

Run: `npm test`
Expected: `ℹ fail 0` (todas las pruebas anteriores siguen pasando).

- [ ] **Step 8: Commit**

```bash
git add src/models/transacciones.model.js src/models/clientes.model.js src/models/alquileres.model.js tests/alquiler-grupos-cobro.test.js
git commit -m "Alquileres agrupados: cobro por alquiler al retirar el último contenedor

Una transacción por OP y un solo cargo de cuenta corriente por el total,
en una transacción con el grupo bloqueado (sin cobros duplicados).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Cobranzas agrupadas

**Files:**
- Modify: `src/models/alquileres.model.js` (`pendientesDeCobro`)
- Modify: `src/controllers/alquileres.controller.js` (`cobranzas`, `resolverCobranza`)
- Modify: `views/pages/alquileres/cobranzas.ejs`
- Modify: `tests/alquiler-grupos-cobro.test.js`
- Modify: `tests/alquiler-grupos-vistas.test.js`

**Interfaces:**
- Consumes: `grupoDe` (Tarea 6), `cobrarAlCerrar` (Tarea 7), `leerMontosPorOp` (Tarea 2).
- Produces: `pendientesDeCobro()` devuelve filas sueltas como hoy más, por grupo con cobro por alquiler y todos sus contenedores retirados, UNA fila `{ ...primeraOp, esGrupo: true, ops: [filas], numero_contenedor: '19, 20', fecha_retiro }`. El formulario de Cobranzas manda `precio_final[op<ID>]` por contenedor en las filas de grupo.

- [ ] **Step 1: Pruebas**

En `tests/alquiler-grupos-cobro.test.js`, agregar al principio (debajo de los otros `require`):

```js
const { llamar } = require('./helpers/controlador')
```

y dentro del `describe`:

```js
  it('Cobranzas: un grupo "a convenir" aparece una sola vez y recién con todo retirado', async () => {
    const g = await grupoEnCurso({ cobro_modo: 'alquiler', metodo_pago: 'a_convenir' })
    await retirar(g.ops[0])
    let filas = (await AlquileresModel.pendientesDeCobro()).filter(p => p.id_grupo === g.id_grupo)
    assert.equal(filas.length, 0)
    await retirar(g.ops[1])
    filas = (await AlquileresModel.pendientesDeCobro()).filter(p => p.id_grupo === g.id_grupo)
    assert.equal(filas.length, 1)
    assert.equal(filas[0].esGrupo, true)
    assert.deepEqual(filas[0].ops.map(o => o.id).sort((a, b) => a - b), g.ops)
  })

  it('Cobranzas: resolver el grupo cobra todos sus contenedores con los montos de cada uno', async () => {
    const g = await grupoEnCurso({ cobro_modo: 'alquiler', metodo_pago: 'a_convenir' })
    await retirar(g.ops[0]); await retirar(g.ops[1])
    const user = { id: admin, rol: 'dueno' }
    const r = await llamar('resolverCobranza', { user, params: { id: String(g.ops[0]) }, body: {
      metodo_pago_final: 'efectivo', precio_final: { ['op' + g.ops[0]]: '100', ['op' + g.ops[1]]: '250' },
    } })
    assert.deepEqual(r.flashes, [{ tipo: 'success', msg: 'Cobro registrado por $350.' }])
    assert.deepEqual([(await txDe(g.ops[0]))[0].monto, (await txDe(g.ops[1]))[0].monto], [100, 250])
  })
```

En `tests/alquiler-grupos-vistas.test.js`, agregar dentro del `describe`:

```js
  it('Cobranzas: la fila de un grupo pide el monto de cada contenedor', async () => {
    const html = await renderVista('pages/alquileres/cobranzas', {
      pendientes: [{
        id: 101, nro_op: 261, id_grupo: 9, esGrupo: true, cliente_nombre: 'Cliente', domicilio_entrega: 'San Lorenzo 501',
        numero_contenedor: '19, 20', fecha_retiro: '2026-10-01 10:00:00', montoEstimado: 300, saldo_favor_cliente: 0,
        ops: [
          { id: 101, nro_op: 261, numero_contenedor: 19, montoEstimado: 100 },
          { id: 102, nro_op: 262, numero_contenedor: 20, montoEstimado: 200 },
        ],
      }],
    })
    assert.match(html, /Cobro por alquiler · 2 contenedores/)
    assert.match(html, /name="precio_final\[op101\]"/)
    assert.match(html, /name="precio_final\[op102\]"/)
    assert.match(html, /OP-0261, OP-0262/)
  })
```

- [ ] **Step 2: Correr las pruebas y verificar que fallan**

Run: `node --test --test-concurrency=1 tests/alquiler-grupos-cobro.test.js tests/alquiler-grupos-vistas.test.js`
Expected: FAIL en las 3 pruebas nuevas (aparecen dos filas sueltas; `resolverCobranza` no reconoce los montos `op<ID>`; la vista no tiene la fila agrupada). Las demás pasan.

- [ ] **Step 3: `pendientesDeCobro` agrupa**

En `src/models/alquileres.model.js`, reemplazar la función `pendientesDeCobro` completa por:

```js
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
        AND EXISTS (SELECT 1 FROM movimiento_contenedor m WHERE m.id_op_contenedor = oc.id AND m.estado_paso = 'disponible')
        AND NOT EXISTS (SELECT 1 FROM transacciones t WHERE t.id_op_encabezado = op.id)
      ORDER BY fecha_retiro ASC NULLS LAST
    `)).rows
    // Alquiler agrupado con cobro por alquiler: UNA fila por grupo, y solo cuando ya se
    // retiraron todos sus contenedores (antes no hay nada que cobrar todavía).
    const resultado = []
    const vistos = new Set()
    for (const f of filas) {
      if (f.cobro_modo !== 'alquiler') { resultado.push(f); continue }
      if (vistos.has(f.id_grupo)) continue
      vistos.add(f.id_grupo)
      const grupo = await this.grupoDe(f.id)
      if (!grupo || grupo.abiertas > 0) continue
      const ops = filas.filter(x => x.id_grupo === f.id_grupo)
      resultado.push({
        ...ops[0], esGrupo: true, ops,
        numero_contenedor: ops.map(x => x.numero_contenedor).filter(Boolean).join(', '),
        fecha_retiro: ops.map(x => x.fecha_retiro).filter(Boolean).sort().pop() || null,
      })
    }
    return resultado
  },
```

- [ ] **Step 4: Controlador de Cobranzas**

En `src/controllers/alquileres.controller.js`, dentro de `cobranzas`, reemplazar:

```js
      for (const p of pendientes) {
        const cierre = await AlquileresModel.datosCierre(p.id)
        p.montoEstimado = cierre ? cierre.precioActual : (p.precio_alquiler || 0)
      }
```

por:

```js
      for (const p of pendientes) {
        // En una fila de grupo, el estimado de cada contenedor y el total
        for (const o of (p.esGrupo ? p.ops : [p])) {
          const cierre = await AlquileresModel.datosCierre(o.id)
          o.montoEstimado = cierre ? cierre.precioActual : (o.precio_alquiler || 0)
        }
        if (p.esGrupo) p.montoEstimado = p.ops.reduce((suma, o) => suma + o.montoEstimado, 0)
      }
```

Dentro de `resolverCobranza`, reemplazar:

```js
      const monto = await AlquileresModel.cobrarAlCerrar(req.params.id, precio_final, metodo_pago_final)
```

por:

```js
      const monto = await AlquileresModel.cobrarAlCerrar(req.params.id, leerMontosPorOp(precio_final), metodo_pago_final)
```

- [ ] **Step 5: Fila agrupada en `cobranzas.ejs`**

En `views/pages/alquileres/cobranzas.ejs`, reemplazar la celda del contenedor y la de cliente/OP:

```ejs
          <td class="fw-semibold text-orange"><%= p.numero_contenedor ? 'N° ' + p.numero_contenedor : '—' %></td>
          <td>
            <small class="fw-semibold"><%= p.cliente_nombre %></small><br>
            <small class="text-muted">OP-<%= String(p.nro_op).padStart(4,'0') %></small>
          </td>
```

por:

```ejs
          <td class="fw-semibold text-orange">
            <%= p.numero_contenedor ? 'N° ' + p.numero_contenedor : '—' %>
            <% if (p.esGrupo) { %><br><span class="badge rounded-pill px-2 badge-en-transito">Cobro por alquiler · <%= p.ops.length %> contenedores</span><% } %>
          </td>
          <td>
            <small class="fw-semibold"><%= p.cliente_nombre %></small><br>
            <small class="text-muted"><%= (p.esGrupo ? p.ops : [p]).map(o => 'OP-' + String(o.nro_op).padStart(4,'0')).join(', ') %></small>
          </td>
```

Reemplazar el input de monto:

```ejs
              <input type="number" step="0.01" min="0" name="precio_final" class="form-control form-control-sm"
                     style="max-width:130px" value="<%= Math.round(p.montoEstimado) %>" title="Monto a cobrar">
```

por:

```ejs
              <% if (p.esGrupo) { %>
                <% p.ops.forEach(o => { %>
                  <label class="small mb-0">N° <%= o.numero_contenedor || '?' %>
                    <input type="number" step="0.01" min="0" name="precio_final[op<%= o.id %>]" class="form-control form-control-sm"
                           style="max-width:120px" value="<%= Math.round(o.montoEstimado) %>">
                  </label>
                <% }) %>
              <% } else { %>
                <input type="number" step="0.01" min="0" name="precio_final" class="form-control form-control-sm"
                       style="max-width:130px" value="<%= Math.round(p.montoEstimado) %>" title="Monto a cobrar">
              <% } %>
```

- [ ] **Step 6: Correr las pruebas y verificar que pasan**

Run: `npm test`
Expected: `ℹ fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/models/alquileres.model.js src/controllers/alquileres.controller.js views/pages/alquileres/cobranzas.ejs tests/alquiler-grupos-cobro.test.js tests/alquiler-grupos-vistas.test.js
git commit -m "Cobranzas: una fila por alquiler agrupado con el monto de cada contenedor

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Retiro y cierre en la pantalla del alquiler

**Files:**
- Create: `views/partials/alquiler_cierre.ejs`
- Modify: `views/pages/alquileres/detalle.ejs`
- Modify: `src/controllers/alquileres.controller.js` (`detalle`, `devolverAPlanta`)
- Modify: `tests/alquiler-grupos-vistas.test.js`
- Modify: `tests/alquiler-grupos-controlador.test.js`

**Interfaces:**
- Consumes: `obtener().grupo` (Tarea 6), `cobrarAlCerrar` (Tarea 7), `leerMontosPorOp` (Tarea 2).
- Produces: parcial `partials/alquiler_cierre` con locals `{ alquiler, cierre, saldoFavorCliente, grupo, cierresGrupo }` (`cierresGrupo`: `[{ id, numero_contenedor, precioActual }]` o `null`).

- [ ] **Step 1: Pruebas de la vista**

En `tests/alquiler-grupos-vistas.test.js`, agregar dentro del `describe`:

```js
  const cierreEj = { precioInicial: 100, precioActual: 120, dias: 5, mesInicio: 'septiembre 2026', cambioDePrecio: false }
  const grupoAbierto = (otraAbierta) => ({ cobro_modo: 'alquiler', ops: [{ id: 101, abierta: true }, { id: 102, abierta: otraAbierta }] })

  it('cierre de un contenedor suelto: un solo monto, como siempre', async () => {
    const html = await renderVista('partials/alquiler_cierre', { alquiler: { id: 101, metodo_pago: 'efectivo' }, cierre: cierreEj, saldoFavorCliente: 0, grupo: null, cierresGrupo: null })
    assert.match(html, /name="precio_final"/)
    assert.match(html, /Registrar retiro y cobrar/)
  })

  it('cierre en grupo por alquiler con otro contenedor afuera: retiro sin cobro', async () => {
    const html = await renderVista('partials/alquiler_cierre', { alquiler: { id: 101, metodo_pago: 'a_convenir' }, cierre: cierreEj, saldoFavorCliente: 0, grupo: grupoAbierto(true), cierresGrupo: null })
    assert.doesNotMatch(html, /name="precio_final/)
    assert.doesNotMatch(html, /metodo_pago_final/) // el método se pide recién en el último
    assert.match(html, /se cobra todo junto al retirar el último/)
    assert.match(html, /\(falta 1\)/)
  })

  it('cierre del último contenedor del grupo: un monto por contenedor', async () => {
    const html = await renderVista('partials/alquiler_cierre', {
      alquiler: { id: 101, metodo_pago: 'efectivo' }, cierre: cierreEj, saldoFavorCliente: 0, grupo: grupoAbierto(false),
      cierresGrupo: [{ id: 101, numero_contenedor: 19, precioActual: 120 }, { id: 102, numero_contenedor: 20, precioActual: 130 }],
    })
    assert.match(html, /name="precio_final\[op101\]"/)
    assert.match(html, /name="precio_final\[op102\]"/)
    assert.match(html, /Se cobra todo el alquiler: 2 contenedores/)
  })
```

- [ ] **Step 2: Pruebas del controlador**

En `tests/alquiler-grupos-controlador.test.js`, agregar dentro del `describe`:

```js
  it('retiro en grupo por alquiler "a convenir": el primero sin método; el último pide método y cobra todo', async () => {
    const id_cliente = await datos.crearCliente()
    const conts = await datos.crearContenedores(2)
    const g = await AlquileresModel.crearGrupo({
      ...datos.datosComunes({ id_cliente, id_administrativo: admin.id, metodo_pago: 'a_convenir', fecha_inicio: '2026-09-28' }),
      cobro_modo: 'alquiler', en_curso: true,
      contenedores: conts.map(id_contenedor => ({ id_contenedor, plazo_alquiler: 4, precio_alquiler: 100 })),
    })
    const [op1, op2] = g.ops.map(o => o.id)

    let r = await llamar('devolverAPlanta', { user: admin, params: { id: String(op1) }, body: {} })
    assert.deepEqual(r.flashes, [{ tipo: 'success', msg: 'Contenedor retirado. El alquiler se cobra todo junto al retirar el último contenedor (falta 1).' }])

    r = await llamar('devolverAPlanta', { user: admin, params: { id: String(op2) }, body: {} })
    assert.equal(r.flashes[0].tipo, 'error') // "a convenir": falta el método en el último

    r = await llamar('devolverAPlanta', { user: admin, params: { id: String(op2) }, body: {
      metodo_pago_final: 'efectivo', precio_final: { ['op' + op1]: '100', ['op' + op2]: '200' },
    } })
    assert.deepEqual(r.flashes, [{ tipo: 'success', msg: 'Contenedor retirado — alquiler cerrado por $300 (2 contenedores).' }])
  })
```

- [ ] **Step 3: Correr las pruebas y verificar que fallan**

Run: `node --test --test-concurrency=1 tests/alquiler-grupos-vistas.test.js tests/alquiler-grupos-controlador.test.js`
Expected: FAIL (no existe el parcial `alquiler_cierre`; el primer retiro exige método "a convenir").

- [ ] **Step 4: Crear `views/partials/alquiler_cierre.ejs`**

```ejs
<%#
  Cierre del alquiler (retiro + cobro). Lo incluye detalle.ejs cuando el contenedor está
  en el domicilio. Locals: alquiler, cierre, saldoFavorCliente, grupo (alquiler.grupo o
  null) y cierresGrupo (monto de cierre de cada contenedor; solo cuando este es el último
  contenedor abierto de un grupo con cobro por alquiler).
%>
<%
  const grupoAlq = (grupo && grupo.cobro_modo === 'alquiler') ? grupo : null
  const faltanOtros = grupoAlq ? grupoAlq.ops.filter(o => o.abierta && o.id !== alquiler.id).length : 0
  const pideMetodo = alquiler.metodo_pago === 'a_convenir' && faltanOtros === 0
  const confirmar = faltanOtros > 0
    ? '¿Registrar el retiro? El contenedor queda disponible y el alquiler se cobra al retirar el último.'
    : '¿Cerrar el alquiler? El contenedor queda disponible.'
%>
<div class="cierre-alquiler mt-3">
  <p class="fw-semibold mb-1"><%= faltanOtros > 0 ? 'Registrar retiro' : 'Cerrar alquiler y cobrar' %></p>
  <p class="text-muted small mb-2">
    <% if (faltanOtros > 0) { %>
      Cobro por alquiler: este contenedor se retira sin cobrar; se cobra todo junto al retirar el último
      (falta<%= faltanOtros === 1 ? '' : 'n' %> <%= faltanOtros %>).
    <% } else { %>
      El ingreso se registra al retirar el contenedor.
      <% if (cierre.cambioDePrecio) { %>
        Precio pactado al inicio (<%= cierre.mesInicio %>):
        <strong>$<%= Math.round(cierre.precioInicial).toLocaleString('es-AR') %></strong>.
      <% } %>
      <% if (cierre.dias != null) { %>Lleva <%= cierre.dias %> días.<% } %>
      <% if (cierresGrupo) { %>Se cobra todo el alquiler: <%= cierresGrupo.length %> contenedores.<% } %>
    <% } %>
  </p>
  <form action="/alquileres/contenedores/<%= alquiler.id %>/devolver" method="POST"
        id="formDevolver" class="d-flex flex-wrap gap-2 align-items-end" data-confirmar="<%= confirmar %>">
    <% if (faltanOtros === 0 && cierresGrupo) { %>
      <% cierresGrupo.forEach(c => { %>
        <div>
          <label for="precioFinal_<%= c.id %>" class="form-label mb-1 small">N° <%= c.numero_contenedor || '?' %></label>
          <input type="number" step="0.01" min="0" name="precio_final[op<%= c.id %>]" id="precioFinal_<%= c.id %>"
                 class="form-control form-control-sm" style="max-width:150px" value="<%= Math.round(c.precioActual) %>">
        </div>
      <% }) %>
    <% } else if (faltanOtros === 0) { %>
      <div>
        <label for="precioFinal" class="form-label mb-1 small">Monto a cobrar</label>
        <input type="number" step="0.01" min="0" name="precio_final" id="precioFinal"
               class="form-control form-control-sm" style="max-width:170px"
               value="<%= Math.round(cierre.precioActual) %>">
      </div>
    <% } %>
    <% if (pideMetodo) { %>
      <div>
        <label for="metodoPagoFinal" class="form-label mb-1 small">Método de pago *</label>
        <select name="metodo_pago_final" id="metodoPagoFinal" class="form-select form-select-sm" style="max-width:200px">
          <option value="">Seleccionar…</option>
          <option value="efectivo">Efectivo</option>
          <option value="transferencia">Transferencia</option>
          <option value="cheque">Cheque</option>
          <option value="cuenta_corriente">Cuenta corriente</option>
          <% if (saldoFavorCliente > 0) { %>
            <option value="saldo_a_favor">Usar saldo a favor del cliente ($<%= Math.round(saldoFavorCliente).toLocaleString('es-AR') %>)</option>
          <% } %>
        </select>
      </div>
      <label class="toggle-row mb-1" for="pendientePago">
        <input type="checkbox" name="pendiente_pago" id="pendientePago" value="1">
        <span>Pendiente de pago</span>
      </label>
    <% } %>
    <button class="btn btn-sm btn-outline-success"><%= faltanOtros > 0 ? '🏠 Registrar retiro' : '🏠 Registrar retiro y cobrar' %></button>
  </form>
  <% if (pideMetodo) { %>
    <p class="form-hint mb-0 mt-1">Este alquiler quedó "a convenir": elegí un método de pago o marcá "Pendiente de pago" (queda en Cobranzas).</p>
  <% } %>
  <script>
  (function () {
    var form = document.getElementById('formDevolver')
    if (!form) return
    var sel = document.getElementById('metodoPagoFinal')
    var chk = document.getElementById('pendientePago')
    if (sel && chk) {
      sel.addEventListener('change', function () { if (sel.value) chk.checked = false })
      chk.addEventListener('change', function () { if (chk.checked) sel.value = '' })
    }
    form.addEventListener('submit', function (e) {
      if (sel && !chk.checked && !sel.value) {
        alert('Elegí un método de pago o marcá "Pendiente de pago".')
        e.preventDefault()
        return
      }
      var texto = form.dataset.confirmar + (chk && chk.checked ? ' El cobro queda pendiente en Cobranzas.' : '')
      if (!confirm(texto)) e.preventDefault()
    })
  })()
  </script>
</div>
```

- [ ] **Step 5: Usar el parcial en `detalle.ejs`**

En `views/pages/alquileres/detalle.ejs`, reemplazar todo el bloque que empieza en:

```ejs
            <%# Cierre del alquiler: es el momento en que se cobra %>
            <% if (alquiler.estado === 'entregado' && ['en_alquiler','pendiente_retiro'].includes(estadoCont) && cierre) { %>
              <div class="cierre-alquiler mt-3">
```

y termina en el `<% } %>` que cierra ese `if` (inmediatamente después del `</div>` que cierra `cierre-alquiler`, antes de `<% } %>` del `if (!estaAnulado)`), por:

```ejs
            <%# Cierre del alquiler: es el momento en que se cobra %>
            <% if (alquiler.estado === 'entregado' && ['en_alquiler','pendiente_retiro'].includes(estadoCont) && cierre) { %>
              <%- include('../../partials/alquiler_cierre', {
                    alquiler, cierre, saldoFavorCliente,
                    grupo: alquiler.grupo || null,
                    cierresGrupo: typeof cierresGrupo !== 'undefined' ? cierresGrupo : null }) %>
            <% } %>
```

- [ ] **Step 6: Controlador: `detalle` y `devolverAPlanta`**

En `detalle`, antes de `res.render('pages/alquileres/detalle', {`, agregar:

```js
      // Último contenedor abierto de un grupo con cobro por alquiler: su cierre cobra todo
      // el grupo, así que se muestran los montos de cierre de cada contenedor.
      let cierresGrupo = null
      const g = alquiler.grupo
      if (g?.cobro_modo === 'alquiler' && !g.ops.some(o => o.abierta && o.id !== alquiler.id)) {
        cierresGrupo = []
        for (const o of g.ops.filter(o => o.estado !== 'anulado' && !o.cobrada)) {
          const c = await AlquileresModel.datosCierre(o.id)
          cierresGrupo.push({ id: o.id, numero_contenedor: o.numero_contenedor, precioActual: c ? c.precioActual : 0 })
        }
      }
```

y en el objeto del `render`, después de `cierre: alquiler.detalle ? await AlquileresModel.datosCierre(alquiler.id) : null,` agregar:

```js
        cierresGrupo,
```

Reemplazar el cuerpo del `try` de `devolverAPlanta` (desde `const alquiler = await AlquileresModel.obtener(req.params.id)` hasta el `req.flash('success', ...)` inclusive) por:

```js
      const alquiler = await AlquileresModel.obtener(req.params.id)
      // Alquiler agrupado con cobro por alquiler: solo el retiro del último contenedor cobra.
      const grupoAlq = alquiler?.grupo?.cobro_modo === 'alquiler' ? alquiler.grupo : null
      const faltanOtros = grupoAlq ? grupoAlq.ops.filter(o => o.abierta && o.id !== alquiler.id).length : 0
      // "A convenir una vez finalizado": al cobrar hay que resolverlo sí o sí — un método de
      // pago real, o el check de "pendiente de pago" (queda en Cobranzas).
      const pendientePago = req.body.pendiente_pago === '1' || req.body.pendiente_pago === 'on'
      const metodoPagoFinal = (req.body.metodo_pago_final || '').trim() || null
      if (alquiler?.metodo_pago === 'a_convenir' && faltanOtros === 0 && !pendientePago && !metodoPagoFinal) {
        req.flash('error', 'Este alquiler quedó "a convenir": indicá un método de pago o marcá "Pendiente de pago".')
        return res.redirect(`/alquileres/contenedores/${req.params.id}`)
      }
      await AlquileresModel.devolverAPlanta(req.params.id)
      // El alquiler termina acá: es el momento en que se cobra (salvo que haya quedado
      // explícitamente pendiente de pago, o que en un grupo falten contenedores).
      const monto = pendientePago ? null
        : await AlquileresModel.cobrarAlCerrar(req.params.id, leerMontosPorOp(req.body.precio_final), metodoPagoFinal)
      if (alquiler?.detalle?.alquiler_siguiente_id) {
        await AlquileresModel.activarProgramado(alquiler.detalle.alquiler_siguiente_id)
      }
      const cantGrupo = grupoAlq ? grupoAlq.ops.filter(o => o.estado !== 'anulado').length : 0
      req.flash('success', faltanOtros > 0
        ? `Contenedor retirado. El alquiler se cobra todo junto al retirar el último contenedor (falta${faltanOtros === 1 ? '' : 'n'} ${faltanOtros}).`
        : monto != null
          ? `Contenedor retirado — alquiler cerrado por $${Math.round(monto).toLocaleString('es-AR')}${grupoAlq ? ` (${cantGrupo} contenedores)` : ''}.`
          : pendientePago
            ? 'Contenedor retirado — pago pendiente, quedó en Cobranzas.'
            : 'Contenedor retirado — ciclo completado.')
```

- [ ] **Step 7: Correr las pruebas y verificar que pasan**

Run: `npm test`
Expected: `ℹ fail 0`.

Run: `node -e "const ejs=require('ejs'),fs=require('fs');for(const f of ['views/pages/alquileres/detalle.ejs','views/partials/alquiler_cierre.ejs'])ejs.compile(fs.readFileSync(f,'utf8'),{filename:f});console.log('ok')"`
Expected: `ok`.

- [ ] **Step 8: Commit**

```bash
git add views/partials/alquiler_cierre.ejs views/pages/alquileres/detalle.ejs src/controllers/alquileres.controller.js tests/alquiler-grupos-vistas.test.js tests/alquiler-grupos-controlador.test.js
git commit -m "Alquileres agrupados: retiro sin cobro hasta el último y cierre con monto por contenedor

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Anulación, borrado de transacciones y cuentas corrientes

**Files:**
- Modify: `src/controllers/alquileres.controller.js` (`anular`)
- Modify: `src/models/transacciones.model.js` (`eliminar`)
- Modify: `src/models/clientes.model.js` (`SQL_OP_SIN_CARGO`)
- Modify: `tests/alquiler-grupos-cobro.test.js`

**Interfaces:**
- Consumes: `grupoConCobroPorAlquiler`, `cobrarGrupo` (Tarea 7), `llamar` (`tests/helpers/controlador.js`).
- Produces: `TransaccionesModel.eliminar(id)` rechaza con un mensaje claro el borrado de una transacción de un grupo con cobro por alquiler que tiene cargo de cuenta corriente. `ClientesModel.operacionesSinCargo(clienteId)` deja de listar las OP de un grupo ya cargado.

- [ ] **Step 1: Pruebas**

En `tests/alquiler-grupos-cobro.test.js`, agregar al principio:

```js
const TransaccionesModel = require('../src/models/transacciones.model')
const ClientesModel = require('../src/models/clientes.model')
```

y dentro del `describe`:

```js
  it('anular el último contenedor pendiente de un grupo cobra lo ya retirado', async () => {
    const g = await grupoEnCurso({ cobro_modo: 'alquiler', en_curso: false })
    await AlquileresModel.entregar(g.ops[0])
    await retirar(g.ops[0])
    await AlquileresModel.cobrarAlCerrar(g.ops[0])
    const r = await llamar('anular', { user: { id: admin, rol: 'dueno' }, params: { id: String(g.ops[1]) } })
    assert.match(r.flashes[0].msg, /^Alquiler anulado\. Se cobró el resto del alquiler agrupado por \$/)
    assert.equal((await txDe(g.ops[0])).length, 1)
  })

  it('no se puede borrar por separado una transacción de un cobro agrupado con cuenta corriente', async () => {
    const g = await grupoEnCurso({ cobro_modo: 'alquiler', metodo_pago: 'cuenta_corriente', cuentaCorriente: true })
    await retirar(g.ops[0]); await retirar(g.ops[1])
    await AlquileresModel.cobrarAlCerrar(g.ops[1])
    const tx = (await prueba.q(`SELECT id FROM transacciones WHERE id_op_encabezado = ?`, [g.ops[1]])).rows[0]
    await assert.rejects(TransaccionesModel.eliminar(tx.id), /no se puede eliminar una transacción por separado/)
    assert.equal((await txDe(g.ops[1])).length, 1)
  })

  it('cuentas corrientes: el cargo único del grupo cuenta para todas sus OP', async () => {
    const g = await grupoEnCurso({ cobro_modo: 'alquiler', metodo_pago: 'cuenta_corriente', cuentaCorriente: true })
    const sinCargo = async () => (await ClientesModel.operacionesSinCargo(g.id_cliente)).map(o => o.id).sort((a, b) => a - b)
    assert.deepEqual(await sinCargo(), g.ops) // en curso: todavía sin cargo
    await retirar(g.ops[0]); await retirar(g.ops[1])
    await AlquileresModel.cobrarAlCerrar(g.ops[1])
    assert.deepEqual(await sinCargo(), [])
  })
```

- [ ] **Step 2: Correr las pruebas y verificar que fallan**

Run: `node --test --test-concurrency=1 tests/alquiler-grupos-cobro.test.js`
Expected: FAIL en las 3 pruebas nuevas.

- [ ] **Step 3: `anular` dispara el cobro del grupo**

En `src/controllers/alquileres.controller.js`, reemplazar la función `anular` completa por:

```js
  async anular(req, res) {
    try {
      await AlquileresModel.anular(req.params.id)
      // Si era el último contenedor pendiente de un alquiler agrupado con cobro por
      // alquiler y los demás ya se retiraron, el cobro del grupo se genera ahora.
      const grupo = await AlquileresModel.grupoConCobroPorAlquiler(req.params.id)
      const monto = grupo ? await AlquileresModel.cobrarGrupo(grupo.id) : null
      req.flash('success', monto != null
        ? `Alquiler anulado. Se cobró el resto del alquiler agrupado por $${Math.round(monto).toLocaleString('es-AR')}.`
        : 'Alquiler anulado.')
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al anular.')
    }
    res.redirect('/alquileres/contenedores')
  },
```

- [ ] **Step 4: Bloquear el borrado en `TransaccionesModel.eliminar`**

En `src/models/transacciones.model.js`, dentro de `eliminar`, reemplazar:

```js
    const idOp = tx.id_op_encabezado

```

por:

```js
    const idOp = tx.id_op_encabezado

    // Cobro de un alquiler agrupado "por alquiler" con un solo cargo de cuenta corriente
    // por el total: borrar una de sus transacciones (y con ella su operación) dejaría la
    // cuenta del cliente descuadrada, porque el cargo cubre a todos los contenedores.
    if (idOp) {
      const agrupado = (await query(`
        SELECT 1 FROM op_encabezado op
        JOIN alquiler_grupos ag ON ag.id = op.id_grupo AND ag.cobro_modo = 'alquiler'
        WHERE op.id = ? AND EXISTS (
          SELECT 1 FROM movimientos_cuenta m
          WHERE m.id_op_encabezado IN (SELECT g.id FROM op_encabezado g WHERE g.id_grupo = op.id_grupo))
      `, [idOp])).rows[0]
      if (agrupado) {
        throw new Error('Este cobro es de un alquiler con varios contenedores y se registró en la cuenta corriente del cliente como un solo cargo: no se puede eliminar una transacción por separado.')
      }
    }

```

- [ ] **Step 5: `SQL_OP_SIN_CARGO` contempla el grupo**

En `src/models/clientes.model.js`, reemplazar:

```js
// Operación a cuenta corriente, no anulada, que todavía no tiene su cargo (op = op_encabezado)
const SQL_OP_SIN_CARGO = `op.metodo_pago = 'cuenta_corriente' AND op.estado <> 'anulado'
  AND NOT EXISTS (SELECT 1 FROM movimientos_cuenta m WHERE m.id_op_encabezado = op.id AND m.tipo = 'deuda')`
```

por:

```js
// Operación a cuenta corriente, no anulada, que todavía no tiene su cargo (op = op_encabezado).
// En un alquiler agrupado con cobro "por alquiler" el cargo es UNO para todo el grupo
// (anclado a su OP principal): un cargo de cualquier OP del grupo cuenta para todas.
const SQL_OP_SIN_CARGO = `op.metodo_pago = 'cuenta_corriente' AND op.estado <> 'anulado'
  AND NOT EXISTS (SELECT 1 FROM movimientos_cuenta m WHERE m.tipo = 'deuda' AND (
    m.id_op_encabezado = op.id
    OR m.id_op_encabezado IN (
      SELECT g.id FROM op_encabezado g
      JOIN alquiler_grupos ag ON ag.id = g.id_grupo AND ag.cobro_modo = 'alquiler'
      WHERE g.id_grupo = op.id_grupo)))`
```

- [ ] **Step 6: Correr las pruebas y verificar que pasan**

Run: `npm test`
Expected: `ℹ fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/controllers/alquileres.controller.js src/models/transacciones.model.js src/models/clientes.model.js tests/alquiler-grupos-cobro.test.js
git commit -m "Alquileres agrupados: cobro al anular el último pendiente, borrado protegido y cargos de cuenta corriente

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Release A (Fases 1 y 2)

- [ ] **Step 1: Verificación completa**

Run: `npm test`
Expected: `ℹ fail 0`.

Run: `node -e "const ejs=require('ejs'),fs=require('fs'),path=require('path');const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):e.name.endsWith('.ejs')?[path.join(d,e.name)]:[]);for(const f of walk('views'))ejs.compile(fs.readFileSync(f,'utf8'),{filename:f});console.log('ok')"`
Expected: `ok`.

Run: `for f in src/models/*.js src/controllers/*.js src/config/*.js src/utils/*.js public/js/*.js; do node --check $f || echo FAIL $f; done && npm run build`
Expected: sin `FAIL`; sass compila.

- [ ] **Step 2: Revisión de la rama**

Pedir una revisión de la rama completa (skill `superpowers:requesting-code-review`) con foco en las 5 líneas de "Review Focus". Corregir lo que surja, con su prueba.

- [ ] **Step 3: Merge y push (con OK del usuario)**

```bash
git checkout main && git pull --ff-only origin main
git merge --no-ff feat/alquiler-multi-contenedor -m "Merge feat/alquiler-multi-contenedor (fases 1 y 2)"
git push origin main
git checkout feat/alquiler-multi-contenedor
```

- [ ] **Step 4: Verificación en producción**

Cuando Render termine: pedirle al usuario que cargue un alquiler real con dos contenedores y verificar (solo lectura) que quedó agrupado: `SELECT op.nro_op, op.id_grupo, ag.cobro_modo FROM op_encabezado op JOIN alquiler_grupos ag ON ag.id = op.id_grupo ORDER BY op.id DESC LIMIT 4`.

---

# Fase 3 — Acciones grupales y mapa

### Task 12: Anular el alquiler completo

**Files:**
- Modify: `src/models/alquileres.model.js` (nuevo `anularGrupo`)
- Modify: `src/controllers/alquileres.controller.js` (nuevo `anularGrupo`)
- Modify: `src/routes/alquileres.routes.js`
- Modify: `views/partials/alquiler_grupo.ejs`
- Create: `tests/alquiler-grupos-acciones.test.js`
- Modify: `tests/alquiler-grupos-vistas.test.js`

**Interfaces:**
- Consumes: `grupoDe` (Tarea 6), `anular` (existente), `grupoConCobroPorAlquiler`/`cobrarGrupo` (Tarea 7).
- Produces: `anularGrupo(id_op) → Promise<number>` (cuántas OP anuló); ruta `POST /alquileres/contenedores/:id/anular-grupo`.

- [ ] **Step 1: Escribir `tests/alquiler-grupos-acciones.test.js`**

```js
'use strict'
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const AlquileresModel = require('../src/models/alquileres.model')
const { llamar } = require('./helpers/controlador')

describe('acciones sobre alquileres agrupados', () => {
  let admin

  before(async () => {
    await prueba.abrir()
    admin = await datos.idAdministrativo()
  })
  after(prueba.cerrar)

  async function grupo({ en_curso = false, cobro_modo = 'contenedor' } = {}) {
    const id_cliente = await datos.crearCliente()
    const conts = await datos.crearContenedores(2)
    const g = await AlquileresModel.crearGrupo({
      ...datos.datosComunes({ id_cliente, id_administrativo: admin, fecha_inicio: '2026-09-28' }),
      cobro_modo, en_curso,
      contenedores: conts.map(id_contenedor => ({ id_contenedor, plazo_alquiler: 4, precio_alquiler: 100 })),
    })
    return { id_cliente, conts, id_grupo: g.id_grupo, ops: g.ops.map(o => o.id) }
  }
  const estados = async (ids) => (await prueba.q(`SELECT estado FROM op_encabezado WHERE id = ANY(?::bigint[]) ORDER BY id`, [ids])).rows.map(r => r.estado)
  const ultimoMov = async (id_contenedor) => (await prueba.q(`SELECT estado_paso FROM movimiento_contenedor WHERE id_contenedor = ? ORDER BY fecha_movimiento DESC, id DESC LIMIT 1`, [id_contenedor])).rows[0].estado_paso

  it('anularGrupo anula las OP pendientes y libera sus contenedores', async () => {
    const g = await grupo()
    assert.equal(await AlquileresModel.anularGrupo(g.ops[0]), 2)
    assert.deepEqual(await estados(g.ops), ['anulado', 'anulado'])
    assert.deepEqual([await ultimoMov(g.conts[0]), await ultimoMov(g.conts[1])], ['disponible', 'disponible'])
  })

  it('anularGrupo no toca las OP ya entregadas', async () => {
    const g = await grupo()
    await AlquileresModel.entregar(g.ops[0])
    assert.equal(await AlquileresModel.anularGrupo(g.ops[1]), 1)
    assert.deepEqual(await estados(g.ops), ['entregado', 'anulado'])
  })

  it('anularGrupo de una OP sin grupo es un error', async () => {
    const id_cliente = await datos.crearCliente()
    const [cont] = await datos.crearContenedores(1)
    const s = await AlquileresModel.crear({ ...datos.datosComunes({ id_cliente, id_administrativo: admin }), id_contenedor: cont, plazo_alquiler: 4, precio_alquiler: 100 })
    await assert.rejects(AlquileresModel.anularGrupo(s.id), /no es de varios contenedores/)
  })

  it('controlador: anular el alquiler completo informa cuántos anuló', async () => {
    const g = await grupo()
    const r = await llamar('anularGrupo', { user: { id: admin, rol: 'dueno' }, params: { id: String(g.ops[0]) } })
    assert.equal(r.url, `/alquileres/contenedores/${g.ops[0]}`)
    assert.deepEqual(r.flashes, [{ tipo: 'success', msg: 'Se anularon 2 contenedores del alquiler.' }])
  })
})
```

En `tests/alquiler-grupos-vistas.test.js`, agregar dentro del `describe`:

```js
  it('panel del grupo: botón de anular completo solo si queda alguna OP pendiente', async () => {
    const conPendiente = { ...grupoEjemplo, ops: [{ ...grupoEjemplo.ops[0], estado: 'pendiente' }, grupoEjemplo.ops[1]] }
    assert.match(await renderVista('partials/alquiler_grupo', { grupo: conPendiente, opActualId: 101 }), /anular-grupo/)
    assert.doesNotMatch(await renderVista('partials/alquiler_grupo', { grupo: grupoEjemplo, opActualId: 101 }), /anular-grupo/)
  })
```

- [ ] **Step 2: Correr las pruebas y verificar que fallan**

Run: `node --test --test-concurrency=1 tests/alquiler-grupos-acciones.test.js tests/alquiler-grupos-vistas.test.js`
Expected: FAIL (`anularGrupo is not a function`; no aparece `anular-grupo`).

- [ ] **Step 3: Modelo**

En `src/models/alquileres.model.js`, agregar después de `anular`:

```js
  // Anula todas las OP del grupo que todavía se pueden anular (pendientes o despachadas);
  // las ya entregadas siguen su curso. Devuelve cuántas anuló.
  async anularGrupo(id_op) {
    const grupo = await this.grupoDe(id_op)
    if (!grupo) throw new Error('Este alquiler no es de varios contenedores.')
    const anulables = grupo.ops.filter(o => o.estado === 'pendiente' || o.estado === 'despachado')
    for (const o of anulables) await this.anular(o.id)
    return anulables.length
  },
```

- [ ] **Step 4: Controlador y ruta**

En `src/controllers/alquileres.controller.js`, agregar después de `anular`:

```js
  async anularGrupo(req, res) {
    try {
      const n = await AlquileresModel.anularGrupo(req.params.id)
      // Si el resto ya estaba retirado y el cobro es por alquiler, se cobra ahora.
      const grupo = await AlquileresModel.grupoConCobroPorAlquiler(req.params.id)
      const monto = grupo ? await AlquileresModel.cobrarGrupo(grupo.id) : null
      req.flash('success', n
        ? `Se anularon ${n} contenedor${n === 1 ? '' : 'es'} del alquiler${monto != null ? `. Se cobró lo ya retirado por $${Math.round(monto).toLocaleString('es-AR')}` : ''}.`
        : 'No había contenedores pendientes para anular: los demás ya se entregaron.')
    } catch (err) {
      console.error(err)
      req.flash('error', err.message || 'Error al anular el alquiler.')
    }
    res.redirect(`/alquileres/contenedores/${req.params.id}`)
  },
```

En `src/routes/alquileres.routes.js`, agregar debajo de `router.post('/contenedores/:id/anular', ...)`:

```js
router.post('/contenedores/:id/anular-grupo',    auth, acceso, ctrlCont.anularGrupo)
```

- [ ] **Step 5: Botón en el panel**

En `views/partials/alquiler_grupo.ejs`, reemplazar el cierre del `card-body`:

```ejs
    <% } %>
  </div>
</div>
```

por:

```ejs
    <% } %>
    <% if (grupo.ops.some(o => o.estado === 'pendiente' || o.estado === 'despachado')) { %>
      <form action="/alquileres/contenedores/<%= opActualId %>/anular-grupo" method="POST" class="px-3 pb-3"
            onsubmit="return confirm('¿Anular todos los contenedores de este alquiler que todavía no se entregaron?')">
        <button class="btn btn-sm btn-outline-danger">❌ Anular alquiler completo</button>
      </form>
    <% } %>
  </div>
</div>
```

- [ ] **Step 6: Correr las pruebas y verificar que pasan**

Run: `npm test`
Expected: `ℹ fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/models/alquileres.model.js src/controllers/alquileres.controller.js src/routes/alquileres.routes.js views/partials/alquiler_grupo.ejs tests/alquiler-grupos-acciones.test.js tests/alquiler-grupos-vistas.test.js
git commit -m "Alquileres agrupados: anular el alquiler completo

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Editar los datos compartidos del grupo

**Files:**
- Modify: `src/models/alquileres.model.js` (helper `normDir`; `actualizar`; nuevo `actualizarCompartidosGrupo`)
- Modify: `src/controllers/alquileres.controller.js` (`actualizar`, `guardarUbicacionManual`)
- Modify: `views/pages/alquileres/editar.ejs`
- Modify: `tests/alquiler-grupos-acciones.test.js`

**Interfaces:**
- Consumes: `copiarUbicacionAlGrupo` (Tarea 4), `obtener().grupo` (Tarea 6).
- Produces: `actualizarCompartidosGrupo(id_op) → Promise<number>` (cuántas OP actualizó). Formulario de edición: check `aplicar_grupo`.

- [ ] **Step 1: Pruebas**

En `tests/alquiler-grupos-acciones.test.js`, agregar dentro del `describe`:

```js
  it('actualizarCompartidosGrupo copia dirección, obra, zona, pago y observaciones; no plazo ni precio', async () => {
    const g = await grupo()
    await prueba.q(`UPDATE op_detalle_contenedor SET precio_alquiler = 999, plazo_alquiler = 7 WHERE id_orden_pedido = ?`, [g.ops[1]])
    await AlquileresModel.guardarUbicacion(g.ops[1], { lat: -31.4, lng: -64.2, estado: 'ok' })
    await AlquileresModel.actualizar(g.ops[0], {
      calle: 'Av. Colón', numero: '100', zona_entrega: 'Centro', plazo_alquiler: 4, precio_alquiler: 100,
      metodo_pago: 'transferencia', observaciones: 'Nueva obs', fecha_entrega_planificada: '2026-09-28', obra: 'Obra X',
    })
    assert.equal(await AlquileresModel.actualizarCompartidosGrupo(g.ops[0]), 1)
    const op2 = (await prueba.q(`
      SELECT op.metodo_pago, op.observaciones, op.obra, oc.domicilio_calle, oc.domicilio_numero, oc.zona_entrega,
             oc.precio_alquiler, oc.plazo_alquiler, oc.domicilio_lat
      FROM op_encabezado op JOIN op_detalle_contenedor oc ON oc.id_orden_pedido = op.id WHERE op.id = ?`, [g.ops[1]])).rows[0]
    assert.deepEqual(op2, {
      metodo_pago: 'transferencia', observaciones: 'Nueva obs', obra: 'Obra X', domicilio_calle: 'Av. Colón',
      domicilio_numero: '100', zona_entrega: 'Centro', precio_alquiler: 999, plazo_alquiler: 7, domicilio_lat: null,
    })
  })

  it('controlador: editar con "aplicar a todos" actualiza el resto del grupo', async () => {
    const g = await grupo()
    AlquileresModel.ubicar = async () => null // sin Nominatim
    const r = await llamar('actualizar', { user: { id: admin, rol: 'dueno' }, params: { id: String(g.ops[0]) }, body: {
      calle: 'Otra calle', numero: '5', zona_entrega: '', fechaInicio: '2026-09-28', fechaFin: '2026-10-02',
      precio_alquiler: '100', metodo_pago: 'efectivo', observaciones: '', obra: '', aplicar_grupo: '1',
    } })
    assert.deepEqual(r.flashes, [{ tipo: 'success', msg: 'Alquiler actualizado (y 1 contenedor más del grupo).' }])
    const calle = (await prueba.q(`SELECT domicilio_calle FROM op_detalle_contenedor WHERE id_orden_pedido = ?`, [g.ops[1]])).rows[0].domicilio_calle
    assert.equal(calle, 'Otra calle')
  })
```

- [ ] **Step 2: Correr las pruebas y verificar que fallan**

Run: `node --test --test-concurrency=1 tests/alquiler-grupos-acciones.test.js`
Expected: FAIL (`actualizarCompartidosGrupo is not a function`; el flash no menciona el grupo).

- [ ] **Step 3: Modelo**

En `src/models/alquileres.model.js`, agregar después de `normalizarPlazo` (fuera del objeto):

```js
// Dirección normalizada para comparar si cambió (espacios y mayúsculas no cuentan).
const normDir = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase()
```

En `actualizar`, reemplazar:

```js
    const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase()
    const direccionCambio = !!previo
      && (norm(previo.domicilio_calle) !== norm(calle) || norm(previo.domicilio_numero) !== norm(numero))
```

por:

```js
    const direccionCambio = !!previo
      && (normDir(previo.domicilio_calle) !== normDir(calle) || normDir(previo.domicilio_numero) !== normDir(numero))
```

Agregar después de `actualizar`:

```js
  // Datos compartidos del alquiler agrupado (dirección, obra, zona, método de pago y
  // observaciones): los copia de esta OP a las demás OP no anuladas del grupo. Plazo,
  // precio y fechas son de cada contenedor y no se tocan. Si cambia la dirección de una
  // OP, se borran sus coordenadas (las vuelve a llenar ubicar). Devuelve cuántas actualizó.
  async actualizarCompartidosGrupo(id_op) {
    return await transaction(async (q) => {
      const src = (await q(`
        SELECT op.id_grupo, op.metodo_pago, op.observaciones, op.obra,
               oc.domicilio_entrega, oc.domicilio_calle, oc.domicilio_numero, oc.zona_entrega
        FROM op_encabezado op JOIN op_detalle_contenedor oc ON oc.id_orden_pedido = op.id
        WHERE op.id = ?
      `, [id_op])).rows[0]
      if (!src?.id_grupo) return 0
      const otras = (await q(`SELECT id FROM op_encabezado WHERE id_grupo = ? AND id <> ? AND estado <> 'anulado' ORDER BY id`,
        [src.id_grupo, id_op])).rows.map(r => r.id)
      for (const id of otras) {
        const previo = (await q(`SELECT domicilio_calle, domicilio_numero FROM op_detalle_contenedor WHERE id_orden_pedido = ?`, [id])).rows[0]
        await q(`UPDATE op_encabezado SET metodo_pago = ?, observaciones = ?, obra = ? WHERE id = ?`,
          [src.metodo_pago, src.observaciones, src.obra, id])
        await q(`
          UPDATE op_detalle_contenedor
          SET domicilio_entrega = ?, domicilio_calle = ?, domicilio_numero = ?, zona_entrega = ?, metodo_pago = ?
          WHERE id_orden_pedido = ?
        `, [src.domicilio_entrega, src.domicilio_calle, src.domicilio_numero, src.zona_entrega, src.metodo_pago, id])
        if (normDir(previo?.domicilio_calle) !== normDir(src.domicilio_calle) || normDir(previo?.domicilio_numero) !== normDir(src.domicilio_numero)) {
          await q(`UPDATE op_detalle_contenedor SET domicilio_lat = NULL, domicilio_lng = NULL, geo_estado = NULL, geo_detalle = NULL, geo_actualizado_en = NULL WHERE id_orden_pedido = ?`, [id])
        }
      }
      return otras.length
    })
  },
```

- [ ] **Step 4: Controlador**

En `actualizar`, reemplazar:

```js
      if (direccionCambio) ubicarEnSegundoPlano(req.params.id)
      req.flash('success', 'Alquiler actualizado.')
```

por:

```js
      // "Aplicar a todos": los datos compartidos pasan al resto del alquiler agrupado.
      const aplicarGrupo = req.body.aplicar_grupo === '1' || req.body.aplicar_grupo === 'on'
      const otras = aplicarGrupo ? await AlquileresModel.actualizarCompartidosGrupo(req.params.id) : 0
      // ubicar copia las coordenadas a las OP del grupo con la misma dirección
      if (direccionCambio) ubicarEnSegundoPlano(req.params.id)
      req.flash('success', otras
        ? `Alquiler actualizado (y ${otras} contenedor${otras === 1 ? '' : 'es'} más del grupo).`
        : 'Alquiler actualizado.')
```

En `guardarUbicacionManual`, reemplazar:

```js
      await AlquileresModel.guardarUbicacion(alquiler.id, { lat, lng, estado: 'manual' })
```

por:

```js
      await AlquileresModel.guardarUbicacion(alquiler.id, { lat, lng, estado: 'manual' })
      await AlquileresModel.copiarUbicacionAlGrupo(alquiler.id)
```

- [ ] **Step 5: Check en `editar.ejs`**

En `views/pages/alquileres/editar.ejs`, reemplazar:

```ejs
        <div class="col-12"><label class="form-label">Observaciones</label><textarea name="observaciones" class="form-control" rows="2"><%= alquiler.observaciones || '' %></textarea></div>
```

por:

```ejs
        <div class="col-12"><label class="form-label">Observaciones</label><textarea name="observaciones" class="form-control" rows="2"><%= alquiler.observaciones || '' %></textarea></div>
        <% if (alquiler.grupo) {
             const restantes = alquiler.grupo.ops.filter(o => o.estado !== 'anulado' && o.id !== alquiler.id).length %>
          <label class="toggle-row col-12">
            <input type="checkbox" name="aplicar_grupo" value="1" checked>
            <span>Aplicar dirección, obra, zona, método de pago y observaciones a <%= restantes === 1 ? 'el otro contenedor' : `los otros ${restantes} contenedores` %> del alquiler (plazo, precio y fechas son de cada uno)</span>
          </label>
        <% } %>
```

- [ ] **Step 6: Correr las pruebas y verificar que pasan**

Run: `npm test`
Expected: `ℹ fail 0`.

Run: `node -e "const ejs=require('ejs'),fs=require('fs');ejs.compile(fs.readFileSync('views/pages/alquileres/editar.ejs','utf8'),{filename:'views/pages/alquileres/editar.ejs'});console.log('ok')"`
Expected: `ok`.

- [ ] **Step 7: Commit**

```bash
git add src/models/alquileres.model.js src/controllers/alquileres.controller.js views/pages/alquileres/editar.ejs tests/alquiler-grupos-acciones.test.js
git commit -m "Alquileres agrupados: editar los datos compartidos para todo el grupo

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Mapa — pines superpuestos

**Files:**
- Create: `public/js/mapaUtils.js`
- Modify: `public/js/mapaContenedores.js`
- Modify: `src/controllers/alquileres.controller.js` (`mapa`: scripts)
- Create: `tests/mapa-utils.test.js`

**Interfaces:**
- Produces: `MapaUtils.separarSuperpuestos(items, radioMetros = 12) → items` con `latDibujo`/`lngDibujo` agregados (en Node: `require('../public/js/mapaUtils')`; en el navegador: `window.MapaUtils`). No modifica `lat`/`lng`.

- [ ] **Step 1: Escribir `tests/mapa-utils.test.js`**

```js
'use strict'
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { separarSuperpuestos } = require('../public/js/mapaUtils')

const metros = (a, b) => {
  const dLat = (b.latDibujo - a.lat) * 111320
  const dLng = (b.lngDibujo - a.lng) * 111320 * Math.cos(a.lat * Math.PI / 180)
  return Math.hypot(dLat, dLng)
}

describe('separarSuperpuestos', () => {
  it('un pin solo queda en su lugar', () => {
    const [it1] = separarSuperpuestos([{ id: 1, lat: -31.4, lng: -64.2 }])
    assert.deepEqual([it1.latDibujo, it1.lngDibujo], [-31.4, -64.2])
  })

  it('varios en el mismo punto se reparten a ~12 m sin perder la ubicación real', () => {
    const salida = separarSuperpuestos([1, 2, 3].map(id => ({ id, lat: -31.46, lng: -64.30 })))
    const posiciones = new Set(salida.map(it => `${it.latDibujo.toFixed(7)},${it.lngDibujo.toFixed(7)}`))
    assert.equal(posiciones.size, 3)
    for (const it of salida) {
      assert.deepEqual([it.lat, it.lng], [-31.46, -64.30])
      assert.ok(Math.abs(metros(it, it) - 12) < 0.5)
    }
  })

  it('puntos distintos no se tocan', () => {
    const salida = separarSuperpuestos([{ id: 1, lat: -31.4, lng: -64.2 }, { id: 2, lat: -31.5, lng: -64.3 }])
    for (const it of salida) assert.deepEqual([it.latDibujo, it.lngDibujo], [it.lat, it.lng])
  })
})
```

- [ ] **Step 2: Correr la prueba y verificar que falla**

Run: `node --test --test-concurrency=1 tests/mapa-utils.test.js`
Expected: FAIL con `Cannot find module '../public/js/mapaUtils'`.

- [ ] **Step 3: Crear `public/js/mapaUtils.js`**

```js
// Utilidades del mapa de contenedores (se usan en el navegador y en las pruebas con Node).
(function (raiz) {
  // Varios contenedores en el mismo punto (un alquiler agrupado, o varios en el centro del
  // mismo barrio) quedarían uno encima del otro. Se reparten en un círculo chico alrededor
  // del punto real, solo para dibujarlos: lat/lng no cambian (las usan "Cómo llegar" y el
  // encuadre del mapa).
  function separarSuperpuestos(items, radioMetros) {
    const radio = radioMetros || 12
    const grupos = new Map()
    items.forEach(it => {
      const clave = Number(it.lat).toFixed(5) + ',' + Number(it.lng).toFixed(5)
      if (!grupos.has(clave)) grupos.set(clave, [])
      grupos.get(clave).push(it)
    })
    const salida = []
    grupos.forEach(lista => {
      if (lista.length === 1) {
        salida.push(Object.assign({}, lista[0], { latDibujo: lista[0].lat, lngDibujo: lista[0].lng }))
        return
      }
      lista.forEach((it, i) => {
        const angulo = (2 * Math.PI * i) / lista.length
        const dLat = (radio * Math.cos(angulo)) / 111320
        const dLng = (radio * Math.sin(angulo)) / (111320 * Math.cos(it.lat * Math.PI / 180))
        salida.push(Object.assign({}, it, { latDibujo: it.lat + dLat, lngDibujo: it.lng + dLng }))
      })
    })
    return salida
  }

  const api = { separarSuperpuestos }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else raiz.MapaUtils = api
})(typeof window !== 'undefined' ? window : this)
```

- [ ] **Step 4: Usarlo en el mapa**

En `public/js/mapaContenedores.js`, reemplazar:

```js
    ubicados.forEach(it => {
      L.marker([it.lat, it.lng], { icon: icono(it), title: contTxt(it) })
```

por:

```js
    // Los que comparten punto (ej. un alquiler agrupado) se separan unos metros al dibujarlos.
    MapaUtils.separarSuperpuestos(ubicados).forEach(it => {
      L.marker([it.latDibujo, it.lngDibujo], { icon: icono(it), title: contTxt(it) })
```

En `src/controllers/alquileres.controller.js`, dentro de `mapa`, reemplazar:

```js
      scripts: ['/js/mapaContenedores.js'],
```

por:

```js
      scripts: ['/js/mapaUtils.js', '/js/mapaContenedores.js'],
```

- [ ] **Step 5: Verificar**

Run: `node --test --test-concurrency=1 tests/mapa-utils.test.js && node --check public/js/mapaContenedores.js && node --check public/js/mapaUtils.js`
Expected: `ℹ pass 3`; sin errores de sintaxis.

- [ ] **Step 6: Commit**

```bash
git add public/js/mapaUtils.js public/js/mapaContenedores.js src/controllers/alquileres.controller.js tests/mapa-utils.test.js
git commit -m "Mapa de contenedores: separar los pines que caen en el mismo punto

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Agrupar alquileres ya cargados por separado

**Files:**
- Modify: `src/models/alquileres.model.js` (nuevo `agruparExistentes`)
- Create: `scripts/agrupar-alquileres.js`
- Modify: `package.json` (script `agrupar:alquileres`)
- Modify: `tests/alquiler-grupos-acciones.test.js`

**Interfaces:**
- Produces: `agruparExistentes(nrosOp: number[], cobroModo = 'contenedor', { simular = false }) → Promise<{ id_grupo, ops } | { simulado: true, ops }>`; script `npm run agrupar:alquileres -- <nro_op> <nro_op> [--cobro=alquiler] [--confirmar]`.

- [ ] **Step 1: Pruebas**

En `tests/alquiler-grupos-acciones.test.js`, agregar dentro del `describe`:

```js
  it('agruparExistentes: simula, agrupa y no deja reagrupar ni mezclar clientes', async () => {
    const id_cliente = await datos.crearCliente()
    const comunes = datos.datosComunes({ id_cliente, id_administrativo: admin, fecha_inicio: '2026-09-28' })
    const [c1, c2, c3] = await datos.crearContenedores(3)
    const a = await AlquileresModel.crearEnCurso({ ...comunes, id_contenedor: c1, plazo_alquiler: 4, precio_alquiler: 100 })
    const b = await AlquileresModel.crearEnCurso({ ...comunes, id_contenedor: c2, plazo_alquiler: 4, precio_alquiler: 100 })

    const sim = await AlquileresModel.agruparExistentes([a.nro_op, b.nro_op], 'alquiler', { simular: true })
    assert.equal(sim.simulado, true)
    assert.equal((await prueba.q(`SELECT id_grupo FROM op_encabezado WHERE id = ?`, [a.id])).rows[0].id_grupo, null)

    const r = await AlquileresModel.agruparExistentes([a.nro_op, b.nro_op], 'alquiler')
    const grupos = (await prueba.q(`SELECT id_grupo FROM op_encabezado WHERE id = ANY(?::bigint[])`, [[a.id, b.id]])).rows.map(x => x.id_grupo)
    assert.deepEqual(grupos, [r.id_grupo, r.id_grupo])
    assert.equal((await AlquileresModel.grupoDe(a.id)).cobro_modo, 'alquiler')

    await assert.rejects(AlquileresModel.agruparExistentes([a.nro_op, b.nro_op]), /ya pertenece a un alquiler agrupado/)
    const otro = await datos.crearCliente()
    const c = await AlquileresModel.crearEnCurso({ ...datos.datosComunes({ id_cliente: otro, id_administrativo: admin }), id_contenedor: c3, plazo_alquiler: 4, precio_alquiler: 100 })
    const d = await AlquileresModel.crear({ ...comunes, id_contenedor: null, plazo_alquiler: 4, precio_alquiler: 100 })
    await assert.rejects(AlquileresModel.agruparExistentes([c.nro_op, d.nro_op]), /clientes distintos/)
  })
```

- [ ] **Step 2: Correr la prueba y verificar que falla**

Run: `node --test --test-concurrency=1 tests/alquiler-grupos-acciones.test.js`
Expected: FAIL con `agruparExistentes is not a function`.

- [ ] **Step 3: Modelo**

En `src/models/alquileres.model.js`, agregar después de `anularGrupo`:

```js
  // Agrupa alquileres YA cargados por separado en un alquiler agrupado (ej. dos alquileres
  // idénticos cargados a mano antes de que existiera esta opción). Solo alquileres de
  // contenedor del mismo cliente, sin anular, sin grupo y sin cobrar. Con simular = true
  // hace todas las validaciones y no escribe nada.
  async agruparExistentes(nrosOp, cobroModo = 'contenedor', { simular = false } = {}) {
    const nros = [...new Set((nrosOp || []).map(n => parseInt(n, 10)).filter(Number.isFinite))]
    if (nros.length < 2) throw new Error('Indicá al menos dos N° de OP para agrupar.')
    return await transaction(async (q) => {
      const ops = (await q(`
        SELECT op.id, op.nro_op, op.id_cliente, op.estado, op.id_grupo, op.tipo_op,
               EXISTS (SELECT 1 FROM transacciones t WHERE t.id_op_encabezado = op.id) AS cobrada
        FROM op_encabezado op WHERE op.nro_op = ANY(?::int[]) ORDER BY op.id FOR UPDATE
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
      const resumen = ops.map(o => ({ id: o.id, nro_op: o.nro_op }))
      if (simular) return { simulado: true, ops: resumen }
      const { id } = (await q(`INSERT INTO alquiler_grupos (cobro_modo) VALUES (?) RETURNING id`,
        [cobroModo === 'alquiler' ? 'alquiler' : 'contenedor'])).rows[0]
      await q(`UPDATE op_encabezado SET id_grupo = ? WHERE id = ANY(?::bigint[])`, [id, ops.map(o => o.id)])
      return { id_grupo: id, ops: resumen }
    })
  },
```

- [ ] **Step 4: Script `scripts/agrupar-alquileres.js`**

```js
'use strict'
// Agrupa alquileres de contenedor ya cargados por separado en un solo alquiler agrupado.
//
// Uso:
//   npm run agrupar:alquileres -- 251 252                → simula (no escribe nada)
//   npm run agrupar:alquileres -- 251 252 --confirmar    → agrupa (cobro por contenedor)
//   npm run agrupar:alquileres -- 251 252 --cobro=alquiler --confirmar
//
// Escribe en la base del .env (producción): correrlo con --confirmar solo con OK.

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })
const { pool } = require('../src/config/db')
const AlquileresModel = require('../src/models/alquileres.model')

const args = process.argv.slice(2)
const nros = args.filter(a => /^\d+$/.test(a)).map(Number)
const cobro = (args.find(a => a.startsWith('--cobro=')) || '--cobro=contenedor').split('=')[1]
const confirmar = args.includes('--confirmar')

async function main() {
  if (!['contenedor', 'alquiler'].includes(cobro)) throw new Error('--cobro tiene que ser "contenedor" o "alquiler".')
  const r = await AlquileresModel.agruparExistentes(nros, cobro, { simular: !confirmar })
  const lista = r.ops.map(o => 'OP-' + String(o.nro_op).padStart(4, '0')).join(', ')
  console.log(confirmar
    ? `Agrupadas ${lista} (grupo ${r.id_grupo}, cobro por ${cobro}).`
    : `Simulación OK: se agruparían ${lista} con cobro por ${cobro}. Repetir con --confirmar para aplicarlo.`)
}

main()
  .catch(e => { console.error('No se agrupó nada:', e.message); process.exitCode = 1 })
  .finally(() => pool.end())
```

En `package.json`, agregar en `"scripts"`:

```json
    "agrupar:alquileres": "node scripts/agrupar-alquileres.js",
```

- [ ] **Step 5: Correr las pruebas y verificar que pasan**

Run: `npm test`
Expected: `ℹ fail 0`.

Run: `node --check scripts/agrupar-alquileres.js`
Expected: sin salida.

- [ ] **Step 6: Commit**

```bash
git add src/models/alquileres.model.js scripts/agrupar-alquileres.js package.json tests/alquiler-grupos-acciones.test.js
git commit -m "Alquileres: script para agrupar alquileres ya cargados por separado

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Release B (Fase 3)

- [ ] **Step 1: Verificación completa** — mismos comandos que la Tarea 11, Step 1. Expected: todo en verde.
- [ ] **Step 2: Revisión de la rama** (skill `superpowers:requesting-code-review`) sobre lo agregado en la Fase 3.
- [ ] **Step 3: Merge y push con OK del usuario** — mismos comandos que la Tarea 11, Step 3 (mensaje: `Merge feat/alquiler-multi-contenedor (fase 3)`).
- [ ] **Step 4: Agrupar el caso real (lo ejecuta el usuario)** — preguntarle el modo de cobro para Lanfranconi (OP-0251 y OP-0252) y pasarle los comandos: `npm run agrupar:alquileres -- 251 252 --cobro=<modo>` (simulación) y, si da OK, el mismo con `--confirmar`. Verificar después (solo lectura) con `SELECT nro_op, id_grupo FROM op_encabezado WHERE nro_op IN (251, 252)`.
