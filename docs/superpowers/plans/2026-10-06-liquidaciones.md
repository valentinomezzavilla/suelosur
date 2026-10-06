# Liquidaciones Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pantalla `/liquidaciones` + PDF que muestran todas las operaciones (ventas y alquileres) de un cliente —o de todos— con detalle, estado de pago y totales, para compartir con el cliente. Además, filtro por N° de operación en Transacciones.

**Architecture:** Lógica pura en `src/utils/liquidaciones.js` (estado de pago, totales, agrupado, filtros); el modelo `src/models/liquidaciones.model.js` hace las consultas y arma la estructura con esa lógica; controlador + vista + PDF consumen la estructura. Sin migraciones. Se reutiliza: `importesVenta` (ventas.model), imputación FIFO de la cuenta corriente (clientes.model), `nombreObra` / `obraPorClave` (obras), `pdfBrand`, `buscarCliente.js`, `filtroObra.js`.

**Tech Stack:** Node.js + Express, PostgreSQL (`pg`, helper `query` con `?`), EJS + Bootstrap 5, SCSS (sass), pdfkit, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-06-liquidaciones-design.md`

## Global Constraints

- **No hay base de desarrollo: `.env` apunta a PRODUCCIÓN.** Las pruebas contra la base usan SIEMPRE `tests/helpers/db` (transacción + ROLLBACK), requerido ANTES que cualquier modelo. No correr `npm run dev` mientras se trabaja (nodemon corre `initDB` contra prod en cada guardado).
- Sin migraciones ni cambios de esquema.
- Roles con acceso: `dueno` y `admin_contable`.
- Las operaciones `anulado` no entran nunca.
- Alquiler de contenedor con `precio_alquiler IS NULL` → estado `a_convenir`, leyenda "Precio a convenir", no suma a ningún total.
- Fecha de la operación: `COALESCE(op.fecha_entrega_planificada, op.fecha_emision)` (la misma del Libro de ventas).
- Default de fechas: primer y último día del mes actual en hora de Argentina (`hoyISO()`).
- Leyenda del pie del PDF, literal: `Los pagos se imputan a las operaciones más antiguas. Ante cualquier diferencia, comuníquese con administración.`
- N° de liquidación: `LIQ-AAAAMMDD-<id cliente con 4 dígitos>`; sin cliente `LIQ-AAAAMMDD-GRAL`. No se guarda.
- Nombre del PDF: `liquidacion-<cliente-o-general>-<desde>-<hasta>.pdf`.
- `GET /cobranzas` sigue redirigiendo a `/clientes/cuentas`. Contenedores → Cobranzas (Asignar precio) no se toca.
- Textos de la UI en español rioplatense, como el resto del sistema. Comentarios del código en español, densidad como el código vecino.
- Los ids BIGINT vuelven como `number`: comparar con `String(a) === String(b)`.
- Correr las pruebas con `node --test --test-concurrency=1 <archivo>`.

## Review Focus

1. **Alquiler agrupado con cobro "todo junto"** (`alquiler_grupos.cobro_modo = 'alquiler'`): el cargo de CC y la transacción de contado están anclados a UNA OP del grupo; las demás OPs no deben aparecer como "Pendiente" si el grupo está pagado → se reparte lo pagado del grupo en proporción al total de cada OP (pruebas en Task 1; verificación contra datos reales en Task 2, Step 8).
2. **Cliente sin operaciones en el período**: la pantalla y el PDF muestran "Sin operaciones en el período" con totales en cero, sin romper (prueba en Task 2, Task 3 y Task 4).
3. **Venta con total pactado editado a mano** (`monto_total` ≠ productos + flete): aparece el renglón "Ajuste de precio" y el total de la operación es el pactado (prueba en Task 1).
4. **Pago de más / saldo a favor**: lo pagado de una operación nunca supera su total y la resta nunca es negativa (prueba en Task 1).
5. **Filtros de URL manipulados** (`desde=hola`, `tipos=xxx`, `estadoPago=raro`, `clienteId=999999`): se ignoran y se usan los defaults; cliente inexistente → aviso y vista general (prueba en Task 1 y Task 4).

---

## File Structure

| Archivo | Acción | Responsabilidad |
|---|---|---|
| `src/utils/liquidaciones.js` | Crear | Lógica pura: filtros, tipo de operación, estado de pago, reparto de grupo, totales, agrupado, N° de liquidación |
| `tests/liquidaciones.test.js` | Crear | Pruebas unitarias de lo anterior |
| `src/models/clientes.model.js` | Modificar | Nuevo `pagadoPorOperacion(opIds)`; `saldadaPorOperacion` pasa a usarlo |
| `src/models/alquileres.model.js` | Modificar | Exportar `SQL_FECHA_CIERRE_OP` y `SQL_MOV_ALQUILER_OP` |
| `src/models/liquidaciones.model.js` | Crear | Consultas y armado de `{ clientes, resumen }` |
| `tests/liquidaciones-modelo.test.js` | Crear | Pruebas contra la base con ROLLBACK |
| `src/utils/pdfLiquidacion.js` | Crear | PDF |
| `tests/liquidaciones-pdf.test.js` | Crear | El PDF se genera sin errores |
| `src/controllers/liquidaciones.controller.js` | Crear | Pantalla y PDF |
| `src/routes/liquidaciones.routes.js` | Crear | `GET /`, `GET /pdf` |
| `views/pages/liquidaciones/index.ejs` | Crear | Pantalla |
| `views/partials/liquidacion_operacion.ejs` | Crear | Tarjeta de una operación (se repite con y sin cliente) |
| `src/scss/pages/_liquidaciones.scss` | Crear | Estilos |
| `src/scss/main.scss` | Modificar | Importar el parcial nuevo |
| `src/app.js` | Modificar | Montar la ruta; destino del rol contable |
| `src/routes/auth.routes.js` | Modificar | Destino del rol contable al loguearse |
| `views/partials/sidebar.ejs` | Modificar | Cobranzas → Liquidaciones |
| `tests/liquidaciones-vistas.test.js` | Crear | Render de la vista |
| `src/models/transacciones.model.js`, `src/controllers/transacciones.controller.js`, `views/pages/transacciones/index.ejs` | Modificar | Filtro por N° de OP en Transacciones |
| `tests/transacciones-filtro.test.js` | Crear | Pruebas del filtro por N° de OP |

## Estructura de datos (contrato entre tareas)

```js
// Operación ya armada (la produce el modelo, la consumen vista y PDF)
{
  id: 1983, nro_op: 308, nro_remito: 1234,
  fecha: '2026-10-06',                       // YYYY-MM-DD
  tipo: 'viaje',                             // 'cantera' | 'viaje' | 'contenedor' | 'maquinaria'
  tipoTexto: 'Venta con viaje',
  obra: 'San Lorenzo 501',                   // nombreObra(...) — '' si no tiene
  metodo_pago: 'efectivo',
  metodoTexto: 'Efectivo',
  id_cliente: 42, id_grupo: null,
  renglones: [ { descripcion, cantidad, unidad, precio_unit, importe } ],
  total: 252000, pagado: 252000, resta: 0,
  estado: 'pagada',                          // 'pagada' | 'parcial' | 'pendiente' | 'a_convenir'
}

// Resultado de LiquidacionesModel.liquidacion(filtros)
{
  clientes: [ {
    cliente: { id, numero, nombreCompleto, dni, telefono, direccion, email },
    operaciones: [Operacion],
    pagos: [ { fecha, metodoTexto, descripcion, monto } ] | null,   // null = sección oculta
    resumen: { consumido, pagado, saldo, cantidad },
    porObra: [ { nombre, resumen } ],        // [] si no corresponde
  } ],
  resumen: { consumido, pagado, saldo, cantidad },
}
```

---

### Task 1: Lógica pura de liquidaciones

**Files:**
- Create: `src/utils/liquidaciones.js`
- Test: `tests/liquidaciones.test.js`

**Interfaces:**
- Consumes: nada.
- Produces (todo exportado):
  - `TIPOS`: `{ cantera: 'Venta en cantera', viaje: 'Venta con viaje', contenedor: 'Alquiler de contenedor', maquinaria: 'Alquiler de maquinaria' }`
  - `ESTADOS`: `{ pagada: 'Pagada', parcial: 'Parcial', pendiente: 'Pendiente', a_convenir: 'Precio a convenir' }`
  - `METODOS`: `{ efectivo: 'Efectivo', transferencia: 'Transferencia', cheque: 'Cheque', cuenta_corriente: 'Cuenta corriente', saldo_a_favor: 'Saldo a favor', a_convenir: 'A convenir' }`
  - `rangoMes(hoy: 'YYYY-MM-DD') → { desde, hasta }`
  - `normalizarFiltros(q: object, hoy: string) → { clienteId: string|null, obra: string|null, desde, hasta, tipos: string[], estadoPago: 'todas'|'pendientes'|'pagadas' }`
  - `tipoDeOperacion({ tipo_op, modalidad }) → 'cantera'|'viaje'|'contenedor'|'maquinaria'|null`
  - `estadoPago({ total, aConvenir, metodoPago, cobrado, cc }) → { pagado, resta, estado }` — `cobrado`: suma cobrada por transacciones de contado; `cc`: `{ total, pagado }` o `undefined`
  - `repartirGrupos(ops) → ops` (in-place y devuelve el array) — ops con `{ id, id_grupo, grupoTodoJunto, total, pagado, resta, estado, aConvenir, _sinRegistroPago }`
  - `filtrarPorEstado(ops, estadoPago) → ops`
  - `resumir(ops) → { consumido, pagado, saldo, cantidad }`
  - `agruparPor(ops, claveFn, nombreFn) → [{ clave, nombre, operaciones, resumen }]` ordenado por nombre
  - `nroLiquidacion(hoy, clienteId|null) → string`
  - `diasEntre(desde, hasta) → number` (mínimo 1)

- [ ] **Step 1: Escribir las pruebas que fallan**

`tests/liquidaciones.test.js`:

```js
'use strict'
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const L = require('../src/utils/liquidaciones')

describe('rangoMes / normalizarFiltros', () => {
  it('rango del mes de la fecha dada', () => {
    assert.deepEqual(L.rangoMes('2026-10-06'), { desde: '2026-10-01', hasta: '2026-10-31' })
    assert.deepEqual(L.rangoMes('2024-02-10'), { desde: '2024-02-01', hasta: '2024-02-29' })
  })
  it('sin parámetros: todo por defecto', () => {
    assert.deepEqual(L.normalizarFiltros({}, '2026-10-06'), {
      clienteId: null, obra: null, desde: '2026-10-01', hasta: '2026-10-31',
      tipos: ['cantera', 'viaje', 'contenedor', 'maquinaria'], estadoPago: 'todas',
    })
  })
  it('respeta valores válidos (tipos como string o array)', () => {
    const f = L.normalizarFiltros({ clienteId: '42', obra: 'colon 100', desde: '2026-01-01', hasta: '2026-03-31', tipos: 'viaje', estadoPago: 'pendientes' }, '2026-10-06')
    assert.deepEqual(f, { clienteId: '42', obra: 'colon 100', desde: '2026-01-01', hasta: '2026-03-31', tipos: ['viaje'], estadoPago: 'pendientes' })
    assert.deepEqual(L.normalizarFiltros({ tipos: ['cantera', 'maquinaria'] }, '2026-10-06').tipos, ['cantera', 'maquinaria'])
  })
  it('ignora valores manipulados y usa los defaults', () => {
    const f = L.normalizarFiltros({ clienteId: 'abc', desde: 'hola', hasta: '2026-13-45', tipos: ['xxx'], estadoPago: 'raro' }, '2026-10-06')
    assert.deepEqual(f, {
      clienteId: null, obra: null, desde: '2026-10-01', hasta: '2026-10-31',
      tipos: ['cantera', 'viaje', 'contenedor', 'maquinaria'], estadoPago: 'todas',
    })
  })
  it('la obra solo vale con cliente', () => {
    assert.equal(L.normalizarFiltros({ obra: 'colon 100' }, '2026-10-06').obra, null)
  })
})

describe('tipoDeOperacion', () => {
  it('distingue los cuatro tipos', () => {
    assert.equal(L.tipoDeOperacion({ tipo_op: 'M', modalidad: 'flete' }), 'viaje')
    assert.equal(L.tipoDeOperacion({ tipo_op: 'M', modalidad: 'retiro' }), 'cantera')
    assert.equal(L.tipoDeOperacion({ tipo_op: 'M', modalidad: null }), 'cantera')
    assert.equal(L.tipoDeOperacion({ tipo_op: 'C' }), 'contenedor')
    assert.equal(L.tipoDeOperacion({ tipo_op: 'MA' }), 'maquinaria')
    assert.equal(L.tipoDeOperacion({ tipo_op: 'X' }), null)
  })
})

