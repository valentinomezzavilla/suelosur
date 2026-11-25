# Editar ventas ya entregadas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que una venta (viaje o cantera) ya entregada se pueda editar, y que stock, cobro (transacción), egreso a tercero y cuenta corriente acompañen el cambio.

**Architecture:** `VentasModel.actualizarViaje` pasa a ser `actualizarVenta` (N líneas, viaje y cantera; `actualizarViaje` queda como alias). Si la venta estaba `entregado`, dentro de la misma transacción de base se corrige el stock real por diferencia y `VentasModel.corregirCobro` deja la transacción existente coherente (mismo patrón que `AlquileresModel.corregirCobro`); el cargo de cuenta corriente lo sigue rehaciendo `sincronizarCargoCC`. Controlador, detalle y `editar_viaje.ejs` se abren a entregadas y a cantera.

**Tech Stack:** Node/Express, EJS, PostgreSQL (`pg`), pruebas `node:test` con el arnés `tests/helpers/db.js`.

**Spec:** `docs/superpowers/specs/2026-11-25-editar-ventas-entregadas-design.md`

## Global Constraints

- La fecha de cobro de la transacción **no se toca** al editar.
- Stock de una entregada: `cantidad_actual = GREATEST(0, cantidad_actual − (nueva − vieja))`; `cant_pendiente_entregar` no se toca. Pendiente/despachada: sigue moviendo `cant_pendiente_entregar` como hoy. Contenedores y productos sin control de stock no mueven (`SQL_MUEVE_STOCK`).
- La transacción corregida es la de tipo ≠ `'Ajuste'`; su monto es el total **con IVA** (`SQL_TOTAL`).
- Facturada (`facturado = 1`): se rechaza cambiar cantidad, precio, flete o total; el resto sigue editable.
- Anuladas siguen rechazadas. Cliente, producto y remito no se editan; no se agregan ni quitan productos.
- Todo el guardado en **una** transacción de base (`transaction(async (q) => …)`): un error revierte todo. Dentro de ella solo `q`, nunca `query`/`transaction` globales (en producción abrirían otra conexión).
- Los ids BIGINT llegan como `number`: comparar con `String()`; `parseInt(v, 10)`.
- Textos al usuario en español rioplatense (voseo), como el resto de la app.
- Sin cambios de esquema de base de datos.

## Cómo correr las pruebas

**Nunca `npm test` directo** (usa el `.env`, que apunta a producción). Usar el arnés con PGlite en memoria:

```bash
bash "C:/Users/valen/AppData/Local/Temp/claude/048008ffb8ab7c6e/a0ee298e-d501-49bf-ad96-adfbbb4541fe/scratchpad/pglite/correr.sh" --test tests/<archivo>.test.js
```

(Verificado el 2026-11-25 con `tests/nro-factura-operaciones.test.js`: 32 ok.) Si esa carpeta no existe, rearmarla con la receta de la memoria `pruebas-con-pglite`. Rama de trabajo: `feat/editar-ventas-entregadas`.

## Review Focus

Entradas que el spec implica y que más probablemente muerden; cada una tiene su prueba en la tarea indicada.

1. Guardar sin cambiar nada de lo cobrado: la transacción, el egreso a tercero y el cargo quedan **idénticos** (no se rehace el egreso, no hay auditoría) — Tarea 2.
2. Venta "para facturar" (IVA 21): la transacción pasa a neto × 1,21, no al neto — Tarea 2.
3. Falla a mitad (pasar a cuenta corriente un cliente sin CC habilitada): no queda nada cambiado, ni el stock — Tarea 2.
4. Venta a cuenta corriente con un pago ya aplicado: el cargo cambia de monto y el saldo del cliente es `−nuevoTotal + pago` — Tarea 2.
5. Producto sin control de stock y contenedor: editar cantidad no toca el stock — Tarea 1.

## File Structure

