# Anular un pago de cliente desde Transacciones — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** que cada fila `PAG-NNNNNN` de Transacciones tenga un ícono "Anular pago" con vista previa de las operaciones que vuelven a pendiente y motivo obligatorio.

**Architecture:** se reutiliza `ClientesModel.anularPago` (el saldo y el estado de pago de cada operación se deducen de los pagos vigentes). Se suma en el modelo una vista previa que compara la imputación de la cuenta con y sin el pago, dos rutas en Transacciones (GET JSON + POST) y un modal con su script.

**Tech Stack:** Node + Express, EJS, PostgreSQL (`pg`; pruebas con `node:test` sobre PGlite), JS de navegador sin framework.

**Spec:** `docs/superpowers/specs/2026-11-25-anular-pago-transacciones-design.md`

## Global Constraints

- Solo roles `admin_contable` y `dueno` (`roles('admin_contable','dueno')`) en las dos rutas y para ver el ícono (`puedeCorregir` en la vista).
- Acción de fila = `partials/btn_icono` con `etiqueta` (tooltip + `aria-label`), sin texto visible; la clase `btn-anular-pago` engancha el script.
- Ids BIGINT vuelven como number: comparar con `String()` contra `dataset` y `value`.
- Motivo obligatorio, máximo 300 caracteres (igual que `ClientesController.anularPago`).
- Mensaje de bloqueo por cheque: el mismo que ya da `ClientesModel.anularPago` ("anulalo desde Cheques (deshabilitando el cheque)").
- Textos de la interfaz en español rioplatense (voseo), como el resto de la app.
- Pruebas: `.env` apunta a una base muerta; correr con el arnés PGlite de la memoria `pruebas-con-pglite` (`correr.sh --test tests/<archivo>`). Un archivo de prueba llama UNA vez a `prueba.abrir()` / `prueba.cerrar()`.

## Review Focus

- Un pago sin obras elegidas que cubría a lo más viejo: al anular otro pago puede correrse a otra operación; la vista previa debe mostrar la que realmente queda pendiente (test en Tarea 1).
- Pago mayor que las deudas (parte quedó "a favor"): la vista previa informa cuánto saldo a favor se quita (Tarea 1).
- Pago con cheque, ya anulado, o que no es un pago: bloqueado en la vista previa y en el POST (Tareas 1 y 2).
- Anular sin motivo o con solo espacios: no anula nada (Tarea 2).
- Usuario sin permiso: ni ve el ícono ni pasa por las rutas (Tareas 2 y 3).

---

### Task 1: Modelo — vista previa y anulación auditada

**Files:**
- Modify: `src/models/clientes.model.js` (junto a `anularPago`, ~línea 562)
- Modify: `src/controllers/clientes.controller.js:316-330` (usa `anularPagoAuditado`)
- Test: `tests/anular-pago-transacciones.test.js` (nuevo; `before`/`after` de primer nivel como `tests/filtro-cliente-obra-transacciones.test.js`)

**Interfaces:**
- Produces:
  - `ClientesModel.pagoPorId(movId, q = query) -> Promise<row | undefined>` (fila de `movimientos_cuenta`).
  - `ClientesModel.vistaPreviaAnularPago(movId) -> Promise<{ idPago, clienteId, cliente, monto, metodo_pago, fecha, descripcion, puede, bloqueos: string[], operaciones: [{ id, etiqueta, tipo, remito, obra, quitado }], aFavorQuitado, saldoAntes, saldoDespues }>`. `etiqueta` = `OP-0308` (o la descripción del cargo a mano, `id` null); `tipo` = mismo texto que `tipoTexto` de `estadoPago.model`. Con pago inexistente: `puede:false`, `bloqueos:['El pago no existe.']`.
  - `ClientesModel.anularPagoAuditado(movId, clienteId, { usuario, motivo }) -> Promise<row>`: llama a `anularPago` y escribe la auditoría (`entidad_tipo:'movimiento_cuenta'`, `accion:'anular_pago'`, mismo `detalle` que hoy escribe el controlador de Clientes).