describe('estadoPago', () => {
  it('precio a convenir: no suma nada', () => {
    assert.deepEqual(L.estadoPago({ total: 0, aConvenir: true, metodoPago: null }), { pagado: 0, resta: 0, estado: 'a_convenir' })
  })
  it('contado cobrado = pagada; sin cobro = pendiente', () => {
    assert.deepEqual(L.estadoPago({ total: 1000, metodoPago: 'efectivo', cobrado: 1000 }), { pagado: 1000, resta: 0, estado: 'pagada' })
    assert.deepEqual(L.estadoPago({ total: 1000, metodoPago: 'transferencia', cobrado: 0 }), { pagado: 0, resta: 1000, estado: 'pendiente' })
  })
  it('a convenir (método) y sin método se tratan como contado', () => {
    assert.equal(L.estadoPago({ total: 500, metodoPago: 'a_convenir', cobrado: 500 }).estado, 'pagada')
    assert.equal(L.estadoPago({ total: 500, metodoPago: null, cobrado: 0 }).estado, 'pendiente')
  })
  it('saldo a favor: pagada en el momento', () => {
    assert.deepEqual(L.estadoPago({ total: 800, metodoPago: 'saldo_a_favor' }), { pagado: 800, resta: 0, estado: 'pagada' })
  })
  it('cuenta corriente: según la imputación FIFO', () => {
    assert.deepEqual(L.estadoPago({ total: 1000, metodoPago: 'cuenta_corriente', cc: { total: 1000, pagado: 400 } }), { pagado: 400, resta: 600, estado: 'parcial' })
    assert.deepEqual(L.estadoPago({ total: 1000, metodoPago: 'cuenta_corriente', cc: { total: 1000, pagado: 1000 } }), { pagado: 1000, resta: 0, estado: 'pagada' })
    assert.deepEqual(L.estadoPago({ total: 1000, metodoPago: 'cuenta_corriente', cc: undefined }), { pagado: 0, resta: 1000, estado: 'pendiente' })
  })
  it('nunca paga de más ni deja resta negativa', () => {
    assert.deepEqual(L.estadoPago({ total: 1000, metodoPago: 'efectivo', cobrado: 1500 }), { pagado: 1000, resta: 0, estado: 'pagada' })
    assert.deepEqual(L.estadoPago({ total: 1000, metodoPago: 'cuenta_corriente', cc: { total: 1000, pagado: 1200 } }), { pagado: 1000, resta: 0, estado: 'pagada' })
  })
  it('diferencias de centavos cuentan como pagada', () => {
    assert.equal(L.estadoPago({ total: 1000, metodoPago: 'cuenta_corriente', cc: { total: 1000, pagado: 999.995 } }).estado, 'pagada')
  })
})

describe('repartirGrupos', () => {
  it('grupo "todo junto": las OPs sin registro propio toman lo pagado del grupo en proporción', () => {
    const ops = [
      { id: 1, id_grupo: 7, grupoTodoJunto: true, total: 3000, pagado: 0, resta: 0, estado: 'pendiente', _sinRegistroPago: false, _pagadoGrupo: 2000, _totalGrupo: 4000 },
      { id: 2, id_grupo: 7, grupoTodoJunto: true, total: 1000, pagado: 0, resta: 1000, estado: 'pendiente', _sinRegistroPago: true },
    ]
    // La OP 1 tiene el cargo de todo el grupo (4000) con 2000 pagados → 50 %
    L.repartirGrupos(ops)
    assert.deepEqual(ops.map(o => [o.pagado, o.resta, o.estado]), [[1500, 1500, 'parcial'], [500, 500, 'parcial']])
  })
  it('grupo pagado completo → todas pagadas', () => {
    const ops = [
      { id: 1, id_grupo: 7, grupoTodoJunto: true, total: 3000, pagado: 0, resta: 0, estado: 'pendiente', _sinRegistroPago: false, _pagadoGrupo: 4000, _totalGrupo: 4000 },
      { id: 2, id_grupo: 7, grupoTodoJunto: true, total: 1000, pagado: 0, resta: 1000, estado: 'pendiente', _sinRegistroPago: true },
    ]
    L.repartirGrupos(ops)
    assert.deepEqual(ops.map(o => o.estado), ['pagada', 'pagada'])
  })
  it('no toca OPs sin grupo ni grupos que se cobran por contenedor', () => {
    const ops = [
      { id: 3, id_grupo: null, total: 100, pagado: 0, resta: 100, estado: 'pendiente', _sinRegistroPago: true },
      { id: 4, id_grupo: 8, grupoTodoJunto: false, total: 100, pagado: 0, resta: 100, estado: 'pendiente', _sinRegistroPago: true },
    ]
    L.repartirGrupos(ops)
    assert.deepEqual(ops.map(o => o.estado), ['pendiente', 'pendiente'])
  })
  it('las OPs a convenir del grupo siguen a convenir', () => {
    const ops = [
      { id: 1, id_grupo: 7, grupoTodoJunto: true, total: 1000, pagado: 0, resta: 0, estado: 'pendiente', _sinRegistroPago: false, _pagadoGrupo: 1000, _totalGrupo: 1000 },
      { id: 2, id_grupo: 7, grupoTodoJunto: true, aConvenir: true, total: 0, pagado: 0, resta: 0, estado: 'a_convenir', _sinRegistroPago: true },
    ]
    L.repartirGrupos(ops)
    assert.deepEqual(ops.map(o => o.estado), ['pagada', 'a_convenir'])
  })
})

describe('filtrarPorEstado / resumir / agruparPor', () => {
  const ops = [
    { id: 1, total: 1000, pagado: 1000, resta: 0, estado: 'pagada', obra: 'Colón 100', id_cliente: 1 },
    { id: 2, total: 500, pagado: 200, resta: 300, estado: 'parcial', obra: 'colon 100', id_cliente: 1 },
    { id: 3, total: 300, pagado: 0, resta: 300, estado: 'pendiente', obra: 'Vélez 10', id_cliente: 2 },
    { id: 4, total: 0, pagado: 0, resta: 0, estado: 'a_convenir', obra: '', id_cliente: 2 },
  ]
  it('filtra por estado de pago', () => {
    assert.deepEqual(L.filtrarPorEstado(ops, 'todas').map(o => o.id), [1, 2, 3, 4])
    assert.deepEqual(L.filtrarPorEstado(ops, 'pendientes').map(o => o.id), [2, 3])
    assert.deepEqual(L.filtrarPorEstado(ops, 'pagadas').map(o => o.id), [1])
  })
  it('resume sin contar las a convenir', () => {
    assert.deepEqual(L.resumir(ops), { consumido: 1800, pagado: 1200, saldo: 600, cantidad: 4 })
    assert.deepEqual(L.resumir([]), { consumido: 0, pagado: 0, saldo: 0, cantidad: 0 })
  })
  it('agrupa por una clave y ordena por nombre', () => {
    const g = L.agruparPor(ops.slice(0, 3), o => o.obra.toLowerCase().replace('ó', 'o'), o => o.obra)
    assert.deepEqual(g.map(x => [x.nombre, x.operaciones.length, x.resumen.saldo]), [['Colón 100', 2, 300], ['Vélez 10', 1, 300]])
  })
})

describe('nroLiquidacion / diasEntre', () => {
  it('arma el número informativo', () => {
    assert.equal(L.nroLiquidacion('2026-10-06', 42), 'LIQ-20261006-0042')
    assert.equal(L.nroLiquidacion('2026-10-06', null), 'LIQ-20261006-GRAL')
  })
  it('días entre fechas, mínimo 1', () => {
    assert.equal(L.diasEntre('2026-10-01', '2026-10-06'), 5)
    assert.equal(L.diasEntre('2026-10-01', '2026-10-01 18:00:00'), 1)
  })
})
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `node --test --test-concurrency=1 tests/liquidaciones.test.js`
Expected: FAIL con `Cannot find module '../src/utils/liquidaciones'`

- [ ] **Step 3: Implementar**

`src/utils/liquidaciones.js`:

```js
'use strict'
// Liquidaciones: lógica pura (sin base). Estado de pago de cada operación, totales,
// agrupados y filtros. Ver docs/superpowers/specs/2026-10-06-liquidaciones-design.md

const TIPOS = {
  cantera:    'Venta en cantera',
  viaje:      'Venta con viaje',
  contenedor: 'Alquiler de contenedor',
  maquinaria: 'Alquiler de maquinaria',
}
const ESTADOS = { pagada: 'Pagada', parcial: 'Parcial', pendiente: 'Pendiente', a_convenir: 'Precio a convenir' }
const METODOS = {
  efectivo: 'Efectivo', transferencia: 'Transferencia', cheque: 'Cheque',
  cuenta_corriente: 'Cuenta corriente', saldo_a_favor: 'Saldo a favor', a_convenir: 'A convenir',
}
const ESTADOS_FILTRO = ['todas', 'pendientes', 'pagadas']
const CENTAVO = 0.01

const redondear = (n) => Math.round((Number(n) || 0) * 100) / 100
const fechaValida = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(new Date(s + 'T00:00:00').getTime())
  && new Date(s + 'T00:00:00').toISOString().slice(0, 10) === s

function rangoMes(hoy) {
  const [a, m] = hoy.split('-').map(Number)
  const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate()
  const mm = String(m).padStart(2, '0')
  return { desde: `${a}-${mm}-01`, hasta: `${a}-${mm}-${String(ultimo).padStart(2, '0')}` }
}

// Filtros de la URL → filtros limpios. Lo inválido se ignora (vale el default).
function normalizarFiltros(q = {}, hoy) {
  const mes = rangoMes(hoy)
  const clienteId = /^\d+$/.test(String(q.clienteId || '').trim()) ? String(q.clienteId).trim() : null
  const obra = clienteId && String(q.obra || '').trim() ? String(q.obra).trim() : null
  const pedidos = (Array.isArray(q.tipos) ? q.tipos : [q.tipos]).filter(t => Object.hasOwn(TIPOS, t))
  return {
    clienteId,
    obra,
    desde: fechaValida(q.desde) ? q.desde : mes.desde,
    hasta: fechaValida(q.hasta) ? q.hasta : mes.hasta,
    tipos: pedidos.length ? Object.keys(TIPOS).filter(t => pedidos.includes(t)) : Object.keys(TIPOS),
    estadoPago: ESTADOS_FILTRO.includes(q.estadoPago) ? q.estadoPago : 'todas',
  }
}

function tipoDeOperacion({ tipo_op, modalidad }) {
  if (tipo_op === 'M') return modalidad === 'flete' ? 'viaje' : 'cantera'
  if (tipo_op === 'C') return 'contenedor'
  if (tipo_op === 'MA') return 'maquinaria'
  return null
}

function estadoDe(total, pagado) {
  if (total - pagado <= CENTAVO) return 'pagada'
  return pagado > CENTAVO ? 'parcial' : 'pendiente'
}

// cobrado: lo cobrado por transacciones de contado de la operación.
// cc: { total, pagado } del cargo en cuenta corriente (imputación FIFO), o undefined si no hay cargo.
function estadoPago({ total, aConvenir, metodoPago, cobrado = 0, cc }) {
  if (aConvenir) return { pagado: 0, resta: 0, estado: 'a_convenir' }
  const t = redondear(total)
  let pagado
  if (metodoPago === 'saldo_a_favor') pagado = t
  else if (metodoPago === 'cuenta_corriente') pagado = cc ? Number(cc.pagado) || 0 : 0
  else pagado = Number(cobrado) || 0
  pagado = redondear(Math.min(Math.max(pagado, 0), t))
  const estado = estadoDe(t, pagado)
  return { pagado: estado === 'pagada' ? t : pagado, resta: estado === 'pagada' ? 0 : redondear(t - pagado), estado }
}

// Alquiler agrupado con cobro "todo junto": el cargo / cobro es uno para todo el grupo y
// está anclado a una OP (la que trae _pagadoGrupo y _totalGrupo). Lo pagado del grupo se
// reparte entre sus OPs en proporción a su total.
function repartirGrupos(ops) {
  const anclas = new Map()
  for (const o of ops) {
    if (o.grupoTodoJunto && o.id_grupo != null && o._totalGrupo > 0) anclas.set(String(o.id_grupo), o._pagadoGrupo / o._totalGrupo)
  }
  for (const o of ops) {
    if (!o.grupoTodoJunto || o.aConvenir || o.estado === 'a_convenir') continue
    const proporcion = anclas.get(String(o.id_grupo))
    if (proporcion == null) continue
    const t = redondear(o.total)
    const pagado = redondear(Math.min(t, t * proporcion))
    o.estado = estadoDe(t, pagado)
    o.pagado = o.estado === 'pagada' ? t : pagado
    o.resta = o.estado === 'pagada' ? 0 : redondear(t - pagado)
  }
  return ops
}

function filtrarPorEstado(ops, estadoPago) {
  if (estadoPago === 'pendientes') return ops.filter(o => o.estado === 'pendiente' || o.estado === 'parcial')
  if (estadoPago === 'pagadas') return ops.filter(o => o.estado === 'pagada')
  return ops
}

function resumir(ops) {
  const cuentan = ops.filter(o => o.estado !== 'a_convenir')
  const suma = (k) => redondear(cuentan.reduce((s, o) => s + (Number(o[k]) || 0), 0))
  return { consumido: suma('total'), pagado: suma('pagado'), saldo: suma('resta'), cantidad: ops.length }
}

// El nombre que se muestra es el de la primera operación del grupo.
function agruparPor(ops, claveFn, nombreFn) {
  const grupos = new Map()
  for (const o of ops) {
    const clave = claveFn(o)
    if (!grupos.has(clave)) grupos.set(clave, { clave, nombre: nombreFn(o), operaciones: [] })
    grupos.get(clave).operaciones.push(o)
  }
  return [...grupos.values()]
    .map(g => ({ ...g, resumen: resumir(g.operaciones) }))
    .sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), 'es'))
}

function nroLiquidacion(hoy, clienteId) {
  const fecha = String(hoy).replace(/-/g, '')
  return `LIQ-${fecha}-${clienteId != null ? String(clienteId).padStart(4, '0') : 'GRAL'}`
}

function diasEntre(desde, hasta) {
  const d = (s) => new Date(String(s).slice(0, 10) + 'T00:00:00Z').getTime()
  return Math.max(1, Math.round((d(hasta) - d(desde)) / 86400000))
}

module.exports = {
  TIPOS, ESTADOS, METODOS,
  rangoMes, normalizarFiltros, tipoDeOperacion, estadoPago, repartirGrupos,
  filtrarPorEstado, resumir, agruparPor, nroLiquidacion, diasEntre,
}
```

- [ ] **Step 4: Correr y verificar que pasa**

Run: `node --test --test-concurrency=1 tests/liquidaciones.test.js`
Expected: PASS, todas las pruebas.

- [ ] **Step 5: Commit**

```bash
git add src/utils/liquidaciones.js tests/liquidaciones.test.js
git commit -m "Liquidaciones: lógica de estado de pago, totales y filtros"
```

---

### Task 2: Modelo de liquidaciones (consultas)