- Modify `src/models/ventas.model.js` — `actualizarVenta` (+ alias `actualizarViaje`), `obtenerViaje` ampliado, `descripcionDeCobro`, `corregirCobro`.
- Modify `src/controllers/ventas.controller.js` — `editarViaje`, `actualizarViaje`.
- Modify `views/pages/ventas/detalle.ejs` (botón Editar) y `views/pages/ventas/editar_viaje.ejs` (cantera, entregada, facturada).
- Create `tests/venta-entregada-editar.test.js` — todas las pruebas de esta feature.

---

### Task 1: Modelo — editar una entregada (líneas, stock, facturada)

**Files:**
- Modify: `src/models/ventas.model.js` (`actualizarViaje` ~línea 218 → `actualizarVenta`)
- Create: `tests/venta-entregada-editar.test.js`

**Interfaces:**
- Produces: `VentasModel.actualizarVenta(id: number|string, datos: object, opciones?: { usuario?: number }) → Promise<{ entregada: boolean, cobroCorregido: boolean }>` y el alias `VentasModel.actualizarViaje` (misma firma).
  - `datos.lineas?: Array<{ id: number|string, cantidad: number|string, precio: number|string }>` (ids de `op_detalle_material`). Sin `lineas`, se mantiene el camino de una sola línea (`datos.cantidad`, `datos.precioProducto`).
  - `datos.tercero?: object|null`: `undefined` no toca el tercero de la operación; `null` o un objeto se guarda dentro de la transacción (`Tercero.guardarEnOp(id, tercero, {}, q)`).
- `cobroCorregido` queda en `false` hasta la Tarea 2.

- [ ] **Step 1: Branch y arnés de pruebas.** `git switch -c feat/editar-ventas-entregadas` y commitear el spec y este plan. Crear `tests/venta-entregada-editar.test.js` con el encabezado de `tests/nro-factura-operaciones.test.js` (requires, `llamar(Controller, accion, {body, params, query, user})` copiado de ahí, `before`: `prueba.abrir()`, `admin`, `user = { id: admin, rol: 'dueno' }`, `cliente = datos.crearCliente()`; `after`: `prueba.cerrar()`) y estos fixtures:
  - `producto({ stock = 100, dependeStock = 1, precioCantera = 1000, nombre })` → inserta en `productos` (`unidad_medida 'm³'`, `precio_viaje 1200`, `activo 1`) y en `stock` (`cantidad_actual = stock`, `cant_pendiente_entregar = 0`, `stock_minimo = 0`); devuelve el id.
  - `viajeEntregado({ prod, cantidad = 2, precio = 1000, metodo = 'efectivo', cli = cliente })` → `VentasModel.crear` (`modalidad 'flete'`, `domicilio { calle: 'Colón', altura: '100' }`, `fecha_emision '2026-11-10'`, `fecha_entrega_planificada '2026-11-20'`, `precio_flete 0`, `monto_total = cantidad × precio`, un detalle) y después `llamar(VentasController, 'entregar', { user, params: { id }, body: {} })`; devuelve `id`.
  - `canteraEntregada({ items, metodo = 'efectivo', cli = cliente })` → `llamar(VentasController, 'finalizarCantera', { user, body: { clienteId: String(cli), clienteNombre: 'PRUEBA', metodoPago: metodo, items: JSON.stringify(items) } })`; devuelve el id (último `op_encabezado` del cliente).
  - `stockDe(prod)` → `{ actual, pendiente }`; `fila(id)` → `op_encabezado`; `lineasDe(id)` → `op_detalle_material` ordenadas por id.