- [ ] **Step 1: Escribir las pruebas que fallan** en `tests/anular-pago-transacciones.test.js` (datos: cliente con cuenta corriente, ventas `VentasModel.crear` + `sincronizarCargoCC` como en `tests/estado-pago-remito.test.js`; pago con `validarImputaciones` + `agregarMovimiento` + `guardarImputaciones`):
  - `'un pago por remito sobre 4 obras: la vista previa lista las 4 con su importe'` → `puede === true`, `operaciones.length === 4`, cada `quitado` = su importe, `Σ quitado === monto`, `saldoDespues === saldoAntes - monto`, `aFavorQuitado === 0`.
  - `'anularPagoAuditado deja las 4 obras pendientes, mueve el saldo lo previsto y audita'` → `pagadoPorOperacion` de las 4 con `pagado === 0`; `clientes.saldo` igual a `saldoDespues`; una fila en `auditoria` con `accion = 'anular_pago'` y `entidad_id` = el pago; el movimiento queda con `anulado = 1`, `anulado_motivo` = el motivo.
  - `'un pago que no eligió obras y cubría lo más viejo: la vista previa muestra la operación que queda pendiente'` → cargos A (viejo) y B, P1 elige A, P2 sin elegir (cae en B); anular P1 ⇒ `operaciones` = solo B con `quitado` = su importe.
  - `'un pago mayor que las deudas informa el saldo a favor que se quita'` → `aFavorQuitado` = el sobrante.
  - `'bloquea un pago con cheque, uno ya anulado, y un movimiento que no es pago'` → `puede === false` y el mensaje correcto en cada caso (el cheque se crea con una fila en `cheques` con `id_mov_cuenta`; ver sus columnas obligatorias en `src/config/db.js`).
- [ ] **Step 2: Ver que fallan** — `correr.sh --test tests/anular-pago-transacciones.test.js`; esperado: FAIL con "vistaPreviaAnularPago is not a function".
- [ ] **Step 3: Implementar `pagoPorId`, `vistaPreviaAnularPago`, `anularPagoAuditado`** en `clientes.model.js`. Para la vista previa: `imputacionDe(clienteId)` antes y `imputar()` sin ese pago ni sus asignaciones después (`utils/imputacion`); comparar `porOperacion(...).pagado` por operación y el `restante` de los cargos sin operación; `aFavorQuitado = imp.aFavor antes − después`; `saldoAntes = clientes.saldo`, `saldoDespues = saldoAntes − monto`. Datos de la operación (`nro_op`, `nro_remito`, `obra`, `tipo_op`, `modalidad`) con una sola consulta `WHERE id = ANY(?::bigint[])`.
- [ ] **Step 4: Cambiar `ClientesController.anularPago`** para llamar a `ClientesModel.anularPagoAuditado` (sin duplicar la auditoría); el mensaje y el `redirect('back')` quedan igual.
- [ ] **Step 5: Ver que pasan** las pruebas nuevas y `tests/cliente-historial.test.js` (usa la cuenta corriente) — esperado: todas OK.
- [ ] **Step 6: Commit** — `git add src/models/clientes.model.js src/controllers/clientes.controller.js tests/anular-pago-transacciones.test.js && git commit -m "feat(pagos): vista previa de anular un pago y anulación auditada en el modelo"`

### Task 2: Rutas y controlador de Transacciones

**Files:**
- Modify: `src/routes/transacciones.routes.js`
- Modify: `src/controllers/transacciones.controller.js` (junto a `eliminar`)
- Test: `tests/anular-pago-transacciones.test.js`

**Interfaces:**
- Consumes: `ClientesModel.pagoPorId`, `vistaPreviaAnularPago`, `anularPagoAuditado` (Tarea 1).
- Produces:
  - `GET /transacciones/pagos/:id/anular/vista-previa` → `res.json(vistaPrevia)`; ante un error inesperado `res.status(500).json({ error })`.
  - `POST /transacciones/pagos/:id/anular` (body `motivo`) → `flash` + `res.redirect('back')`. Ambas con `auth, roles('admin_contable','dueno')`.
  - `TransaccionesController.vistaPreviaAnularPago(req, res)` y `TransaccionesController.anularPago(req, res)`.

- [ ] **Step 1: Escribir las pruebas que fallan** (helper `llamar` con `body`, como en `tests/filtro-cliente-obra-transacciones.test.js`):
  - `'vistaPreviaAnularPago devuelve el JSON del modelo'`.
  - `'anularPago sin motivo (o con solo espacios) no anula y avisa con error'` → flash `error`, el pago sigue vigente.
  - `'anularPago anula, avisa con el código PAG-… y el pago sale de Transacciones'` → flash `success` con `PAG-` y el código; `MovimientosDineroModel.listar({ categoria: 'pagos_clientes', clienteId })` ya no lo trae; entradas del período bajan por el monto.
  - `'anularPago de un pago con cheque avisa el motivo y no anula'`.
  - `'las dos rutas exigen contable o dueño'` → leer `src/routes/transacciones.routes.js` y comprobar que ambas líneas llevan `roles('admin_contable','dueno')`.
- [ ] **Step 2: Ver que fallan** — esperado: FAIL con "ctrl.anularPago is not a function" o similar.
- [ ] **Step 3: Implementar los dos métodos del controlador y registrar las dos rutas.** `anularPago`: `motivo = String(req.body.motivo || '').trim().slice(0, 300)`; con el pago leído por `pagoPorId` se obtiene `cliente_id` para `anularPagoAuditado`; el aviso de éxito nombra el código (`MovimientosDineroModel.codigo({ origen: 'pago_cliente', id })`) y, si la vista previa tenía `operaciones`, cuántas vuelven a pendiente.
- [ ] **Step 4: Ver que pasan** — esperado: todas OK.
- [ ] **Step 5: Commit** — `git commit -m "feat(transacciones): rutas para ver y confirmar la anulación de un pago de cliente"` (con los archivos de esta tarea).