**Files:**
- Modify: `src/models/clientes.model.js` (`saldadaPorOperacion`, ~línea 199-250)
- Modify: `src/models/alquileres.model.js` (final del archivo, `module.exports`)
- Create: `src/models/liquidaciones.model.js`
- Test: `tests/liquidaciones-modelo.test.js`

**Interfaces:**
- Consumes: todo `src/utils/liquidaciones.js` (Task 1); `importesVenta` de `ventas.model`; `nombreObra`, `claveObra` de `utils/obras`; `ClientesModel.obraPorClave(clienteId, clave)`; `nombreClienteSQL` de `utils/nombreCliente`.
- Produces:
  - `ClientesModel.pagadoPorOperacion(opIds) → { [idOp]: { total, pagado } }` (solo OPs con cargo en CC)
  - `AlquileresModel.SQL_FECHA_CIERRE_OP`, `AlquileresModel.SQL_MOV_ALQUILER_OP` (strings SQL; usan alias `oc`)
  - `LiquidacionesModel.liquidacion(filtros) → { clientes, resumen }` (forma en "Estructura de datos"); `filtros` = salida de `normalizarFiltros`. Si `clienteId` no existe → `{ clientes: [], resumen: resumir([]), clienteInexistente: true }`.

- [ ] **Step 1: Escribir las pruebas que fallan**

`tests/liquidaciones-modelo.test.js`:

```js
'use strict'
// Liquidaciones contra la base, dentro de la transacción de prueba (ROLLBACK al final).
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const VentasModel = require('../src/models/ventas.model')
const ClientesModel = require('../src/models/clientes.model')
const TransaccionesModel = require('../src/models/transacciones.model')
const LiquidacionesModel = require('../src/models/liquidaciones.model')
const { normalizarFiltros } = require('../src/utils/liquidaciones')

const HOY = '2026-10-06'
const filtros = (extra = {}) => normalizarFiltros({ desde: '2026-10-01', hasta: '2026-10-31', ...extra }, HOY)

describe('LiquidacionesModel.liquidacion', () => {
  let cliente, admin, producto, contado, cc, sinPrecio

  before(async () => {
    await prueba.abrir()
    admin = await datos.idAdministrativo()
    cliente = await datos.crearCliente({ cuentaCorriente: true })
    producto = (await prueba.q(`SELECT id FROM productos WHERE COALESCE(es_contenedor,0)=0 ORDER BY id LIMIT 1`)).rows[0].id
    const base = { id_cliente: cliente, id_administrativo: admin, tipo_op: 'M', modalidad: 'flete',
      fecha_entrega_planificada: '2026-10-05', domicilio: { calle: 'Colón', altura: '100' }, obra: null }

    // 1) Venta de contado cobrada: 1000 de producto + 200 de flete
    contado = (await VentasModel.crear({ ...base, metodo_pago: 'efectivo', precio_flete: 200, monto_total: 1200,
      detalles: [{ id_producto: producto, cantidad_pedida: 2, precio_unitario: 500 }] })).id
    await TransaccionesModel.crear({ tipo: 'Venta Viaje', id_op_encabezado: contado, cliente_id: cliente, cliente: 'PRUEBA',
      monto: 1200, descripcion: 'prueba', metodo_pago: 'efectivo', fecha: '2026-10-05' })

    // 2) Venta a cuenta corriente, total pactado editado (ajuste), con pago parcial
    cc = (await VentasModel.crear({ ...base, metodo_pago: 'cuenta_corriente', precio_flete: 0, monto_total: 900,
      obra: 'Obra Vélez 10', detalles: [{ id_producto: producto, cantidad_pedida: 1, precio_unitario: 1000 }] })).id
    await VentasModel.sincronizarCargoCC(cc)
    await ClientesModel.agregarMovimiento(cliente, { tipo: 'pago', descripcion: 'Pago prueba', monto: 400, metodo_pago: 'transferencia' })

    // 3) Alquiler de contenedor sin precio
    const [idCont] = await datos.crearContenedores(1)
    sinPrecio = (await prueba.q(`
      INSERT INTO op_encabezado (id_cliente, id_administrativo, tipo_op, nro_op, estado, fecha_entrega_planificada)
      VALUES (?, ?, 'C', 999999, 'pendiente', '2026-10-04') RETURNING id`, [cliente, admin])).rows[0].id
    await prueba.q(`INSERT INTO op_detalle_contenedor (id_orden_pedido, id_contenedor, domicilio_entrega, precio_alquiler)
      VALUES (?, ?, 'San Martín 55', NULL)`, [sinPrecio, idCont])
  })
  after(() => prueba.cerrar())

  const delCliente = async (extra) => {
    const r = await LiquidacionesModel.liquidacion(filtros({ clienteId: String(cliente), ...extra }))
    assert.equal(r.clientes.length, 1)
    return r.clientes[0]
  }
  const op = (c, id) => c.operaciones.find(o => String(o.id) === String(id))

  it('trae las tres operaciones con su estado de pago', async () => {
    const c = await delCliente()
    assert.deepEqual(c.operaciones.map(o => String(o.id)).sort(), [contado, cc, sinPrecio].map(String).sort())
    assert.deepEqual([op(c, contado).estado, op(c, cc).estado, op(c, sinPrecio).estado], ['pagada', 'parcial', 'a_convenir'])
    assert.equal(op(c, cc).pagado, 400)
    assert.equal(op(c, cc).resta, 500)
  })

  it('detalle: productos, flete y ajuste del total pactado', async () => {
    const c = await delCliente()
    assert.deepEqual(op(c, contado).renglones.map(r => [r.cantidad, r.importe]), [[2, 1000], [1, 200]])
    assert.equal(op(c, contado).renglones[1].descripcion, 'Flete')
    const ajuste = op(c, cc).renglones.find(r => r.descripcion === 'Ajuste de precio')
    assert.equal(ajuste.importe, -100)
    assert.equal(op(c, cc).total, 900)
    assert.equal(op(c, sinPrecio).renglones[0].descripcion.includes('Precio a convenir'), true)
  })

  it('resumen: sin contar el alquiler a convenir', async () => {
    const c = await delCliente()
    assert.deepEqual(c.resumen, { consumido: 2100, pagado: 1600, saldo: 500, cantidad: 3 })
  })

  it('pagos recibidos del período (sin obra): el abono de CC y el cobro de contado', async () => {
    // El abono se registra con la fecha real de hoy: el período llega lejos para incluirlo
    const c = await delCliente({ hasta: '2099-12-31' })
    assert.deepEqual(c.pagos.map(p => p.monto).sort((a, b) => a - b), [400, 1200])
  })

  it('con obra: solo esa obra y sin sección de pagos', async () => {
    const obras = await ClientesModel.obras(cliente)
    const velez = obras.find(o => o.nombre === 'Vélez 10')
    const c = await delCliente({ obra: velez.clave })
    assert.deepEqual(c.operaciones.map(o => String(o.id)), [String(cc)])
    assert.equal(c.pagos, null)
  })

  it('filtra por tipo y por estado de pago', async () => {
    assert.deepEqual((await delCliente({ tipos: 'contenedor' })).operaciones.map(o => String(o.id)), [String(sinPrecio)])
    assert.deepEqual((await delCliente({ estadoPago: 'pendientes' })).operaciones.map(o => String(o.id)), [String(cc)])
    assert.deepEqual((await delCliente({ estadoPago: 'pagadas' })).operaciones.map(o => String(o.id)), [String(contado)])
  })

  it('fuera del período: sin operaciones y totales en cero', async () => {
    const r = await LiquidacionesModel.liquidacion(normalizarFiltros({ clienteId: String(cliente), desde: '2020-01-01', hasta: '2020-01-31' }, HOY))
    assert.deepEqual(r.clientes[0].operaciones, [])
    assert.deepEqual(r.clientes[0].resumen, { consumido: 0, pagado: 0, saldo: 0, cantidad: 0 })
  })

  it('sin cliente: incluye al cliente de prueba entre todos, sin pagos', async () => {
    const r = await LiquidacionesModel.liquidacion(filtros())
    const c = r.clientes.find(x => String(x.cliente.id) === String(cliente))
    assert.ok(c)
    assert.equal(c.pagos, null)
    assert.ok(r.resumen.consumido >= 2100)
  })

  it('cliente inexistente', async () => {
    const r = await LiquidacionesModel.liquidacion(filtros({ clienteId: '999999999' }))
    assert.equal(r.clienteInexistente, true)
    assert.deepEqual(r.clientes, [])
  })

  it('pagadoPorOperacion devuelve total y pagado del cargo', async () => {
    const r = await ClientesModel.pagadoPorOperacion([cc, contado])
    assert.deepEqual(r[cc], { total: 900, pagado: 400 })
    assert.equal(r[contado], undefined)
    assert.deepEqual(await ClientesModel.saldadaPorOperacion([cc]), { [cc]: false })
  })
})
```

> Nota para el implementador: antes de correrla, confirmar en `src/models/ventas.model.js` que `sincronizarCargoCC(id)` crea el cargo de una venta `cuenta_corriente` pendiente (el controlador `crearViaje` lo usa así) y en `tests/helpers/datos.js` las firmas de `crearCliente` / `crearContenedores`. Si el `nro_op` 999999 choca con una restricción única, usar `(SELECT ${SQL_SIGUIENTE_NRO_OP})` de `src/utils/numeracion`.

- [ ] **Step 2: Correr y verificar que falla**

Run: `node --test --test-concurrency=1 tests/liquidaciones-modelo.test.js`
Expected: FAIL con `Cannot find module '../src/models/liquidaciones.model'`

- [ ] **Step 3: `pagadoPorOperacion` en clientes.model.js**

Reemplazar el cuerpo de `saldadaPorOperacion` (desde `async saldadaPorOperacion(opIds) {` hasta su `},`) por estos dos métodos. La lógica FIFO es la misma de antes, movida a `pagadoPorOperacion`:

```js
  // Cargo en cuenta corriente de cada operación y cuánto se le imputó: { [id_op]: { total, pagado } }.
  // No hay un vínculo pago↔venta explícito: los pagos se aplican en orden FIFO contra las
  // deudas más antiguas del cliente, igual que ya refleja el saldo corrido de estadoCuenta().
  // Solo trae las operaciones que tienen cargo.
  async pagadoPorOperacion(opIds) {
    const ids = [...new Set((opIds || []).filter(Boolean))]
    if (!ids.length) return {}
    const ph = ids.map(() => '?').join(',')

    const clientesIds = (await query(
      `SELECT DISTINCT cliente_id FROM movimientos_cuenta WHERE id_op_encabezado IN (${ph})`, ids
    )).rows.map(r => r.cliente_id)
    if (!clientesIds.length) return {}

    const movs = (await query(
      `SELECT cliente_id, id_op_encabezado, monto, tipo FROM movimientos_cuenta
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
      // 'uso_saldo_favor' se paga en el momento con crédito ya acumulado: no es una
      // deuda pendiente, así que no entra en la cola (si entrara, quedaría esperando
      // para siempre un pago futuro que no va a llegar).
      if (monto < 0 && m.tipo !== 'uso_saldo_favor') {
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
      if (d) resultado[id] = { total: Math.round(d.total * 100) / 100, pagado: Math.round(d.pagado * 100) / 100 }
    }
    return resultado
  },

  // ¿El cliente ya saldó cada operación? { [id_op_encabezado]: boolean } (sin cargo = saldada).
  async saldadaPorOperacion(opIds) {
    const ids = [...new Set((opIds || []).filter(Boolean))]
    const pagos = await this.pagadoPorOperacion(ids)
    const resultado = {}
    for (const id of ids) {
      const d = pagos[id]
      resultado[id] = d ? d.pagado >= d.total - 1e-6 : true
    }
    return resultado
  },
```

Cuidado: dejar intacto el comentario previo a `saldadaPorOperacion` solo si sigue describiendo bien; si no, reemplazarlo por los de arriba (no duplicar comentarios).

- [ ] **Step 4: Exportar los fragmentos SQL de alquileres**

Al final de `src/models/alquileres.model.js`, debajo de `module.exports = AlquileresModel`:

```js
// Fragmentos SQL que reusa la liquidación (usan el alias oc = op_detalle_contenedor)
module.exports.SQL_FECHA_CIERRE_OP = SQL_FECHA_CIERRE_OP
module.exports.SQL_MOV_ALQUILER_OP = SQL_MOV_ALQUILER_OP
```

- [ ] **Step 5: Implementar el modelo**

`src/models/liquidaciones.model.js`:

```js
'use strict'
// ═══════════════════════════════════════════════════════════════════
// liquidaciones.model.js — Operaciones de un cliente (o de todos) con su detalle,
// estado de pago y totales. La lógica de pago y totales está en utils/liquidaciones.
// ═══════════════════════════════════════════════════════════════════
const { query } = require('../config/db')
const { importesVenta } = require('./ventas.model')
const ClientesModel = require('./clientes.model')
const { SQL_FECHA_CIERRE_OP, SQL_MOV_ALQUILER_OP } = require('./alquileres.model')
const { nombreClienteSQL } = require('../utils/nombreCliente')
const { SQL_DESCRIPCION_DETALLE, SQL_UNIDAD_DETALLE } = require('../utils/contenedor')
const { nombreObra, claveObra } = require('../utils/obras')
const { fmtFecha } = require('../utils/fecha')
const L = require('../utils/liquidaciones')

// Fecha de la operación: la de entrega planificada; si falta, la de emisión (= Libro de ventas)
const FECHA = `LEFT(COALESCE(op.fecha_entrega_planificada, op.fecha_emision), 10)`
const TIPO_OP = { cantera: 'M', viaje: 'M', contenedor: 'C', maquinaria: 'MA' }