- [ ] **Step 2: Escribir las pruebas que fallan** (`describe('modelo: editar una venta entregada')`), con `arena = producto({ nombre: 'Arena prueba entregada' })` y `piedra = producto({ nombre: 'Piedra prueba entregada', precioCantera: 3000 })`. Edición base de viaje: `const base = { calle: 'Colón', numero: '100', fecha: '2026-11-20', metodoPago: 'efectivo' }`.
  - `viaje entregado: subir la cantidad descuenta del stock actual y no toca el pendiente`: viaje 2 × 1000 (stock 98 tras entregar) → `actualizarVenta(id, { ...base, cantidad: 5, precioProducto: 1000 })` → `stockDe` = `{ actual: 95, pendiente: 0 }`; `monto_total` = 5000.
  - `viaje entregado: bajar la cantidad devuelve stock`: 2 → 1 → actual 99.
  - `cantera con dos productos: cada línea corrige su stock y el total es la suma`: `items [{id: arena, cantidad: 2}, {id: piedra, cantidad: 1}]`; `actualizarVenta(id, { metodoPago: 'efectivo', fechaCompra: '2026-11-10', lineas: [{ id: l1, cantidad: 3, precio: 1000 }, { id: l2, cantidad: 1, precio: 2500 }] })` → arena actual 97, piedra sin cambio, `monto_total` 5500, `fecha_entrega_planificada`/`domicilio_calle`/`obra` siguen `null` (cantera no toca campos de envío).
  - `el stock queda en 0 como mínimo`: stock actual 1 y subir la cantidad en 10 → actual 0.
  - `producto sin control de stock no mueve stock` (Review Focus 5): producto `dependeStock = 0` y también uno con `es_contenedor = 1`; subir la cantidad → su fila de `stock` idéntica.
  - `pendiente y despachada siguen moviendo el pendiente`: viaje sin entregar 2 → editar a 3 → `{ actual: 100, pendiente: 3 }`.
  - `facturada: rechaza cambiar precio y no guarda nada`: `UPDATE op_encabezado SET facturado = 1` → `assert.rejects(…, /facturada/)`; `monto_total` y stock iguales. Y `facturada: sí deja editar el resto`: mismas cantidad y precio con `calle: 'Otra'` → guarda.
  - `anulada: sigue sin poder editarse` → `assert.rejects(…, /anulada/)`.
  - `descripción de cantera`: observaciones iniciales `'Arena prueba entregada x2'`; editar a 3 posteando `descripcion: 'Arena prueba entregada x2'` → `'Arena prueba entregada x3'`; con `descripcion: 'Arena prueba entregada x2 — Obra norte'` → `'… x3 — Obra norte'`; con `descripcion: 'Entrega especial'` → queda `'Entrega especial'`.

- [ ] **Step 3: Correr y ver que fallan** (comando de "Cómo correr las pruebas" con `tests/venta-entregada-editar.test.js`). Esperado: las nuevas fallan con "No se puede editar una venta ya entregada" o "actualizarVenta is not a function".

- [ ] **Step 4: Implementar `actualizarVenta`** en `src/models/ventas.model.js` partiendo del cuerpo actual de `actualizarViaje` y agregando alias `VentasModel.actualizarViaje = (...a) => VentasModel.actualizarVenta(...a)`:
  - Dentro de la transacción, primero `SELECT … FROM op_encabezado WHERE id = ? FOR UPDATE` (estado, modalidad, facturado, tercero, precio_flete, id_cliente, metodo_pago, iva_alicuota, observaciones); rechazar solo `anulado` (se quita el rechazo de `entregado`). `entregada = estado === 'entregado'`. Mantener las validaciones de método (cuenta corriente / saldo a favor) como están.
  - Leer **todas** las líneas (`op_detalle_material` con `mueve_stock`, `es_contenedor`, `dias`, nombre de producto). Con `datos.lineas` se mapea por `id` (cada `id` debe pertenecer a la venta; si no, `Error('Línea inválida.')`); sin `lineas`, el comportamiento actual sobre la primera línea. Cantidad ≤ 0 o vacía y precio vacío conservan el valor actual; contenedor exige cantidad entera (mensaje actual).
  - Si `facturado = 1` y cambia cualquier cantidad/precio/flete/total respecto de lo guardado → `throw new Error('Ya está facturada: no se puede cambiar el monto, la cantidad ni los precios.')` antes de escribir.
  - Stock por línea con `mueve_stock && dias == null` y `delta ≠ 0`: entregada → `UPDATE stock SET cantidad_actual = GREATEST(0, cantidad_actual - ?)`; si no, el `cant_pendiente_entregar` de hoy.
  - UPDATE del encabezado: para `modalidad = 'flete'` el actual; para cantera solo `metodo_pago`, `observaciones`, `precio_flete`, `monto_total`, `fecha_emision` (no exige calle/obra ni toca fecha/hora/zona/domicilio/obra).
  - Cantera: la descripción nueva se arma así — prefijo viejo = líneas viejas como `` `${producto} x${cantidad}` `` unidas con `', '`; si `datos.descripcion` empieza con ese prefijo, se reemplaza por el prefijo nuevo; si no, se guarda tal cual.
  - `datos.tercero !== undefined` → `Tercero.guardarEnOp(id, datos.tercero, {}, q)` (require perezoso de `../services/tercero.service`).
  - Mantener al final `sincronizarCargoCC(id, q, { moverFecha })`. Devolver `{ entregada, cobroCorregido: false }`.