### Task 3: Ícono, modal y script

**Files:**
- Modify: `views/pages/transacciones/index.ejs` (rama `t.origen === 'pago_cliente'`, ~línea 195; incluir el modal al final)
- Create: `views/partials/modal_anular_pago.ejs`
- Create: `public/js/anularPago.js`
- Modify: `src/controllers/transacciones.controller.js` (`scripts` de `index`: sumar `'/js/anularPago.js'`)
- Test: `tests/anular-pago-transacciones.test.js`

**Interfaces:**
- Consumes: las dos rutas de la Tarea 2.
- Produces: botón `.btn-anular-pago` con `data-id` (id del pago), `data-codigo`, `data-cliente`, `data-monto`; modal `#modal-anular-pago` con `#formAnularPago` (el script le fija `action = /transacciones/pagos/<id>/anular`), `#anularPagoMotivo`, lista de operaciones, saldo antes / después y botón "Sí, anular pago" deshabilitado hasta que haya motivo y no haya bloqueos.

- [ ] **Step 1: Escribir las pruebas que fallan** (render con `renderVista('pages/transacciones/index', data)`, donde `data` sale de `llamar(Transacciones, 'index', …)`):
  - `'la fila PAG tiene el ícono Anular pago (aria-label, data-id) para contable y dueño'`.
  - `'no aparece para administración de ventas ni en las filas de cobros (CAN, VIA, CON)'`.
  - `'la página incluye el modal de anular pago y el script /js/anularPago.js'`.
- [ ] **Step 2: Ver que fallan.**
- [ ] **Step 3: Implementar la vista y el modal.** Botón con `partials/btn_icono` (`icono: 'ban'`, `etiqueta: 'Anular pago'`, `clase: 'btn-outline-danger btn-anular-pago'`) dentro del `.acciones-fila`, antes del enlace a la cuenta corriente, solo con `puedeCorregir`. Modal en el estilo de `modal_estado_pago.ejs` / `tx-modal`: código y cliente en el título, monto, lista de operaciones con importe, saldo antes → después, aviso de saldo a favor si `aFavorQuitado > 0`, campo de motivo con ayuda "Queda registrado junto con tu usuario.".
- [ ] **Step 4: Implementar `public/js/anularPago.js`** siguiendo `public/js/estadoPago.js` (un `fetch` por apertura con contador `pedido` para descartar respuestas viejas; errores del fetch muestran "No se pudo calcular el cambio"; con `bloqueos` muestra los avisos y deja solo "Cerrar"; Escape y clic afuera cierran). Cerrar `'use strict'` con punto y coma (ver memoria `probar-ui-chrome-headless`).
- [ ] **Step 5: Ver que pasan** las pruebas nuevas y `node --check public/js/anularPago.js` — esperado: OK. Compilar la plantilla con el render del test.
- [ ] **Step 6: Commit** — `git commit -m "feat(transacciones): ícono y modal para anular un pago de cliente"`.

### Task 4: Verificación en el navegador y cierre

**Files:** ninguno nuevo (harness en el scratchpad, no se versiona).

- [ ] **Step 1:** Levantar la app con PGlite y sesión de dueño (memorias `pruebas-con-pglite` y `probar-ui-chrome-headless`), con un cliente de 4 obras en un remito y un pago por remito. Compilar el CSS si hace falta (`npx sass src/scss/main.scss public/css/main.css`).
- [ ] **Step 2:** En Chrome headless abrir `/transacciones?categoria=pagos_clientes`, hacer clic en el ícono, comprobar sin errores de consola: aparecen las 4 obras con su importe y el saldo antes / después; el botón confirma solo con motivo; al confirmar la fila desaparece y las 4 obras figuran pendientes en Liquidaciones. Probar además el caso de un pago con cheque (aviso de bloqueo, sin confirmar) y mirar la captura del modal en pantalla ancha y angosta.
- [ ] **Step 3:** Correr `tests/anular-pago-transacciones.test.js`, `tests/botones-icono.test.js`, `tests/filtro-cliente-obra-transacciones.test.js`, `tests/cliente-historial.test.js`, `tests/estado-pago-remito.test.js` y `tests/consistencia-vistas.test.js`; esperado: sin fallas nuevas (las únicas conocidas de la línea de base son `compras-editar` y `estaciones`).
- [ ] **Step 4:** Reportar al usuario el resultado y dejar la rama `feat/anular-pago-transacciones` lista (merge a `main` y push solo con su OK; el deploy lo corre él en el VPS).