async function operacionesBase({ clienteId, desde, hasta, tipos, opIds }) {
  const cond = [`op.estado <> 'anulado'`, `op.id_cliente IS NOT NULL`, `${FECHA} >= ?`, `${FECHA} <= ?`,
    `op.tipo_op = ANY(?)`]
  const params = [desde, hasta, [...new Set(tipos.map(t => TIPO_OP[t]))]]
  if (clienteId) { cond.push('op.id_cliente = ?'); params.push(clienteId) }
  if (opIds)     { cond.push('op.id = ANY(?::bigint[])'); params.push(opIds.map(Number)) }
  return (await query(`
    SELECT op.id, op.nro_op, op.nro_remito, op.tipo_op, op.modalidad, op.id_cliente, op.id_grupo,
           ${FECHA} AS fecha, op.obra, op.domicilio_calle, op.domicilio_altura,
           op.precio_flete, op.monto_total,
           COALESCE(op.metodo_pago, oc.metodo_pago, om.metodo_pago) AS metodo_pago,
           (ag.cobro_modo = 'alquiler') AS grupo_todo_junto,
           oc.id AS oc_id, oc.precio_alquiler, oc.domicilio_entrega AS cont_entrega,
           oc.domicilio_calle AS cont_calle, oc.domicilio_numero AS cont_numero, oc.plazo_alquiler,
           cont.numero_contenedor,
           COALESCE(NULLIF(LEFT(op.fecha_entrega_planificada, 10), ''), LEFT(ma.fecha_alquiler, 10)) AS cont_desde,
           LEFT(${SQL_FECHA_CIERRE_OP}, 10) AS cont_hasta,
           om.horas_pactadas, om.precio_por_hora, om.precio_total AS maq_total,
           om.domicilio_entrega AS maq_entrega, om.domicilio_calle AS maq_calle, om.domicilio_numero AS maq_numero,
           maq.nombre AS maquina
    FROM op_encabezado op
    LEFT JOIN LATERAL (SELECT * FROM op_detalle_contenedor d WHERE d.id_orden_pedido = op.id ORDER BY d.id LIMIT 1) oc ON TRUE
    LEFT JOIN contenedores cont ON cont.id = oc.id_contenedor
    LEFT JOIN (${SQL_MOV_ALQUILER_OP}) ma ON ma.id_op_contenedor = oc.id
    LEFT JOIN LATERAL (SELECT * FROM op_detalle_maquinaria d WHERE d.id_orden_pedido = op.id ORDER BY d.id LIMIT 1) om ON TRUE
    LEFT JOIN maquinaria maq ON maq.id = om.id_maquinaria
    LEFT JOIN alquiler_grupos ag ON ag.id = op.id_grupo
    WHERE ${cond.join(' AND ')}
    ORDER BY ${FECHA} ASC, op.nro_op ASC
  `, params)).rows
}

async function renglonesMaterial(ids) {
  if (!ids.length) return {}
  const rows = (await query(`
    SELECT d.id_orden_pedido, ${SQL_DESCRIPCION_DETALLE} AS descripcion, ${SQL_UNIDAD_DETALLE} AS unidad,
           d.cantidad_pedida AS cantidad, d.precio_unitario AS precio_unit,
           (d.cantidad_pedida * d.precio_unitario) AS importe
    FROM op_detalle_material d JOIN productos p ON p.id = d.id_producto
    WHERE d.id_orden_pedido = ANY(?::bigint[])
    ORDER BY d.id
  `, [ids.map(Number)])).rows
  const porOp = {}
  rows.forEach(r => (porOp[r.id_orden_pedido] ||= []).push({
    descripcion: r.descripcion, unidad: r.unidad || '', cantidad: Number(r.cantidad) || 0,
    precio_unit: Number(r.precio_unit) || 0, importe: Number(r.importe) || 0,
  }))
  return porOp
}

// Cobrado por transacciones de contado (las de método cuenta_corriente son cargos, no plata)
async function cobradoContado(ids) {
  if (!ids.length) return {}
  const rows = (await query(`
    SELECT id_op_encabezado AS id, SUM(monto) AS cobrado FROM transacciones
    WHERE id_op_encabezado = ANY(?::bigint[]) AND metodo_pago <> 'cuenta_corriente' AND tipo <> 'Ajuste'
    GROUP BY id_op_encabezado
  `, [ids.map(Number)])).rows
  return Object.fromEntries(rows.map(r => [r.id, Number(r.cobrado) || 0]))
}

// Arma una operación: detalle según el tipo y total
function armar(r, materiales) {
  const tipo = L.tipoDeOperacion(r)
  const op = {
    id: r.id, nro_op: r.nro_op, nro_remito: r.nro_remito, fecha: r.fecha, tipo, tipoTexto: L.TIPOS[tipo],
    obra: nombreObra(r), id_cliente: r.id_cliente, id_grupo: r.id_grupo, grupoTodoJunto: !!r.grupo_todo_junto,
    metodo_pago: r.metodo_pago, metodoTexto: L.METODOS[r.metodo_pago] || 'Sin definir',
    aConvenir: false, renglones: [], total: 0,
  }
  if (r.tipo_op === 'M') {
    op.renglones = [...(materiales[r.id] || [])]
    const subtotal = op.renglones.reduce((s, x) => s + x.importe, 0)
    const { flete, ajuste, total } = importesVenta(r, subtotal)
    if (flete)  op.renglones.push({ descripcion: 'Flete', unidad: '', cantidad: 1, precio_unit: flete, importe: flete })
    if (ajuste) op.renglones.push({ descripcion: 'Ajuste de precio', unidad: '', cantidad: 1, precio_unit: ajuste, importe: ajuste })
    op.total = total
  } else if (r.tipo_op === 'C') {
    const desde = r.cont_desde, hasta = r.cont_hasta
    const dias = desde && hasta ? L.diasEntre(desde, hasta) : Number(r.plazo_alquiler) || 1
    const periodo = desde ? ` — ${fmtFecha(desde)} al ${hasta ? fmtFecha(hasta) : 'en curso'}` : ''
    const base = `Alquiler contenedor${r.numero_contenedor != null ? ' N° ' + r.numero_contenedor : ''}${periodo}`
    if (r.precio_alquiler == null) {
      op.aConvenir = true
      op.renglones = [{ descripcion: `${base} · Precio a convenir`, unidad: 'días', cantidad: dias, precio_unit: 0, importe: 0 }]
    } else {
      const total = Number(r.precio_alquiler) || 0
      op.renglones = [{ descripcion: base, unidad: 'días', cantidad: dias, precio_unit: Math.round(total / dias * 100) / 100, importe: total }]
      op.total = total
    }
  } else if (r.tipo_op === 'MA') {
    const total = Number(r.maq_total) || 0
    op.renglones = [{ descripcion: r.maquina || 'Maquinaria', unidad: 'h', cantidad: Number(r.horas_pactadas) || 0,
      precio_unit: Number(r.precio_por_hora) || 0, importe: total }]
    op.total = total
  }
  return op
}

async function pagosDelCliente(clienteId, { desde, hasta }) {
  const cc = (await query(`
    SELECT LEFT(created_at, 10) AS fecha, metodo_pago, descripcion, monto FROM movimientos_cuenta
    WHERE cliente_id = ? AND tipo = 'pago' AND LEFT(created_at, 10) BETWEEN ? AND ?
  `, [clienteId, desde, hasta])).rows
  const contado = (await query(`
    SELECT LEFT(fecha, 10) AS fecha, metodo_pago, descripcion, monto FROM transacciones
    WHERE cliente_id = ? AND metodo_pago <> 'cuenta_corriente' AND tipo <> 'Ajuste' AND LEFT(fecha, 10) BETWEEN ? AND ?
  `, [clienteId, desde, hasta])).rows
  return [...cc, ...contado]
    .map(p => ({ fecha: p.fecha, metodoTexto: L.METODOS[p.metodo_pago] || '—', descripcion: p.descripcion || '', monto: Number(p.monto) || 0 }))
    .sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)))
}

async function datosClientes(ids) {
  if (!ids.length) return {}
  const rows = (await query(`
    SELECT id, numero, dni, email, COALESCE(telefono, tel_whatsapp) AS telefono, domicilio_ppal AS direccion,
           COALESCE(${nombreClienteSQL('c')}, 'Particular') AS nombre_completo
    FROM clientes c WHERE id = ANY(?::bigint[])
  `, [ids.map(Number)])).rows
  return Object.fromEntries(rows.map(r => [r.id, {
    id: r.id, numero: r.numero, nombreCompleto: r.nombre_completo, dni: r.dni || '', telefono: r.telefono || '',
    direccion: r.direccion || '', email: r.email || '',
  }]))
}

const LiquidacionesModel = {
  // filtros: salida de normalizarFiltros (utils/liquidaciones)
  async liquidacion({ clienteId, obra, desde, hasta, tipos, estadoPago }) {
    if (clienteId) {
      const existe = (await query(`SELECT 1 FROM clientes WHERE id = ?`, [clienteId])).rowCount
      if (!existe) return { clientes: [], resumen: L.resumir([]), clienteInexistente: true }
    }
    const obraElegida = clienteId && obra ? await ClientesModel.obraPorClave(clienteId, obra) : null

    const filas = await operacionesBase({ clienteId, desde, hasta, tipos, opIds: obraElegida ? obraElegida.opIds : null })
    // cantera y viaje comparten tipo_op 'M': se separan acá
    const pedidas = filas.filter(r => tipos.includes(L.tipoDeOperacion(r)))
    const ids = pedidas.map(r => r.id)
    const [materiales, cobrado, cc] = await Promise.all([
      renglonesMaterial(pedidas.filter(r => r.tipo_op === 'M').map(r => r.id)),
      cobradoContado(ids),
      ClientesModel.pagadoPorOperacion(ids),
    ])

    let ops = pedidas.map(r => {
      const op = armar(r, materiales)
      Object.assign(op, L.estadoPago({ total: op.total, aConvenir: op.aConvenir, metodoPago: op.metodo_pago, cobrado: cobrado[op.id], cc: cc[op.id] }))
      // Grupo "todo junto": la OP que tiene el cargo / cobro del grupo es el ancla del reparto
      const registro = op.metodo_pago === 'cuenta_corriente' ? cc[op.id] : (cobrado[op.id] != null ? { total: null, pagado: cobrado[op.id] } : null)
      op._sinRegistroPago = !registro
      if (op.grupoTodoJunto && registro) {
        op._pagadoGrupo = registro.pagado
        op._totalGrupo = registro.total != null ? registro.total : pedidas.filter(x => String(x.id_grupo) === String(op.id_grupo)).reduce((s, x) => s + (Number(x.precio_alquiler) || 0), 0)
      }
      return op
    })
    L.repartirGrupos(ops)
    ops.forEach(o => { delete o._sinRegistroPago; delete o._pagadoGrupo; delete o._totalGrupo })
    ops = L.filtrarPorEstado(ops, estadoPago)

    const fichas = await datosClientes(clienteId ? [clienteId] : [...new Set(ops.map(o => o.id_cliente))])
    const grupos = clienteId
      ? [{ clave: String(clienteId), operaciones: ops }]
      : L.agruparPor(ops, o => String(o.id_cliente), o => fichas[o.id_cliente]?.nombreCompleto || '')

    const clientes = []
    for (const g of grupos) {
      const id = clienteId || g.operaciones[0].id_cliente
      const porObra = L.agruparPor(g.operaciones.filter(o => o.obra), o => claveObra(o.obra), o => o.obra)
      clientes.push({
        cliente: fichas[id],
        operaciones: g.operaciones,
        pagos: clienteId && !obraElegida ? await pagosDelCliente(clienteId, { desde, hasta }) : null,
        resumen: L.resumir(g.operaciones),
        porObra: !obraElegida && porObra.length > 1 ? porObra.map(o => ({ nombre: o.nombre, resumen: o.resumen })) : [],
      })
    }
    return { clientes, resumen: L.resumir(ops), obra: obraElegida ? obraElegida.nombre : null }
  },
}