- [ ] **Step 5: Correr todo el archivo y ver que pasan**, más `tests/nro-factura-operaciones.test.js` y `tests/consistencia-db.test.js` (usan `actualizarViaje`). Esperado: todo ok.

- [ ] **Step 6: Commit** — `git add src/models/ventas.model.js tests/venta-entregada-editar.test.js docs/superpowers && git commit -m "feat(ventas): actualizarVenta edita entregadas y cantera, con stock por diferencia"`.

---

### Task 2: Modelo — corregir el cobro y auditar

**Files:**
- Modify: `src/models/ventas.model.js` (junto a `sincronizarCargoCC`, ~línea 443; llamado desde `actualizarVenta`)
- Test: `tests/venta-entregada-editar.test.js`

**Interfaces:**
- Consumes: `actualizarVenta` (Tarea 1); `Tercero.borrarDeTransaccion(idTransaccion, q)`, `Tercero.egresoDeCobro({ id_transaccion, id_op_encabezado, monto, fecha, cliente, tipo }, q)` de `src/services/tercero.service.js`; `registrarAuditoria({ entidad_tipo, entidad_id, accion, usuario, detalle })` de `src/utils/auditoria.js`.
- Produces:
  - `VentasModel.descripcionDeCobro(op: { modalidad, observaciones, domicilio_calle, domicilio_altura, obra }) → string`: viaje (`modalidad === 'flete'`) → `[destino ? 'Viaje a ' + destino : 'Venta con viaje', observaciones].filter(Boolean).join(' — ')` con `textoDestino`; cantera → `observaciones || ''` (es lo que arman `entregar`, la hoja de ruta y `finalizarCantera`).
  - `VentasModel.corregirCobro(idOp, { terceroAntes?: string|null }, q = query) → Promise<boolean>` (true si cambió algo).
  - `actualizarVenta` ahora devuelve `cobroCorregido` real y escribe la auditoría.

- [ ] **Step 1: Escribir las pruebas que fallan** (`describe('modelo: el cobro acompaña')`; los fixtures de la Tarea 1; para el tercero copiar el objeto de ejemplo de `tests/pago-tercero-unico.test.js`):
  - `efectivo: el monto cambia y la fecha de cobro no`: viaje 2 × 1000, guardar `fecha` y `descripcion` de la transacción; subir a 5 → única transacción con `monto = 5000`, misma `fecha`, `descripcion` igual a `VentasModel.descripcionDeCobro` de la venta.
  - `sin cambios: todo queda idéntico` (Review Focus 1): viaje con método transferencia y tercero; guardar dos veces los mismos datos → la fila de `transacciones`, el `id` del egreso `origen = 'tercero'`, el cargo y `COUNT(*)` de `auditoria` (`accion = 'editar_entregada'`) sin variación.
  - `para facturar: la transacción lleva el IVA` (Review Focus 2): `UPDATE op_encabezado SET para_facturar = 1, iva_alicuota = 21` antes de entregar (viaje 1 × 1000: transacción 1210) → editar con `cantidad: 1, precioProducto: 2000` → transacción `2420`. Facturación calcula una venta desde `monto_total` (`facturacion.model.js:90`), así que `monto_facturar` no se toca.
  - `efectivo → cuenta corriente`: cliente con `crearCliente({ cuentaCorriente: true })` → `transacciones.metodo_pago = 'cuenta_corriente'`, un solo `movimientos_cuenta` tipo `deuda` por `−total`, saldo del cliente `−total`.
  - `falla a mitad` (Review Focus 3): cliente **sin** CC, pasar a `cuenta_corriente` y subir cantidad → `assert.rejects`; stock, `monto_total` y transacción sin cambios.
  - `cuenta corriente con pago aplicado` (Review Focus 4): venta CC 2000 entregada, `ClientesModel.agregarMovimiento(cli, { tipo: 'pago', monto: 500, … })`, editar con `cantidad: 1, precioProducto: 3000` → cargo `−3000` y saldo `−2500`.
  - `transferencia con tercero: el egreso sigue al monto`: cambiar monto → un solo egreso `origen = 'tercero'` por la transacción con el monto nuevo; cambiar a efectivo → ninguno.
  - `pendiente de cobro (sin transacción)`: `DELETE FROM transacciones WHERE id_op_encabezado = ?` → editar monto → no se crea transacción, el total cambia, no falla.
  - `más de un cobro`: insertar una segunda transacción de la venta → cambiar monto rechaza con `/más de un cobro/`; cambiar solo la dirección guarda.
  - `auditoría`: editar monto de 2000 a 3000 → una fila `entidad_tipo = 'operacion'`, `accion = 'editar_entregada'`, `entidad_id = id`, `id_usuario = usuario`, y en `detalle` (JSON) `antes.total = 2000`, `despues.total = 3000`; editar solo la dirección → ninguna fila nueva.

- [ ] **Step 2: Correr y ver que fallan** (mismo comando). Esperado: fallan por transacción sin corregir / `descripcionDeCobro is not a function`.

- [ ] **Step 3: Implementar `VentasModel.descripcionDeCobro` y `VentasModel.corregirCobro`** (definidos como `VentasModel.x = async function …` debajo de `sincronizarCargoCC`). Algoritmo de `corregirCobro`: leer la venta (`SQL_TOTAL AS total`, estado, tipo_op, modalidad, método, tercero, datos para la descripción); si no es `M` entregada → `false`. Leer transacciones tipo ≠ `'Ajuste'`; ninguna → `false`. `cambiaMonto` (|total − cobrado| > 0,005), `cambiaMetodo` (método de la venta ≠ `metodo_pago || 'efectivo'` de la transacción), `cambiaTercero` (`op.tercero` ≠ `terceroAntes`), `cambiaDesc`. Con más de una transacción y (`cambiaMonto` o `cambiaMetodo`) → `Error('Esta venta tiene más de un cobro: el monto y el método de pago no se cambian desde acá.')`. Con una: actualizar `monto` (redondeado a 2 decimales), `metodo_pago` y `descripcion`; si cambió monto, método o tercero → `Tercero.borrarDeTransaccion` y, si el método es `transferencia`, `Tercero.egresoDeCobro` con el monto nuevo y la `fecha`, `cliente`, `tipo` de la transacción. No tocar `fecha`.
- [ ] **Step 4: Cablear en `actualizarVenta`**: guardar `terceroAntes` (columna `tercero` leída al inicio), y tras actualizar encabezado/líneas/tercero y antes de `sincronizarCargoCC`, si `entregada`, `cobroCorregido = await VentasModel.corregirCobro(id, { terceroAntes }, q)`. Después de la transacción, si `entregada` y cambió el total, el método o alguna cantidad/precio → `registrarAuditoria({ entidad_tipo: 'operacion', entidad_id: id, accion: 'editar_entregada', usuario: opciones.usuario, detalle: { nro_op, cliente_id, antes: { total, metodo_pago, lineas }, despues: { total, metodo_pago, lineas } } })` (`lineas`: `[{ id, cantidad, precio }]`).