module.exports = LiquidacionesModel
```

- [ ] **Step 6: Correr y verificar que pasa**

Run: `node --test --test-concurrency=1 tests/liquidaciones-modelo.test.js`
Expected: PASS. Si falla por un dato de esquema (columna inexistente), corregir la consulta según `src/config/db.js`, no la prueba.

- [ ] **Step 7: Verificar que nada de lo existente se rompió**

Run: `node --test --test-concurrency=1 tests/liquidaciones.test.js tests/obras.test.js tests/alquiler-sin-precio.test.js tests/alquiler-grupos-cobro.test.js`
Expected: PASS (estos usan `saldadaPorOperacion` y la cuenta corriente).

- [ ] **Step 8: Comprobar el caso de grupo contra datos reales (solo lectura)**

Run:
```bash
node -e "
require('dotenv').config(); const {query,pool}=require('./src/config/db');
query(\"SELECT op.id_grupo, op.id, m.id AS cargo FROM op_encabezado op JOIN alquiler_grupos ag ON ag.id=op.id_grupo AND ag.cobro_modo='alquiler' LEFT JOIN movimientos_cuenta m ON m.id_op_encabezado=op.id AND m.tipo='deuda' ORDER BY op.id_grupo, op.id LIMIT 20\").then(r=>{console.table(r.rows);pool.end()})"
```
Expected: en cada grupo, un solo `cargo` no nulo (el ancla). Si hubiera más de uno por grupo, `_totalGrupo` debe sumar los cargos: avisar antes de seguir.

- [ ] **Step 9: Commit**

```bash
git add src/models/liquidaciones.model.js src/models/clientes.model.js src/models/alquileres.model.js tests/liquidaciones-modelo.test.js
git commit -m "Liquidaciones: modelo con operaciones, detalle, estado de pago y pagos"
```

---

### Task 3: PDF de la liquidación

**Files:**
- Create: `src/utils/pdfLiquidacion.js`
- Test: `tests/liquidaciones-pdf.test.js`

**Interfaces:**
- Consumes: estructura `{ clientes, resumen, obra }` de `LiquidacionesModel.liquidacion` (Task 2); `pdfBrand` (`drawHeader(doc, { titulo, derecha })` → y, `money(n)`, colores `AZUL NARANJA GRIS TINTA ROJO VERDE LINEA FONDO`); `fmtFecha`, `hoyISO`, `ahoraLocal`, `fmtFechaHora` de `utils/fecha`; `nroLiquidacion`, `ESTADOS` de `utils/liquidaciones`.
- Produces: `generarLiquidacionPDF(res, { liquidacion, filtros, general: boolean })` — escribe el PDF en `res` (stream); `nombreArchivoLiquidacion(liquidacion, filtros) → string` (sin `.pdf`).

- [ ] **Step 1: Escribir la prueba que falla**

`tests/liquidaciones-pdf.test.js`:

```js
'use strict'
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { PassThrough } = require('stream')
const { generarLiquidacionPDF, nombreArchivoLiquidacion } = require('../src/utils/pdfLiquidacion')

// res simulado: un stream que junta los bytes y guarda los headers
function resFalso() {
  const s = new PassThrough()
  const partes = []
  s.headers = {}
  s.setHeader = (k, v) => { s.headers[k] = v }
  s.on('data', (c) => partes.push(c))
  s.terminado = new Promise((ok) => s.on('end', () => ok(Buffer.concat(partes))))
  return s
}

const op = (id, extra = {}) => ({
  id, nro_op: 300 + id, nro_remito: 1000 + id, fecha: '2026-10-05', tipo: 'viaje', tipoTexto: 'Venta con viaje',
  obra: 'Colón 100', metodo_pago: 'efectivo', metodoTexto: 'Efectivo', id_cliente: 1,
  renglones: [{ descripcion: 'Arena fina', unidad: 'm³', cantidad: 2, precio_unit: 500, importe: 1000 },
              { descripcion: 'Flete', unidad: '', cantidad: 1, precio_unit: 200, importe: 200 }],
  total: 1200, pagado: 1200, resta: 0, estado: 'pagada', ...extra,
})
const cliente = { id: 1, numero: 42, nombreCompleto: 'ARQ LUCAS RODRIGUEZ', dni: '30111222', telefono: '351 000 0000', direccion: 'Colón 100', email: '' }
const filtros = { clienteId: '1', obra: null, desde: '2026-10-01', hasta: '2026-10-31', tipos: ['cantera', 'viaje', 'contenedor', 'maquinaria'], estadoPago: 'todas' }

describe('generarLiquidacionPDF', () => {
  it('con cliente: genera un PDF con muchas operaciones (varias páginas)', async () => {
    const ops = Array.from({ length: 25 }, (_, i) => op(i + 1, i % 3 ? {} : { estado: 'parcial', pagado: 600, resta: 600 }))
    const liquidacion = {
      clientes: [{ cliente, operaciones: ops, resumen: { consumido: 30000, pagado: 25000, saldo: 5000, cantidad: 25 },
        pagos: [{ fecha: '2026-10-05', metodoTexto: 'Efectivo', descripcion: 'Cobro', monto: 1200 }],
        porObra: [{ nombre: 'Colón 100', resumen: { consumido: 20000, pagado: 15000, saldo: 5000, cantidad: 20 } },
                  { nombre: 'Vélez 10', resumen: { consumido: 10000, pagado: 10000, saldo: 0, cantidad: 5 } }] }],
      resumen: { consumido: 30000, pagado: 25000, saldo: 5000, cantidad: 25 }, obra: null,
    }
    const res = resFalso()
    generarLiquidacionPDF(res, { liquidacion, filtros, general: false })
    const pdf = await res.terminado
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
    assert.equal(res.headers['Content-Type'], 'application/pdf')
    assert.match(res.headers['Content-Disposition'], /liquidacion-arq-lucas-rodriguez-2026-10-01-2026-10-31\.pdf/)
    assert.ok((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length >= 2)
  })

  it('sin operaciones: igual genera el PDF', async () => {
    const liquidacion = { clientes: [{ cliente, operaciones: [], resumen: { consumido: 0, pagado: 0, saldo: 0, cantidad: 0 }, pagos: [], porObra: [] }],
      resumen: { consumido: 0, pagado: 0, saldo: 0, cantidad: 0 }, obra: null }
    const res = resFalso()
    generarLiquidacionPDF(res, { liquidacion, filtros, general: false })
    assert.equal((await res.terminado).subarray(0, 5).toString(), '%PDF-')
  })

  it('general (sin cliente) con dos clientes y a convenir', async () => {
    const otro = { ...cliente, id: 2, nombreCompleto: 'MARIO COMPANY' }
    const liquidacion = {
      clientes: [
        { cliente, operaciones: [op(1)], resumen: { consumido: 1200, pagado: 1200, saldo: 0, cantidad: 1 }, pagos: null, porObra: [] },
        { cliente: otro, operaciones: [op(2, { tipo: 'contenedor', tipoTexto: 'Alquiler de contenedor', estado: 'a_convenir', total: 0, pagado: 0, resta: 0,
          renglones: [{ descripcion: 'Alquiler contenedor N° 12 · Precio a convenir', unidad: 'días', cantidad: 5, precio_unit: 0, importe: 0 }] })],
          resumen: { consumido: 0, pagado: 0, saldo: 0, cantidad: 1 }, pagos: null, porObra: [] },
      ],
      resumen: { consumido: 1200, pagado: 1200, saldo: 0, cantidad: 2 }, obra: null,
    }
    const res = resFalso()
    generarLiquidacionPDF(res, { liquidacion, filtros: { ...filtros, clienteId: null }, general: true })
    assert.equal((await res.terminado).subarray(0, 5).toString(), '%PDF-')
    assert.match(res.headers['Content-Disposition'], /liquidacion-general-2026-10-01-2026-10-31\.pdf/)
  })
})

describe('nombreArchivoLiquidacion', () => {
  it('normaliza el nombre del cliente', () => {
    assert.equal(nombreArchivoLiquidacion({ clientes: [{ cliente: { nombreCompleto: 'José Pérez S.A.' } }] }, filtros), 'liquidacion-jose-perez-s-a-2026-10-01-2026-10-31')
  })
})
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `node --test --test-concurrency=1 tests/liquidaciones-pdf.test.js`
Expected: FAIL con `Cannot find module '../src/utils/pdfLiquidacion'`

- [ ] **Step 3: Implementar**

`src/utils/pdfLiquidacion.js`:

```js
'use strict'
// ─────────────────────────────────────────────────────────────────
// pdfLiquidacion.js — Liquidación para compartir con el cliente: ficha, resumen,
// cada operación con su detalle y estado de pago, resumen por obra y pagos.
// Sin cliente ("Liquidación general"): resumen por cliente y cada cliente en página nueva.
// ─────────────────────────────────────────────────────────────────
const PDFDocument = require('pdfkit')
const B = require('./pdfBrand')
const { fmtFecha, hoyISO } = require('./fecha')
const { nroLiquidacion, ESTADOS } = require('./liquidaciones')

const LEYENDA = 'Los pagos se imputan a las operaciones más antiguas. Ante cualquier diferencia, comuníquese con administración.'
const COLOR_ESTADO = { pagada: B.VERDE, parcial: B.NARANJA, pendiente: B.ROJO, a_convenir: B.GRIS }
const PIE = 34 // alto reservado para el pie de página

const slug = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

function nombreArchivoLiquidacion(liquidacion, filtros) {
  const quien = filtros.clienteId && liquidacion.clientes[0] ? slug(liquidacion.clientes[0].cliente.nombreCompleto) : 'general'
  return `liquidacion-${quien}-${filtros.desde}-${filtros.hasta}`
}

function generarLiquidacionPDF(res, { liquidacion, filtros, general }) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true })
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `inline; filename="${nombreArchivoLiquidacion(liquidacion, filtros)}.pdf"`)
  doc.pipe(res)

  const left = doc.page.margins.left
  const right = doc.page.width - doc.page.margins.right
  const width = right - left
  const limite = () => doc.page.height - doc.page.margins.bottom - PIE
  const hoy = hoyISO()
  const periodo = `${fmtFecha(filtros.desde)} al ${fmtFecha(filtros.hasta)}`
  let y

  const encabezado = (titulo) => {
    const derecha = [
      { label: 'N°', valor: nroLiquidacion(hoy, general ? null : filtros.clienteId), bold: true, color: B.TINTA },
      { label: 'Período', valor: periodo },
      { label: 'Emitida', valor: fmtFecha(hoy) },
    ]
    if (liquidacion.obra) derecha.push({ label: 'Obra', valor: liquidacion.obra, color: B.TINTA })
    y = B.drawHeader(doc, { titulo, derecha })
  }
  const nuevaPagina = (titulo) => { doc.addPage(); encabezado(titulo) }
  const asegurar = (alto, titulo) => { if (y + alto > limite()) nuevaPagina(titulo) }

  // ── Bloques ────────────────────────────────────────────────────
  function ficha(c) {
    doc.fillColor(B.GRIS).fontSize(8).font('Helvetica-Bold').text('CLIENTE', left, y)
    doc.fillColor(B.TINTA).fontSize(14).font('Helvetica-Bold').text(c.nombreCompleto, left, y + 11, { width })
    const datos = [c.numero != null && `Cliente N° ${c.numero}`, c.dni && `DNI ${c.dni}`, c.telefono && `Tel. ${c.telefono}`,
      c.direccion, c.email].filter(Boolean).join('   ·   ')
    doc.fillColor(B.GRIS).fontSize(8.5).font('Helvetica').text(datos || ' ', left, y + 30, { width })
    y += 48
  }

  function tarjetasResumen(r) {
    const cajas = [
      { label: 'TOTAL CONSUMIDO', valor: B.money(r.consumido), color: B.TINTA },
      { label: 'PAGADO', valor: B.money(r.pagado), color: B.VERDE },
      { label: 'SALDO PENDIENTE', valor: B.money(r.saldo), color: r.saldo > 0.005 ? B.ROJO : B.VERDE },
    ]
    const gap = 10, w = (width - gap * 2) / 3, h = 46
    cajas.forEach((c, i) => {
      const x = left + i * (w + gap)
      doc.roundedRect(x, y, w, h, 4).fillAndStroke(B.FONDO, B.LINEA)
      doc.fillColor(B.GRIS).fontSize(7.5).font('Helvetica-Bold').text(c.label, x + 10, y + 9, { width: w - 20 })
      doc.fillColor(c.color).fontSize(15).font('Helvetica-Bold').text(c.valor, x + 10, y + 21, { width: w - 20 })
    })
    y += h + 8
    doc.fillColor(B.GRIS).fontSize(8).font('Helvetica')
       .text(`${r.cantidad} operación${r.cantidad === 1 ? '' : 'es'} en el período`, left, y)
    y += 18
  }

  // Columnas de la tabla de detalle
  const COLS = [
    { key: 'descripcion', header: 'Detalle', w: 0.46, align: 'left' },
    { key: 'cantidad', header: 'Cant.', w: 0.1, align: 'right' },
    { key: 'unidad', header: 'Unid.', w: 0.1, align: 'left' },
    { key: 'precio_unit', header: 'P. unit.', w: 0.16, align: 'right', money: true },
    { key: 'importe', header: 'Importe', w: 0.18, align: 'right', money: true },
  ]
  const valor = (c, r) => c.money ? B.money(r[c.key]) : c.key === 'cantidad' ? Number(r.cantidad).toLocaleString('es-AR') : String(r[c.key] ?? '')
  const altoRenglon = (r) => Math.max(14, doc.font('Helvetica').fontSize(8.5).heightOfString(r.descripcion, { width: COLS[0].w * width - 8 }) + 5)
  const altoOperacion = (o) => 24 + 16 + o.renglones.reduce((s, r) => s + altoRenglon(r), 0) + 34

  function operacion(o, tituloPagina) {
    // Una operación no se corta entre páginas, salvo que no entre en una página entera
    const alto = altoOperacion(o)
    if (alto < limite() - 120) asegurar(alto, tituloPagina)

    // Barra de título
    doc.rect(left, y, width, 22).fill(B.AZUL)
    const titulo = [`OP-${String(o.nro_op).padStart(4, '0')}`, o.nro_remito && `Remito ${o.nro_remito}`, fmtFecha(o.fecha), o.tipoTexto,
      o.obra && `Obra: ${o.obra}`].filter(Boolean).join('  ·  ')
    doc.fillColor('#ffffff').fontSize(8.5).font('Helvetica-Bold').text(titulo, left + 8, y + 7, { width: width - 110, lineBreak: false, ellipsis: true })
    const etiqueta = ESTADOS[o.estado].toUpperCase()
    doc.roundedRect(right - 96, y + 4, 90, 14, 7).fill('#ffffff')
    doc.fillColor(COLOR_ESTADO[o.estado]).fontSize(7).font('Helvetica-Bold').text(etiqueta, right - 96, y + 8, { width: 90, align: 'center' })
    y += 24

    // Encabezado de la tabla
    doc.rect(left, y, width, 15).fill(B.FONDO)
    let x = left
    doc.fillColor(B.GRIS).fontSize(7).font('Helvetica-Bold')
    COLS.forEach(c => { doc.text(c.header.toUpperCase(), x + 4, y + 4, { width: c.w * width - 8, align: c.align }); x += c.w * width })
    y += 16

    // Renglones
    o.renglones.forEach(r => {
      const h = altoRenglon(r)
      if (y + h > limite()) { nuevaPagina(tituloPagina) }
      x = left
      doc.fillColor(B.TINTA).fontSize(8.5).font('Helvetica')
      COLS.forEach(c => { doc.text(valor(c, r), x + 4, y + 3, { width: c.w * width - 8, align: c.align }); x += c.w * width })
      y += h
      doc.moveTo(left, y).lineTo(right, y).strokeColor(B.LINEA).lineWidth(0.5).stroke()
    })

    // Pie de la operación
    y += 5
    const pie = o.estado === 'a_convenir'
      ? [['Precio a convenir', '', B.GRIS]]
      : [['Total', B.money(o.total), B.TINTA], ['Pagado', B.money(o.pagado), B.VERDE], ['Resta', B.money(o.resta), o.resta > 0.005 ? B.ROJO : B.VERDE]]
    doc.fontSize(8.5).font('Helvetica').fillColor(B.GRIS).text(`Pago: ${o.metodoTexto}`, left + 4, y + 2, { width: width * 0.4 })
    let xp = right
    pie.slice().reverse().forEach(([label, monto, color]) => {
      const txt = monto ? `${label}: ${monto}` : label
      const w = doc.font('Helvetica-Bold').widthOfString(txt) + 16
      xp -= w
      doc.fillColor(color).font('Helvetica-Bold').text(txt, xp, y + 2, { width: w, align: 'right' })
    })
    y += 26
  }

  function tablaSimple(titulo, columnas, filas, tituloPagina) {
    asegurar(40 + Math.min(filas.length, 3) * 15, tituloPagina)
    doc.fillColor(B.AZUL).fontSize(10).font('Helvetica-Bold').text(titulo.toUpperCase(), left, y)
    y += 16
    const cabecera = () => {
      doc.rect(left, y, width, 15).fill(B.FONDO)
      let x = left
      doc.fillColor(B.GRIS).fontSize(7).font('Helvetica-Bold')
      columnas.forEach(c => { doc.text(c.header.toUpperCase(), x + 4, y + 4, { width: c.w * width - 8, align: c.align }); x += c.w * width })
      y += 16
    }
    cabecera()
    filas.forEach(f => {
      if (y + 15 > limite()) { nuevaPagina(tituloPagina); cabecera() }
      let x = left
      doc.fillColor(f._color || B.TINTA).fontSize(8.5).font(f._bold ? 'Helvetica-Bold' : 'Helvetica')
      columnas.forEach(c => { doc.text(String(f[c.key] ?? ''), x + 4, y + 3, { width: c.w * width - 8, align: c.align, lineBreak: false, ellipsis: true }); x += c.w * width })
      y += 15
      doc.moveTo(left, y).lineTo(right, y).strokeColor(B.LINEA).lineWidth(0.5).stroke()
    })
    y += 14
  }

  function resumenPorObra(porObra, tituloPagina) {
    if (!porObra || !porObra.length) return
    tablaSimple('Resumen por obra', [
      { key: 'nombre', header: 'Obra', w: 0.4, align: 'left' }, { key: 'cantidad', header: 'Ops.', w: 0.09, align: 'right' },
      { key: 'consumido', header: 'Consumido', w: 0.17, align: 'right' }, { key: 'pagado', header: 'Pagado', w: 0.17, align: 'right' },
      { key: 'saldo', header: 'Saldo', w: 0.17, align: 'right' },
    ], porObra.map(o => ({ nombre: o.nombre, cantidad: o.resumen.cantidad, consumido: B.money(o.resumen.consumido),
      pagado: B.money(o.resumen.pagado), saldo: B.money(o.resumen.saldo) })), tituloPagina)
  }

  function pagos(lista, tituloPagina) {
    if (!lista) return
    const total = lista.reduce((s, p) => s + p.monto, 0)
    tablaSimple('Pagos recibidos del período', [
      { key: 'fecha', header: 'Fecha', w: 0.14, align: 'left' }, { key: 'metodo', header: 'Método', w: 0.18, align: 'left' },
      { key: 'descripcion', header: 'Descripción', w: 0.48, align: 'left' }, { key: 'monto', header: 'Monto', w: 0.2, align: 'right' },
    ], [
      ...lista.map(p => ({ fecha: fmtFecha(p.fecha), metodo: p.metodoTexto, descripcion: p.descripcion, monto: B.money(p.monto) })),
      ...(lista.length ? [] : [{ descripcion: 'Sin pagos registrados en el período', _color: B.GRIS }]),
      { descripcion: 'TOTAL', monto: B.money(total), _bold: true },
    ], tituloPagina)
  }

  function operaciones(c, tituloPagina) {
    if (!c.operaciones.length) {
      doc.fillColor(B.GRIS).fontSize(10).font('Helvetica').text('Sin operaciones en el período.', left, y, { width, align: 'center' })
      y += 26
      return
    }
    doc.fillColor(B.AZUL).fontSize(10).font('Helvetica-Bold').text('DETALLE DE OPERACIONES', left, y)
    y += 16
    c.operaciones.forEach(o => operacion(o, tituloPagina))
  }

  // ── Armado ─────────────────────────────────────────────────────
  if (general) {
    const titulo = 'Liquidación general'
    encabezado(titulo)
    tarjetasResumen(liquidacion.resumen)
    tablaSimple('Resumen por cliente', [
      { key: 'nombre', header: 'Cliente', w: 0.4, align: 'left' }, { key: 'cantidad', header: 'Ops.', w: 0.09, align: 'right' },
      { key: 'consumido', header: 'Consumido', w: 0.17, align: 'right' }, { key: 'pagado', header: 'Pagado', w: 0.17, align: 'right' },
      { key: 'saldo', header: 'Saldo', w: 0.17, align: 'right' },
    ], liquidacion.clientes.map(c => ({ nombre: c.cliente.nombreCompleto, cantidad: c.resumen.cantidad, consumido: B.money(c.resumen.consumido),
      pagado: B.money(c.resumen.pagado), saldo: B.money(c.resumen.saldo) })), titulo)
    if (!liquidacion.clientes.length) {
      doc.fillColor(B.GRIS).fontSize(10).font('Helvetica').text('Sin operaciones en el período.', left, y, { width, align: 'center' })
    }
    liquidacion.clientes.forEach(c => {
      nuevaPagina(titulo)
      ficha(c.cliente)
      tarjetasResumen(c.resumen)
      operaciones(c, titulo)
    })
  } else {
    const titulo = 'Liquidación'
    const c = liquidacion.clientes[0]
    encabezado(titulo)
    ficha(c.cliente)
    tarjetasResumen(c.resumen)
    operaciones(c, titulo)
    resumenPorObra(c.porObra, titulo)
    pagos(c.pagos, titulo)
  }

  // ── Pie en todas las páginas: leyenda, página X de Y ─────────
  const rango = doc.bufferedPageRange()
  for (let i = 0; i < rango.count; i++) {
    doc.switchToPage(rango.start + i)
    const yPie = doc.page.height - doc.page.margins.bottom - PIE + 8
    doc.moveTo(left, yPie - 4).lineTo(right, yPie - 4).strokeColor(B.LINEA).lineWidth(0.5).stroke()
    doc.fillColor(B.GRIS).fontSize(7).font('Helvetica')
       .text(LEYENDA, left, yPie, { width: width - 90, lineBreak: false, ellipsis: true })
       .text(`Página ${i + 1} de ${rango.count}`, right - 90, yPie, { width: 90, align: 'right', lineBreak: false })
       .text(`Emitida el ${fmtFecha(hoy)} · ${B.EMPRESA.razon}`, left, yPie + 11, { width, lineBreak: false })
  }
  doc.end()
}

module.exports = { generarLiquidacionPDF, nombreArchivoLiquidacion }
```

- [ ] **Step 4: Correr y verificar que pasa**

Run: `node --test --test-concurrency=1 tests/liquidaciones-pdf.test.js`
Expected: PASS.

- [ ] **Step 5: Mirar el PDF**

Generar un archivo con datos de ejemplo y abrirlo (Read de la imagen o abrirlo en el visor) para revisar que no haya textos encimados, cortes feos ni páginas en blanco:

```bash
node -e "
const fs=require('fs');const {PassThrough}=require('stream');const {generarLiquidacionPDF}=require('./src/utils/pdfLiquidacion');
const s=new PassThrough();s.setHeader=()=>{};s.pipe(fs.createWriteStream(process.env.TEMP+'/liquidacion-prueba.pdf'));
const op=(i)=>({id:i,nro_op:300+i,nro_remito:1000+i,fecha:'2026-10-05',tipo:'viaje',tipoTexto:'Venta con viaje',obra:'Colón 100',metodoTexto:'Efectivo',renglones:[{descripcion:'Arena fina',unidad:'m³',cantidad:2,precio_unit:500,importe:1000},{descripcion:'Flete',unidad:'',cantidad:1,precio_unit:200,importe:200}],total:1200,pagado:i%2?1200:400,resta:i%2?0:800,estado:i%2?'pagada':'parcial'});
generarLiquidacionPDF(s,{liquidacion:{clientes:[{cliente:{nombreCompleto:'ARQ LUCAS RODRIGUEZ',numero:42,dni:'30111222',telefono:'351',direccion:'Colón 100',email:''},operaciones:Array.from({length:12},(_,i)=>op(i+1)),resumen:{consumido:14400,pagado:10800,saldo:3600,cantidad:12},pagos:[{fecha:'2026-10-05',metodoTexto:'Efectivo',descripcion:'Cobro',monto:1200}],porObra:[]}],resumen:{},obra:null},filtros:{clienteId:'1',desde:'2026-10-01',hasta:'2026-10-31'},general:false})"
```
Expected: el archivo `%TEMP%/liquidacion-prueba.pdf` se ve prolijo. Corregir el layout si algo se pisa.

- [ ] **Step 6: Commit**

```bash
git add src/utils/pdfLiquidacion.js tests/liquidaciones-pdf.test.js
git commit -m "Liquidaciones: PDF para compartir con el cliente"
```

---

### Task 4: Pantalla, rutas, controlador y menú

**Files:**
- Create: `src/controllers/liquidaciones.controller.js`
- Create: `src/routes/liquidaciones.routes.js`
- Create: `views/pages/liquidaciones/index.ejs`
- Create: `views/partials/liquidacion_operacion.ejs`
- Create: `src/scss/pages/_liquidaciones.scss`
- Modify: `src/scss/main.scss` (agregar el `@use`/`@import` junto a los otros de `pages/`)
- Modify: `src/app.js:77-99` (montar la ruta) y `src/app.js:106` (destino `admin_contable`)
- Modify: `src/routes/auth.routes.js:21` (destino `admin_contable`)
- Modify: `views/partials/sidebar.ejs:136-138`
- Test: `tests/liquidaciones-vistas.test.js`

**Interfaces:**
- Consumes: `normalizarFiltros`, `TIPOS`, `ESTADOS`, `nroLiquidacion` (Task 1); `LiquidacionesModel.liquidacion` (Task 2); `generarLiquidacionPDF` (Task 3); `ClientesModel.obras(clienteId)` → `[{ clave, nombre, opIds }]`; `hoyISO`; `renderVista(relativa, locals)` de `tests/helpers/vistas`.
- Produces: rutas `GET /liquidaciones` y `GET /liquidaciones/pdf`; la vista recibe `{ titulo: 'Liquidaciones', filtros, liquidacion, obras, clienteSel, TIPOS, ESTADOS, nro, scripts }`.

- [ ] **Step 1: Escribir la prueba de la vista que falla**

`tests/liquidaciones-vistas.test.js`:

```js
'use strict'
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { renderVista } = require('./helpers/vistas')
const { TIPOS, ESTADOS } = require('../src/utils/liquidaciones')

const filtros = { clienteId: '1', obra: null, desde: '2026-10-01', hasta: '2026-10-31', tipos: Object.keys(TIPOS), estadoPago: 'todas' }
const op = { id: 9, nro_op: 308, nro_remito: 1234, fecha: '2026-10-06', tipo: 'viaje', tipoTexto: 'Venta con viaje', obra: 'Colón 100',
  metodoTexto: 'Efectivo', renglones: [{ descripcion: 'Arena fina', unidad: 'm³', cantidad: 2, precio_unit: 500, importe: 1000 }],
  total: 1000, pagado: 400, resta: 600, estado: 'parcial' }
const cliente = { id: 1, numero: 42, nombreCompleto: 'ARQ LUCAS RODRIGUEZ', dni: '', telefono: '', direccion: '', email: '' }
const base = { titulo: 'Liquidaciones', TIPOS, ESTADOS, nro: 'LIQ-20261006-0001', obras: [], scripts: [] }

describe('vista liquidaciones', () => {
  it('con cliente: tarjetas, operación con detalle y pagos', async () => {
    const html = await renderVista('pages/liquidaciones/index', { ...base, filtros, clienteSel: cliente,
      liquidacion: { clientes: [{ cliente, operaciones: [op], resumen: { consumido: 1000, pagado: 400, saldo: 600, cantidad: 1 },
        pagos: [{ fecha: '2026-10-06', metodoTexto: 'Efectivo', descripcion: 'Cobro', monto: 400 }], porObra: [] }],
        resumen: { consumido: 1000, pagado: 400, saldo: 600, cantidad: 1 } } })
    assert.match(html, /OP-0308/)
    assert.match(html, /Arena fina/)
    assert.match(html, /Parcial/)
    assert.match(html, /Pagos recibidos/)
    assert.match(html, /\/liquidaciones\/pdf\?/)
  })
  it('sin cliente: tabla resumen por cliente y obra deshabilitada', async () => {
    const html = await renderVista('pages/liquidaciones/index', { ...base, filtros: { ...filtros, clienteId: null }, clienteSel: null,
      liquidacion: { clientes: [{ cliente, operaciones: [op], resumen: { consumido: 1000, pagado: 400, saldo: 600, cantidad: 1 }, pagos: null, porObra: [] }],
        resumen: { consumido: 1000, pagado: 400, saldo: 600, cantidad: 1 } } })
    assert.match(html, /Resumen por cliente/)
    assert.match(html, /clienteId=1/)
    assert.match(html, /id="filtroObra"[^>]*disabled/)
    assert.doesNotMatch(html, /Pagos recibidos/)
  })
  it('sin operaciones', async () => {
    const html = await renderVista('pages/liquidaciones/index', { ...base, filtros, clienteSel: cliente,
      liquidacion: { clientes: [{ cliente, operaciones: [], resumen: { consumido: 0, pagado: 0, saldo: 0, cantidad: 0 }, pagos: [], porObra: [] }],
        resumen: { consumido: 0, pagado: 0, saldo: 0, cantidad: 0 } } })
    assert.match(html, /Sin operaciones en el período/)
  })
})
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `node --test --test-concurrency=1 tests/liquidaciones-vistas.test.js`
Expected: FAIL con `ENOENT ... views/pages/liquidaciones/index.ejs`

- [ ] **Step 3: Parcial de una operación**

`views/partials/liquidacion_operacion.ejs`:

```ejs
<%# Tarjeta de una operación de la liquidación. Recibe: o (operación), ESTADOS %>
<% const $ = (n) => '$' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) %>
<div class="liq-op liq-op--<%= o.estado %>">
  <div class="liq-op__head">
    <div class="liq-op__titulo">
      <strong>OP-<%= String(o.nro_op).padStart(4, '0') %></strong>
      <% if (o.nro_remito) { %><span>Remito <%= o.nro_remito %></span><% } %>
      <span><%= formatFecha(o.fecha) %></span>
      <span><%= o.tipoTexto %></span>
      <% if (o.obra) { %><span>Obra: <%= o.obra %></span><% } %>
    </div>
    <div class="liq-op__acciones">
      <span class="liq-estado liq-estado--<%= o.estado %>"><%= ESTADOS[o.estado] %></span>
      <a href="/operaciones/<%= o.id %>" class="btn btn-sm btn-outline-secondary">Ver</a>
    </div>
  </div>
  <div class="table-responsive">
    <table class="table table-sm liq-op__tabla mb-0">
      <thead><tr><th>Detalle</th><th class="text-end">Cant.</th><th>Unid.</th><th class="text-end">P. unit.</th><th class="text-end">Importe</th></tr></thead>
      <tbody>
        <% o.renglones.forEach(r => { %>
          <tr>
            <td><%= r.descripcion %></td>
            <td class="text-end"><%= Number(r.cantidad).toLocaleString('es-AR') %></td>
            <td><%= r.unidad %></td>
            <td class="text-end"><%= $(r.precio_unit) %></td>
            <td class="text-end"><%= $(r.importe) %></td>
          </tr>
        <% }) %>
      </tbody>
    </table>
  </div>
  <div class="liq-op__pie">
    <span class="text-muted">Pago: <%= o.metodoTexto %></span>
    <% if (o.estado === 'a_convenir') { %>
      <span class="text-muted">Precio a convenir</span>
    <% } else { %>
      <span>Total <strong><%= $(o.total) %></strong></span>
      <span class="text-success">Pagado <strong><%= $(o.pagado) %></strong></span>
      <span class="<%= o.resta > 0.005 ? 'text-danger' : 'text-success' %>">Resta <strong><%= $(o.resta) %></strong></span>
    <% } %>
  </div>
</div>
```

> Verificar que `/operaciones/:id` es el detalle genérico de una OP (ver `src/routes/operaciones.routes.js`); si no existe, usar `/ventas/:id` para tipo `cantera`/`viaje`, `/alquileres/contenedores/:id` para `contenedor` y la ruta de detalle de maquinaria para `maquinaria`.

- [ ] **Step 4: La vista**

`views/pages/liquidaciones/index.ejs`:

```ejs
<% const $ = (n) => '$' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) %>
<%
  // Misma URL con los filtros actuales (para el PDF y el link "Ver liquidación" de cada cliente)
  const qs = (extra = {}) => {
    const p = new URLSearchParams()
    const f = { ...filtros, ...extra }
    if (f.clienteId) p.set('clienteId', f.clienteId)
    if (f.obra) p.set('obra', f.obra)
    p.set('desde', f.desde); p.set('hasta', f.hasta)
    f.tipos.forEach(t => p.append('tipos', t))
    p.set('estadoPago', f.estadoPago)
    return p.toString()
  }
  const r = liquidacion.resumen
  const conCliente = !!filtros.clienteId && liquidacion.clientes.length
%>
<div class="d-flex justify-content-between align-items-center mb-3">
  <h4 class="fw-bold mb-0 text-dark-title"><%- icon('fileText', { size: 18 }) %> Liquidaciones</h4>
  <a href="/liquidaciones/pdf?<%= qs() %>" target="_blank" class="btn btn-naranja"><%- icon('download', { size: 15 }) %> Descargar PDF</a>
</div>

<div class="card shadow-sm mb-3">
  <div class="card-body">
    <form method="GET" action="/liquidaciones">
      <div class="row g-2 align-items-end mb-2">
        <div class="col-12 col-md-5 position-relative">
          <label class="form-label" for="buscarClienteInput">Cliente</label>
          <input type="text" id="buscarClienteInput" class="form-control" autocomplete="off" placeholder="Todos los clientes — escribí nombre, N° o DNI..."
                 style="<%= clienteSel ? 'display:none' : '' %>">
          <ul id="buscarClienteDropdown" class="autocomplete-dropdown" style="display:none"></ul>
          <div id="clienteSeleccionado" class="buscar-cliente__seleccionado" style="<%= clienteSel ? 'display:flex' : 'display:none' %>">
            <span id="clienteSeleccionadoNombre"><%= clienteSel ? (clienteSel.numero != null ? '#' + clienteSel.numero + ' — ' : '') + clienteSel.nombreCompleto : '' %></span>
            <button type="button" class="btn btn-sm btn-outline-secondary" id="btnCambiarCliente">Cambiar</button>
          </div>
          <input type="hidden" name="clienteId" id="inputClienteId" value="<%= clienteSel ? clienteSel.id : '' %>">
          <input type="hidden" id="inputClienteNombre" value="<%= clienteSel ? clienteSel.nombreCompleto : '' %>">
        </div>
        <div class="col-12 col-md-4">
          <label class="form-label" for="filtroObra">Obra</label>
          <select name="obra" id="filtroObra" class="form-select" <%= clienteSel && obras.length ? '' : 'disabled' %>>
            <% if (!clienteSel) { %>
              <option value="">Elegí un cliente para ver sus obras</option>
            <% } else if (!obras.length) { %>
              <option value="">El cliente no tiene obras cargadas</option>
            <% } else { %>
              <option value="">Todas las obras</option>
              <% obras.forEach(o => { %><option value="<%= o.clave %>" <%= filtros.obra === o.clave ? 'selected' : '' %>><%= o.nombre %></option><% }) %>
            <% } %>
          </select>
        </div>
        <div class="col-6 col-md-3">
          <label class="form-label">Estado de pago</label>
          <select name="estadoPago" class="form-select">
            <option value="todas" <%= filtros.estadoPago === 'todas' ? 'selected' : '' %>>Todas</option>
            <option value="pendientes" <%= filtros.estadoPago === 'pendientes' ? 'selected' : '' %>>Solo pendientes</option>
            <option value="pagadas" <%= filtros.estadoPago === 'pagadas' ? 'selected' : '' %>>Solo pagadas</option>
          </select>
        </div>
      </div>
      <div class="row g-2 align-items-end">
        <div class="col-6 col-md-2">
          <label class="form-label">Desde</label>
          <input type="date" name="desde" class="form-control" value="<%= filtros.desde %>">
        </div>
        <div class="col-6 col-md-2">
          <label class="form-label">Hasta</label>
          <input type="date" name="hasta" class="form-control" value="<%= filtros.hasta %>">
        </div>
        <div class="col-12 col-md-5">
          <label class="form-label d-block">Operaciones</label>
          <div class="liq-tipos">
            <% Object.entries(TIPOS).forEach(([k, label]) => { %>
              <label class="liq-tipo"><input type="checkbox" name="tipos" value="<%= k %>" <%= filtros.tipos.includes(k) ? 'checked' : '' %>> <%= label %></label>
            <% }) %>
          </div>
        </div>
        <div class="col-12 col-md-3 d-flex gap-2">
          <button type="submit" class="btn btn-primary">Ver</button>
          <a href="/liquidaciones" class="btn btn-outline-secondary">Limpiar</a>
        </div>
      </div>
    </form>
  </div>