- [ ] **Step 5: Correr el archivo completo y las suites vecinas**: `tests/estado-pago-operacion.test.js`, `tests/saldos-unificados.test.js`, `tests/facturacion-iva.test.js`, `tests/cargo-fecha-operacion.test.js`. Esperado: todo ok.

- [ ] **Step 6: Commit** — `git commit -am "feat(ventas): editar una entregada corrige la transacción, el egreso a tercero y deja auditoría"` (incluir el test).

---

### Task 3: Controlador y botón Editar

**Files:**
- Modify: `src/models/ventas.model.js` (`obtenerViaje` ~línea 303), `src/controllers/ventas.controller.js` (`editarViaje` ~470, `actualizarViaje` ~494), `views/pages/ventas/detalle.ejs:23`
- Test: `tests/venta-entregada-editar.test.js`

**Interfaces:**
- Consumes: `VentasModel.actualizarVenta` (Tareas 1–2).
- Produces: `obtenerViaje(id)` agrega `esCantera: boolean` (`modalidad !== 'flete'`), `entregada: boolean`, `lineas: Array<{ id, producto, esContenedor, cantidad, precio }>`; la vista `pages/ventas/editar_viaje` recibe además `viaje.facturado` (ya existe). Campos de formulario de cantera: `cantidad_<idLinea>` y `precio_<idLinea>`.

- [ ] **Step 1: Escribir las pruebas que fallan** (`describe('controlador y detalle')`):
  - `editarViaje` de un viaje entregado → `r.vista === 'pages/ventas/editar_viaje'` y `r.data.viaje.entregada === true`; de una cantera → `esCantera === true` y `lineas.length === 2`; de una anulada → redirect a `/ventas/:id` con flash `error`.
  - `actualizarViaje` de una cantera con `body { metodoPago: 'efectivo', fechaCompra: '2026-11-10', ['cantidad_' + l1]: '3', ['precio_' + l1]: '1000', ['cantidad_' + l2]: '1', ['precio_' + l2]: '2500' }` → redirect `/ventas/:id`, flash `success` que empieza con `Venta actualizada`, stock y total corregidos. Con un cambio de monto el flash incluye `cobro`; el de un viaje no entregado sigue siendo `Viaje actualizado.`.
  - Detalle: `llamar(VentasController, 'detalle', …)` + `renderVista` → `href="/ventas/<id>/editar"` presente en viaje entregado y cantera; ausente en anulada.

- [ ] **Step 2: Correr y ver que fallan.**
- [ ] **Step 3: Implementar.** `obtenerViaje`: los tres campos nuevos (`lineas` desde `op.detalles`). `editarViaje`: quitar el rechazo de `entregado` (queda `anulado`); `actualizarViaje`: armar `lineas` desde las claves `cantidad_<id>`/`precio_<id>` del body (`undefined` si no hay ninguna), pasar `{ ...req.body, tercero, lineas }` y `{ usuario: req.session.user?.id }` a `actualizarVenta`, y **dejar de llamar** a `Tercero.guardarEnOp` (lo hace el modelo); mensajes: `entregada && cobroCorregido` → `Venta actualizada: se corrigieron el cobro, el stock y la cuenta del cliente.`; `entregada` → `Venta actualizada.`; si no → `Viaje actualizado.`. `detalle.ejs:23`: mostrar Editar si `op.estado !== 'anulado'` (sin exigir `flete` ni `!entregado`).
- [ ] **Step 4: Correr el archivo, `tests/nro-factura-operaciones.test.js` y `tests/descuentos-vistas.test.js`.** Esperado: ok.
- [ ] **Step 5: Commit** — `git commit -am "feat(ventas): el controlador y el detalle abren la edición a entregadas y cantera"`.

---

### Task 4: Formulario de edición

**Files:**
- Modify: `views/pages/ventas/editar_viaje.ejs`
- Test: `tests/venta-entregada-editar.test.js`

**Interfaces:**
- Consumes: `viaje.esCantera`, `viaje.entregada`, `viaje.facturado`, `viaje.lineas` (Tarea 3).

- [ ] **Step 1: Escribir las pruebas que fallan** (`describe('formulario de edición')`, `renderVista(r.vista, { ...r.data, user })` sobre `editarViaje`):
  - Entregada: contiene `ya fue entregada` (aviso: "si cambiás cantidad, precio o método se corrigen el stock, el cobro y la cuenta del cliente"); una no entregada, no.
  - Cantera: **no** hay `name="calle"`, `name="fecha"`, `name="hora"`, `name="zona"`, `name="precioFlete"`, `name="cantidad"`; sí `name="cantidad_<id>"` y `name="precio_<id>"` por cada línea, `name="fechaCompra"` y `name="metodoPago"`.
  - Viaje no entregado: sigue con `name="calle"`, `name="cantidad"`, `name="precioProducto"` (sin regresión).
  - Facturada: `cantidad`/`precio`/`precioFlete`/`precioTotal`/`editarTotal` con `disabled` y el texto `Ya está facturada` junto al monto; `calle` y `descripcion` siguen habilitados.
  - El `<script>` inline de cada variante (cantera, facturada, viaje) compila: extraer el contenido de `<script>` y `new vm.Script(js)` sin error.
- [ ] **Step 2: Correr y ver que fallan.**
- [ ] **Step 3: Implementar en `editar_viaje.ejs`**: aviso de entregada arriba del formulario; `← Detalle` en vez de `← Detalle viaje`; con `esCantera`, ocultar la fila Fecha de envío/Hora, la sección Dirección y el flete, y reemplazar el bloque Producto/cantidad/precio por una tabla con una fila por línea (producto en solo lectura, `cantidad_<id>` con `step="1"` si `esContenedor`, `precio_<id>`, subtotal calculado); con `facturado`, `disabled` en los campos de monto con el aviso. El script: sumar las líneas (cantera) o cantidad × precio (viaje), y proteger los `getElementById` de campos que no existen (`calle`, `obra`).
- [ ] **Step 4: Correr el archivo completo.** Esperado: ok.
- [ ] **Step 5: Commit** — `git commit -am "feat(ventas): formulario de edición para cantera, entregadas y facturadas"`.

---

### Task 5: Verificación completa

**Files:** ninguno nuevo.

- [ ] **Step 1: Suites relacionadas** con el arnés PGlite, una por una: `venta-entregada-editar`, `nro-factura-operaciones`, `consistencia-db`, `consistencia-vistas`, `estado-pago-operacion`, `estado-pago-remito`, `facturacion-iva`, `facturacion-iva-controlador`, `saldos-unificados`, `cargo-fecha-operacion`, `descuentos`, `filtro-cliente-obra-ventas`, `resumenes-segun-filtros`. Esperado: todo ok (en `main` hoy solo fallan `compras-editar` y `estaciones`, ajenas).
- [ ] **Step 2: Chrome headless contra la app local** (receta de las memorias `probar-ui-chrome-headless` y `pruebas-con-pglite`; servidor de prueba en el scratchpad, no en el repo): con un viaje entregado y una cantera entregada de dos productos, abrir `/ventas/:id/editar`, cambiar cantidad y total, enviar, y leer detalle, `/transacciones` y la cuenta corriente del cliente. Revisar capturas de las tres variantes (viaje, cantera, facturada) y la consola sin errores.
- [ ] **Step 3: Cerrar.** Mostrar al usuario el resultado y **preguntar antes de** mergear (`--no-ff` a `main`) y pushear; recordarle correr `deploy.sh` en el VPS. No mergear ni pushear sin su confirmación.