</div>

<div class="liq-resumen mb-3">
  <div class="liq-resumen__caja"><span>Total consumido</span><strong><%= $(r.consumido) %></strong></div>
  <div class="liq-resumen__caja"><span>Pagado</span><strong class="text-success"><%= $(r.pagado) %></strong></div>
  <div class="liq-resumen__caja"><span>Saldo pendiente</span><strong class="<%= r.saldo > 0.005 ? 'text-danger' : 'text-success' %>"><%= $(r.saldo) %></strong></div>
  <div class="liq-resumen__caja"><span>Operaciones</span><strong><%= r.cantidad %></strong></div>
</div>

<% if (!r.cantidad) { %>
  <div class="card shadow-sm"><div class="card-body text-center text-muted py-5">Sin operaciones en el período.</div></div>
<% } else if (conCliente) { %>
  <% const c = liquidacion.clientes[0] %>
  <% c.operaciones.forEach(o => { %><%- include('../../partials/liquidacion_operacion', { o, ESTADOS }) %><% }) %>
<% } else { %>
  <div class="card shadow-sm mb-3">
    <div class="card-body">
      <h6 class="fw-bold mb-2">Resumen por cliente</h6>
      <div class="table-responsive">
        <table class="table table-sm mb-0">
          <thead><tr><th>Cliente</th><th class="text-end">Ops.</th><th class="text-end">Consumido</th><th class="text-end">Pagado</th><th class="text-end">Saldo</th><th></th></tr></thead>
          <tbody>
            <% liquidacion.clientes.forEach(c => { %>
              <tr>
                <td><%= c.cliente.nombreCompleto %></td>
                <td class="text-end"><%= c.resumen.cantidad %></td>
                <td class="text-end"><%= $(c.resumen.consumido) %></td>
                <td class="text-end"><%= $(c.resumen.pagado) %></td>
                <td class="text-end <%= c.resumen.saldo > 0.005 ? 'text-danger' : '' %>"><%= $(c.resumen.saldo) %></td>
                <td class="text-end"><a href="/liquidaciones?<%= qs({ clienteId: String(c.cliente.id), obra: null }) %>">Ver liquidación</a></td>
              </tr>
            <% }) %>
          </tbody>
        </table>
      </div>
    </div>
  </div>
  <% liquidacion.clientes.forEach(c => { %>
    <h5 class="liq-cliente-titulo"><%= c.cliente.nombreCompleto %></h5>
    <% c.operaciones.forEach(o => { %><%- include('../../partials/liquidacion_operacion', { o, ESTADOS }) %><% }) %>
  <% }) %>
<% } %>

<% if (conCliente && liquidacion.clientes[0].pagos) { %>
  <% const pagos = liquidacion.clientes[0].pagos %>
  <div class="card shadow-sm mt-3">
    <div class="card-body">
      <h6 class="fw-bold mb-2">Pagos recibidos del período</h6>
      <% if (!pagos.length) { %>
        <p class="text-muted mb-0">Sin pagos registrados en el período.</p>
      <% } else { %>
        <table class="table table-sm mb-0">
          <thead><tr><th>Fecha</th><th>Método</th><th>Descripción</th><th class="text-end">Monto</th></tr></thead>
          <tbody>
            <% pagos.forEach(p => { %>
              <tr><td><%= formatFecha(p.fecha) %></td><td><%= p.metodoTexto %></td><td><%= p.descripcion %></td><td class="text-end"><%= $(p.monto) %></td></tr>
            <% }) %>
            <tr class="fw-bold"><td colspan="3">Total</td><td class="text-end"><%= $(pagos.reduce((s, p) => s + p.monto, 0)) %></td></tr>
          </tbody>
        </table>
      <% } %>
    </div>
  </div>
<% } %>
```

- [ ] **Step 5: Correr la prueba de la vista**

Run: `node --test --test-concurrency=1 tests/liquidaciones-vistas.test.js`
Expected: PASS. (Si `icon('download')` o `icon('fileText')` no existen en `src/config/icons`, usar los que use `views/pages/ventas/libro.ejs`.)

- [ ] **Step 6: Controlador y rutas**

`src/controllers/liquidaciones.controller.js`:

```js
'use strict'
const LiquidacionesModel = require('../models/liquidaciones.model')
const ClientesModel = require('../models/clientes.model')
const { normalizarFiltros, nroLiquidacion, TIPOS, ESTADOS } = require('../utils/liquidaciones')
const { generarLiquidacionPDF } = require('../utils/pdfLiquidacion')
const { hoyISO } = require('../utils/fecha')

const LiquidacionesController = {
  async index(req, res) {
    try {
      const filtros = normalizarFiltros(req.query, hoyISO())
      let liquidacion = await LiquidacionesModel.liquidacion(filtros)
      if (liquidacion.clienteInexistente) {
        req.flash('error', 'Cliente no encontrado.')
        filtros.clienteId = null
        filtros.obra = null
        liquidacion = await LiquidacionesModel.liquidacion(filtros)
      }
      const clienteSel = filtros.clienteId ? liquidacion.clientes[0].cliente : null
      const obras = clienteSel ? await ClientesModel.obras(clienteSel.id) : []
      res.render('pages/liquidaciones/index', {
        titulo: 'Liquidaciones', filtros, liquidacion, clienteSel, obras, TIPOS, ESTADOS,
        nro: nroLiquidacion(hoyISO(), filtros.clienteId),
        scripts: ['/js/buscarCliente.js', '/js/filtroObra.js'],
      })
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al generar la liquidación.')
      res.redirect('/clientes/cuentas')
    }
  },

  async pdf(req, res) {
    try {
      const filtros = normalizarFiltros(req.query, hoyISO())
      const liquidacion = await LiquidacionesModel.liquidacion(filtros)
      if (liquidacion.clienteInexistente) {
        req.flash('error', 'Cliente no encontrado.')
        return res.redirect('/liquidaciones')
      }
      return generarLiquidacionPDF(res, { liquidacion, filtros, general: !filtros.clienteId })
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al generar la liquidación.')
      res.redirect('/liquidaciones')
    }
  },
}

module.exports = LiquidacionesController
```

> Nota: con cliente, `liquidacion.clientes[0]` siempre existe (el modelo arma una entrada aunque no haya operaciones). Si la prueba de Task 2 "fuera del período" pasó, esto está cubierto.

`src/routes/liquidaciones.routes.js`:

```js
'use strict'
const express = require('express')
const router  = express.Router()
const auth    = require('../middlewares/auth')
const roles   = require('../middlewares/roles')
const ctrl    = require('../controllers/liquidaciones.controller')
const acceso  = roles('admin_contable', 'dueno')

router.get('/',    auth, acceso, ctrl.index)
router.get('/pdf', auth, acceso, ctrl.pdf)

module.exports = router
```

- [ ] **Step 7: Montar la ruta y cambiar el destino del rol contable**

En `src/app.js`, debajo de `app.use('/facturacion', ...)`:

```js
app.use('/liquidaciones', require('./routes/liquidaciones.routes'))
```

En `src/app.js` (objeto `destinos` de la ruta raíz) y en `src/routes/auth.routes.js:21`, cambiar `admin_contable: '/cobranzas'` por `admin_contable: '/liquidaciones'`. La línea `app.get('/cobranzas', ...)` queda igual.

- [ ] **Step 8: Menú**

En `views/partials/sidebar.ejs`, reemplazar:

```ejs
      <a href="/cobranzas" class="nav-link <%= t==='Cuentas corrientes'?'is-active':'' %>">
        <%- ic('dollar') %><span>Cobranzas</span>
      </a>
```

por:

```ejs
      <a href="/liquidaciones" class="nav-link <%= t==='Liquidaciones'?'is-active':'' %>">
        <%- ic('fileText') %><span>Liquidaciones</span>
      </a>
```

(Si `ic('fileText')` no existe en el set del sidebar, usar `ic('receipt')`.)

- [ ] **Step 9: Estilos**

`src/scss/pages/_liquidaciones.scss` (usar las variables de `abstracts/_variables.scss`; si un nombre no existe, tomar el equivalente de `components/_buscar-cliente.scss`):

```scss
// Liquidaciones (views/pages/liquidaciones)
.liq-tipos { display: flex; flex-wrap: wrap; gap: 0.35rem 1rem; }
.liq-tipo { display: inline-flex; align-items: center; gap: 0.35rem; font-size: $fs-sm; cursor: pointer; }

.liq-resumen {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.75rem;
  @media (max-width: 768px) { grid-template-columns: repeat(2, minmax(0, 1fr)); }

  &__caja {
    background: $bg-card;
    border: 1px solid $border;
    border-radius: $radius-md;
    padding: 0.8rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    span { font-size: $fs-xs; color: $muted; text-transform: uppercase; font-weight: 600; }
    strong { font-size: 1.25rem; }
  }
}

.liq-cliente-titulo { margin: 1.5rem 0 0.75rem; font-weight: 700; }

.liq-op {
  background: $bg-card;
  border: 1px solid $border;
  border-left: 4px solid $border;
  border-radius: $radius-md;
  margin-bottom: 0.75rem;
  overflow: hidden;

  &--pagada     { border-left-color: #15803d; }
  &--parcial    { border-left-color: #e8912a; }
  &--pendiente  { border-left-color: #b91c1c; }
  &--a_convenir { border-left-color: #6b7280; }

  &__head {
    display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; flex-wrap: wrap;
    padding: 0.6rem 0.9rem;
    border-bottom: 1px solid $border;
  }
  &__titulo { display: flex; flex-wrap: wrap; gap: 0.35rem 0.9rem; font-size: $fs-sm; span { color: $muted; } }
  &__acciones { display: flex; align-items: center; gap: 0.5rem; }
  &__tabla { font-size: $fs-sm; th { font-size: $fs-xs; color: $muted; text-transform: uppercase; } }
  &__pie {
    display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 0.4rem 1.25rem;
    padding: 0.55rem 0.9rem; font-size: $fs-sm;
    > :first-child { margin-right: auto; }
  }
}

.liq-estado {
  font-size: $fs-xs; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em;
  padding: 0.2rem 0.6rem; border-radius: 999px;
  &--pagada     { background: #dcfce7; color: #15803d; }
  &--parcial    { background: #fff1dc; color: #b45309; }
  &--pendiente  { background: #fee2e2; color: #b91c1c; }
  &--a_convenir { background: #f3f4f6; color: #6b7280; }
}
```

Agregar el import en `src/scss/main.scss` con la misma sintaxis que los otros parciales de `pages/`.

Run: `npx sass src/scss/main.scss:public/css/main.css`
Expected: compila sin errores.

- [ ] **Step 10: Probar el controlador contra la base (ROLLBACK)**

Agregar al final de `tests/liquidaciones-modelo.test.js` (dentro del mismo `describe`, usa el cliente de prueba):

```js
  it('controlador: con filtros manipulados no rompe y cae en los defaults', async () => {
    const Controller = require('../src/controllers/liquidaciones.controller')
    const llamar = (accion, query) => new Promise((resolve, reject) => {
      const flashes = []
      const req = { query, session: { user: { id: admin, rol: 'dueno' } }, flash: (t, m) => flashes.push({ t, m }) }
      const res = { render: (vista, data) => resolve({ vista, data, flashes }), redirect: (url) => resolve({ url, flashes }), status() { return this } }
      Promise.resolve(Controller[accion](req, res)).catch(reject)
    })
    const a = await llamar('index', { clienteId: String(cliente), desde: 'hola', tipos: 'xxx', estadoPago: 'raro' })
    assert.equal(a.vista, 'pages/liquidaciones/index')
    assert.equal(a.data.filtros.estadoPago, 'todas')
    const b = await llamar('index', { clienteId: '999999999' })
    assert.equal(b.data.clienteSel, null)
    assert.deepEqual(b.flashes, [{ t: 'error', m: 'Cliente no encontrado.' }])
  })
```

Run: `node --test --test-concurrency=1 tests/liquidaciones-modelo.test.js`
Expected: PASS.

- [ ] **Step 11: Correr todas las pruebas**

Run: `npm test`
Expected: PASS todas (las de antes y las nuevas).

- [ ] **Step 12: Commit**

```bash
git add src/controllers/liquidaciones.controller.js src/routes/liquidaciones.routes.js views/pages/liquidaciones/index.ejs views/partials/liquidacion_operacion.ejs src/scss/pages/_liquidaciones.scss src/scss/main.scss src/app.js src/routes/auth.routes.js views/partials/sidebar.ejs tests/liquidaciones-vistas.test.js tests/liquidaciones-modelo.test.js
git commit -m "Liquidaciones: pantalla, PDF y menú (reemplaza Contabilidad → Cobranzas)"
```

---

### Task 5: Filtro por N° de operación en Transacciones

**Files:**
- Modify: `src/models/transacciones.model.js:222-237` (`_filtro`)
- Modify: `src/controllers/transacciones.controller.js:12-22` (`leerFiltros`) y `:27` / `:41` (`index`)
- Modify: `views/pages/transacciones/index.ejs:6-12` (`presetHref`) y el form de filtros (después del campo Remito)
- Test: `tests/transacciones-filtro.test.js`

**Interfaces:**
- Consumes: nada de las tareas anteriores (es independiente).
- Produces: `TransaccionesModel.nroOpDeTexto(texto) → number|null` ("308", "0308", "OP-0308", "op 308" → 308; vacío o sin dígitos → null); `_filtro({ ..., nroOp })` agrega `id_op_encabezado IN (SELECT id FROM op_encabezado WHERE nro_op = ?)`.

- [ ] **Step 1: Escribir las pruebas que fallan**

`tests/transacciones-filtro.test.js`. El arnés de la base va PRIMERO (los modelos copian `query` al cargarse); el primer `describe` no usa la base porque `_filtro` solo arma el WHERE:

```js
'use strict'
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const TransaccionesModel = require('../src/models/transacciones.model')
const VentasModel = require('../src/models/ventas.model')

describe('filtro por N° de operación', () => {
  it('entiende 308, 0308 y OP-0308', () => {
    for (const t of ['308', '0308', 'OP-0308', 'op 308', ' OP-308 ']) assert.equal(TransaccionesModel.nroOpDeTexto(t), 308)
  })
  it('vacío o sin números = sin filtro', () => {
    for (const t of ['', '   ', 'OP-', 'abc', undefined, null]) assert.equal(TransaccionesModel.nroOpDeTexto(t), null)
  })
  it('_filtro agrega la condición por nro_op de la operación', () => {
    const { where, params } = TransaccionesModel._filtro({ nroOp: 'OP-0308' })
    assert.match(where, /id_op_encabezado IN \(SELECT id FROM op_encabezado WHERE nro_op = \?\)/)
    assert.deepEqual(params, [308])
  })
  it('_filtro sin nroOp válido no cambia nada', () => {
    assert.deepEqual(TransaccionesModel._filtro({ nroOp: 'abc' }), { where: '', params: [] })
  })
})

describe('filtro por N° de operación contra la base', () => {
  let nroOp, idOp
  before(async () => {
    await prueba.abrir()
    const cliente = await datos.crearCliente()
    const admin = await datos.idAdministrativo()
    const producto = (await prueba.q(`SELECT id FROM productos WHERE COALESCE(es_contenedor,0)=0 ORDER BY id LIMIT 1`)).rows[0].id
    const r = await VentasModel.crear({ id_cliente: cliente, id_administrativo: admin, tipo_op: 'M', modalidad: 'flete', metodo_pago: 'efectivo',
      detalles: [{ id_producto: producto, cantidad_pedida: 1, precio_unitario: 100 }] })
    idOp = r.id; nroOp = r.nro_op
    await TransaccionesModel.crear({ tipo: 'Venta Viaje', id_op_encabezado: idOp, cliente_id: cliente, cliente: 'PRUEBA', monto: 100, metodo_pago: 'efectivo' })
  })
  after(() => prueba.cerrar())

  it('encuentra la transacción de esa operación', async () => {
    const r = await TransaccionesModel.filtrar({ nroOp: `OP-${String(nroOp).padStart(4, '0')}`, limit: 50 })
    assert.equal(r.rows.length, 1)
    assert.equal(String(r.rows[0].id_op_encabezado), String(idOp))
  })
})
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `node --test --test-concurrency=1 tests/transacciones-filtro.test.js`
Expected: FAIL con `TransaccionesModel.nroOpDeTexto is not a function`

- [ ] **Step 3: Implementar en el modelo**

En `src/models/transacciones.model.js`, agregar el método dentro de `TransaccionesModel`, justo antes de `_filtro`:

```js
  // N° de operación escrito a mano: "308", "0308" u "OP-0308" → 308. Sin dígitos → null (sin filtro).
  nroOpDeTexto(texto) {
    const digitos = String(texto ?? '').replace(/\D/g, '')
    return digitos ? Number(digitos) : null
  },

```

En `_filtro`, sumar `nroOp` a los parámetros desestructurados:

```js
  _filtro({ id, tipo, clienteId, cliente, remito, nroOp, fechaDesde, fechaHasta, montoMin, montoMax } = {}) {
```

y la condición, después de la de `remito`:

```js
    const nro = this.nroOpDeTexto(nroOp)
    if (nro != null) { wheres.push('id_op_encabezado IN (SELECT id FROM op_encabezado WHERE nro_op = ?)'); params.push(nro) }
```

- [ ] **Step 4: Controlador y vista**

En `src/controllers/transacciones.controller.js`:
- `leerFiltros`: agregar `nroOp: q.nroOp,` junto a `remito: q.remito,` (así lo usan la tabla y el reporte).
- `index`: agregar `nroOp` al destructuring de `req.query` (línea 27) y `nroOp: nroOp||'',` al objeto `filtros` (línea 41, junto a `remito`).

En `views/pages/transacciones/index.ejs`:
- `presetHref`: agregar `if (filtros.nroOp) o.nroOp = filtros.nroOp` debajo de la línea de `remito`.
- En el form, después del `filtro-group` de Remito:

```ejs
                <div class="filtro-group">
                    <label>N° de OP</label>
                    <input type="text" name="nroOp" value="<%= filtros.nroOp %>" maxlength="10"
                        placeholder="Ej: 308 u OP-0308" autocomplete="off">
                </div>
```

(`qsReporte` ya arma la URL del reporte con todo `filtros`, así que el reporte filtra solo.)

- [ ] **Step 5: Correr y verificar que pasa**

Run: `node --test --test-concurrency=1 tests/transacciones-filtro.test.js`
Expected: PASS (las 5 pruebas).

- [ ] **Step 6: Commit**

```bash
git add src/models/transacciones.model.js src/controllers/transacciones.controller.js views/pages/transacciones/index.ejs tests/transacciones-filtro.test.js
git commit -m "Transacciones: filtro por N° de operación"
```

---

### Task 6: Verificación en la app real

**Files:** ninguno (solo verificación; si aparece un bug, se corrige en el archivo de la tarea dueña y se agrega su prueba).

- [ ] **Step 1: Levantar el servidor sin nodemon** (para no correr `initDB` en cada guardado)

Run (en background): `node server.js`
Expected: `✅ Suelosur corriendo en puerto 3000`. No hay migraciones nuevas, así que `initDB` no cambia nada.

- [ ] **Step 2: Revisar en el navegador** (logueado como dueño)

- `/liquidaciones` sin cliente: tarjetas, tabla resumen por cliente, obra deshabilitada.
- Elegir un cliente con el buscador → se habilita Obra → "Ver": tarjetas por operación con detalle y estado, pagos recibidos.
- Elegir una obra → desaparece la sección de pagos.
- Filtrar por tipo y por estado de pago.
- "Descargar PDF" con cliente y sin cliente: abrir y revisar el layout.
- Transacciones: filtrar por N° de OP (`308` y `OP-0308`), cambiar el período con los chips y ver que el filtro se mantiene; exportar el reporte filtrado.
- El menú muestra Contabilidad → Liquidaciones; Contenedores → Cobranzas sigue igual; `/cobranzas` sigue llevando a Cuentas corrientes.

- [ ] **Step 3: Frenar el servidor** y reportar lo revisado (con capturas si se pudo).
