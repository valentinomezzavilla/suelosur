# Pago de combustible: "Otro" en camión y chofer — Plan de implementación

> **Para quien ejecute:** usar superpowers:subagent-driven-development (recomendado) o superpowers:executing-plans, tarea por tarea. Los pasos usan casillas (`- [ ]`).

**Objetivo:** que Compras / Pagos permita elegir "Otro" en Vehículo y Chofer de un pago de combustible, para cargas a terceros: el pago se registra con su monto, sin camión ni chofer de la flota.

**Arquitectura:** el `<select>` manda el valor `otro`; el controlador lo convierte en ids nulos y marca el egreso con una columna nueva `egresos.carga_tercero` (0/1). La vista lee esa marca para mostrar "Otro" al editar, en el listado y en el detalle. No toca Flota (`combustible`) ni la cuenta de la estación.

**Tecnología:** Node/Express, EJS, PostgreSQL (`pg`; en pruebas PGlite), `node:test`.

**Diseño:** `docs/superpowers/specs/2026-11-17-combustible-otro-design.md` (aprobado).

## Restricciones globales

- Textos de pantalla en español rioplatense, como el resto del sistema.
- Columna nueva: `ALTER TABLE egresos ADD COLUMN IF NOT EXISTS carga_tercero INTEGER NOT NULL DEFAULT 0` (aditiva; no modifica filas existentes).
- Valor del desplegable: `otro` (en minúscula) en los dos selects.
- "Otro" solo vale en categorías con el campo `carga`. En cualquier otra, el valor `otro` se ignora (id nulo, sin error).
- "Otro" en **cualquiera** de los dos campos marca **toda** la carga como a tercero (ids de camión y chofer nulos).
- "Otro" + "Impacta en autonomía del camión" se rechaza en el servidor.
- El `<select name="id_chofer" id="selChofer" class="form-select" required>` conserva exactamente ese marcado (lo verifica `tests/compras-combustible-carga.test.js`).
- No se commitea, mergea ni despliega sin que el usuario lo pida (trabajo en la rama `feat/combustible-otro`).

## Revisar en especial

1. Categoría **sin** campo `carga` que recibe `id_vehiculo = 'otro'` (formulario manipulado): no debe fallar por tipo BIGINT; guarda `id_vehiculo` nulo y `carga_tercero` 0. → prueba en Tarea 2.
2. Solo **uno** de los dos en "Otro" (formulario viejo o manipulado): la carga se trata igual como a tercero. → Tarea 2.
3. "Otro" con "Impacta" tildado: se rechaza y no se guarda nada. → Tarea 2.
4. Editar un pago que tiene carga en Flota y pasarlo a "Otro": se borra la carga de Flota y el pago queda sin `id_combustible`. → Tarea 3.
5. Un pago viejo sin chofer (`carga_tercero = 0`) no se muestra como "Otro" al editar; y volver de "Otro" a camión y chofer reales limpia la marca. → Tareas 3 y 4.

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `src/config/db.js` | Columna `egresos.carga_tercero` en `initDB()` (junto a `id_combustible`, ~línea 1516). |
| `tests/helpers/db.js` | La misma columna dentro de la transacción de prueba (junto a `id_combustible`, línea 76). |
| `src/models/egresos.model.js` | `crear` y `editar` guardan `carga_tercero`. |
| `src/controllers/compras.controller.js` | `camionYChofer`, y su uso en `crear` y `actualizar`. |
| `views/pages/compras/form.ejs` | Opción "Otro", vinculación de los dos selects, "Impacta" desactivado. |
| `views/pages/compras/index.ejs` | "Otro" en el renglón del listado y en el detalle. |
| `tests/combustible-otro.test.js` (nuevo) | Todas las pruebas de esta funcionalidad. |

---

### Tarea 0: Arnés de pruebas y línea de base (sin commit)

- [ ] **Paso 1: Copiar el arnés PGlite al scratchpad**

Copiar la carpeta `…/048008ffb8ab7c6e/33cbfae5-4392-4843-bbcf-62ad1ccbb9a2/scratchpad/pglite` (con `node_modules`) a `…/048008ffb8ab7c6e/433642d9-a4ae-44c9-ae35-8826e1201fa3/scratchpad/pglite` y cambiar `SP` en `correr.sh` a la ruta nueva. Las pruebas no pueden usar el `.env`: apunta a otra base.

- [ ] **Paso 2: Línea de base**

Run (desde la raíz del proyecto): `bash <scratchpad>/pglite/correr.sh tests/compras-combustible-carga.test.js tests/combustible-campos.test.js tests/compras-detalle.test.js tests/compras-editar.test.js tests/estaciones.test.js`
Expected: todo pasa salvo las fallas viejas ya conocidas de `compras-editar` y `estaciones` (2 en cada una, según mis notas del 2026-11-16). Anotar cuáles son para comparar al final.

---

### Tarea 1: Columna `carga_tercero` y modelo

**Archivos:**
- Modificar: `src/config/db.js` (después del `ALTER` de `id_combustible`, ~1516), `tests/helpers/db.js:76`, `src/models/egresos.model.js` (`crear` ~62-83, `editar` ~243-256)
- Crear: `tests/combustible-otro.test.js`
- Modificar: `docs/superpowers/specs/2026-11-17-combustible-otro-design.md` (quitar "y copia en `migrations/`": la columna va solo en `initDB()` y en el arnés, igual que `id_combustible`)

**Interfaces:**
- Produce: `EgresosModel.crear({ …, carga_tercero })` guarda `carga_tercero ? 1 : 0`. `EgresosModel.editar(id, datos, { carga })` guarda `datos.carga_tercero ? 1 : 0`. `egresos.carga_tercero` llega en `listar`/`obtenerDetalle` (ya traen `e.*`).

- [ ] **Paso 1: Escribir la prueba que falla** en `tests/combustible-otro.test.js`. Copiar del archivo `compras-combustible-carga.test.js` el encabezado, `llamar(ctrl, accion, {...})` y el `before` (categoría `combustible` con campos `['vehiculo','estacion','carga']`, `camion`, `estacion`, `chofer`) y el `base()`. Prueba del bloque `describe('columna carga_tercero')`:
  - `'un pago sin la marca queda en 0'`: `EgresosModel.crear({ categoria:'combustible', monto:1000 })` y leer la fila → `Number(carga_tercero) === 0`.
  - `'crear guarda la marca'`: con `carga_tercero: 1` y sin camión ni chofer → `carga_tercero` 1, `id_vehiculo` y `id_chofer` nulos.
  - `'editar cambia la marca'`: `EgresosModel.editar(id, { fecha:'2026-10-25', monto:1000, carga_tercero: 1 })` → 1; luego con `carga_tercero: 0` → 0.

- [ ] **Paso 2: Correr y ver que falla**

Run: `bash <scratchpad>/pglite/correr.sh tests/combustible-otro.test.js`
Expected: FAIL (`column "carga_tercero" does not exist`).

- [ ] **Paso 3: Implementar.** La columna en `initDB()` con la sentencia de "Restricciones globales" y un comentario de una línea (qué marca); la misma sentencia en `abrir()` de `tests/helpers/db.js`. En `EgresosModel.crear` agregar el parámetro `carga_tercero`, la columna al `INSERT`, un `?` más al `VALUES` y `carga_tercero ? 1 : 0` al final de los parámetros; en `editar`, `carga_tercero = ?` en el `UPDATE` con `datos.carga_tercero ? 1 : 0` (mismo orden en los parámetros). Actualizar el comentario de `crear` (lista de campos del pago de combustible).

- [ ] **Paso 4: Correr y ver que pasa**

Run: `bash <scratchpad>/pglite/correr.sh tests/combustible-otro.test.js tests/compras-editar.test.js`
Expected: PASS las nuevas; `compras-editar` igual que la línea de base.

---

### Tarea 2: Alta de un pago con "Otro"

**Archivos:**
- Modificar: `src/controllers/compras.controller.js` (nueva función después de `faltantesCarga`, ~49; `crear` ~183-224)
- Test: `tests/combustible-otro.test.js`

**Interfaces:**
- Consume: `EgresosModel.crear({ …, carga_tercero })` (Tarea 1).
- Produce: `function camionYChofer(body, conCarga) -> { tercero: boolean, id_vehiculo: string|null, id_chofer: string|null }`. Con `conCarga` y `body.id_vehiculo === 'otro'` o `body.id_chofer === 'otro'`: `{ tercero: true, id_vehiculo: null, id_chofer: null }`. Si no: `tercero` false y cada id es `null` si vale `'otro'` o está vacío, o el valor recibido. La usa también la Tarea 3.

- [ ] **Paso 1: Escribir las pruebas que fallan** (`describe('alta con "Otro"')`, todas con `ComprasController.crear` y el `base()` de la Tarea 1):
  - `'Otro en camión y chofer registra el pago sin camión ni chofer'`: body `{ ...base(), id_vehiculo:'otro', id_chofer:'otro' }` → `url === '/compras'`, flash `success`; la fila nueva (buscar por `descripcion` única) tiene `id_vehiculo` y `id_chofer` nulos, `carga_tercero` 1, `Number(monto) === 90000`, `id_combustible` nulo; `litros` 75.5 y `nro_factura` se guardan igual; ninguna fila nueva en `combustible` para `camion`.
  - `'con Otro, la cuenta de la estación solo recibe el pago'`: `EstacionesModel.cuenta(estacion)` → `debe === 0`, `haber === 90000`, `saldo === -90000`.
  - `'Otro solo en el chofer también es a tercero'` (revisar 2): body `{ ...base(), id_chofer:'otro' }` (camión real) → fila con `id_vehiculo` nulo, `carga_tercero` 1.
  - `'Otro solo en el camión también es a tercero'`: `{ ...base(), id_vehiculo:'otro' }` → `id_chofer` nulo, `carga_tercero` 1 (aunque el chofer sea real).
  - `'Otro con Impacta se rechaza y no guarda nada'` (revisar 3): `{ ...base(), id_vehiculo:'otro', id_chofer:'otro', impacta_flota:'1', km_al_cargar:'100' }` → `url === '/compras/nueva'`, `flashes[0].msg` coincide con `/Otro/` y `/Impacta en autonomía del camión/`; 0 egresos y 0 cargas nuevas.
  - `'un pago con camión y chofer reales sigue igual'`: `base()` → `carga_tercero` 0 y ids guardados.
  - `'en una categoría sin carga, "otro" se ignora'` (revisar 1): crear con `CategoriasEgresoModel.crear({ etiqueta:'Peaje prueba otro', campos:['vehiculo'] })`, `obtener(id).clave`, y `crear` con `{ categoria: clave, fecha:'2026-10-25', monto:'5000', metodo_pago:'efectivo', id_vehiculo:'otro' }` → `url === '/compras'`, `id_vehiculo` nulo, `carga_tercero` 0.

- [ ] **Paso 2: Correr y ver que fallan**

Run: `bash <scratchpad>/pglite/correr.sh tests/combustible-otro.test.js`
Expected: FAIL (el chofer `otro` rechazado por obligatorio, o `invalid input syntax for type bigint: "otro"`).

- [ ] **Paso 3: Implementar `camionYChofer`** como se describe en Interfaces (constante `OTRO = 'otro'` arriba, con un comentario de una línea: carga a un tercero, ajeno a la empresa). En `crear`: calcular `const cc = camionYChofer(req.body, cat.campos.includes('carga'))` después de armar `cat`; el egreso toma `id_vehiculo: cat.campos.includes('vehiculo') ? cc.id_vehiculo : null`; en el bloque de la carga, el chofer es obligatorio salvo que `cc.tercero` (mismo mensaje de siempre); el `Object.assign` usa `id_chofer: cc.id_chofer` y suma `carga_tercero: cc.tercero ? 1 : 0`; antes de `faltantesCarga`, si `cc.tercero && req.body.impacta_flota === '1'` → `req.flash('error', 'Con "Otro" la carga no va a ningún camión de la flota: destildá "Impacta en autonomía del camión".')` y `res.redirect('/compras/nueva')`.

- [ ] **Paso 4: Correr y ver que pasan**

Run: `bash <scratchpad>/pglite/correr.sh tests/combustible-otro.test.js tests/compras-combustible-carga.test.js`
Expected: PASS ambos archivos.

---

### Tarea 3: Edición de un pago con "Otro"

**Archivos:**
- Modificar: `src/controllers/compras.controller.js` (`actualizar`, ~297-337)
- Test: `tests/combustible-otro.test.js`

**Interfaces:**
- Consume: `camionYChofer(body, conCarga)` (Tarea 2), `EgresosModel.editar` con `datos.carga_tercero` (Tarea 1).

- [ ] **Paso 1: Escribir las pruebas que fallan** (`describe('edición con "Otro"')`, con `ComprasController.actualizar`, `params: { id }`; crear antes cada pago con `crear` como en la Tarea 2):
  - `'pasar un pago con carga en Flota a Otro borra la carga'` (revisar 4): alta con camión, chofer e `impacta_flota:'1'` (1 carga en `combustible`); `actualizar` con `{ ...base(), id_vehiculo:'otro', id_chofer:'otro' }` y sin `impacta_flota` → `url === '/compras'`; el egreso tiene `id_vehiculo` y `id_chofer` nulos, `carga_tercero` 1, `id_combustible` nulo; la carga ya no existe en `combustible`.
  - `'Otro con Impacta se rechaza al editar'`: `actualizar` con `id_vehiculo:'otro', id_chofer:'otro', impacta_flota:'1'` → `url === '/compras/<id>/editar'`, mensaje con `/Otro/`; el egreso no cambió.
  - `'volver de Otro a camión y chofer reales limpia la marca'` (revisar 5): un pago "Otro" y `actualizar` con `base()` → `carga_tercero` 0, `id_vehiculo` y `id_chofer` reales.
  - `'en una categoría sin carga, "otro" se ignora al editar'` (revisar 1): crear un pago de la categoría `'Peaje prueba otro'` (campos `['vehiculo']`, como en la Tarea 2) y `actualizar` con `{ monto:'6000', id_vehiculo:'otro' }` → `url === '/compras'`, `id_vehiculo` nulo, `carga_tercero` 0.

- [ ] **Paso 2: Correr y ver que fallan**

Run: `bash <scratchpad>/pglite/correr.sh tests/combustible-otro.test.js`
Expected: FAIL (`bigint: "otro"` o `carga_tercero` sin cambiar).

- [ ] **Paso 3: Implementar.** En `actualizar`, dentro de "Resto de las categorías": `const cc = camionYChofer(b, usa('carga'))`; `datos.id_vehiculo` toma `usa('vehiculo') ? cc.id_vehiculo : e.id_vehiculo`; `datos` suma `carga_tercero: e.carga_tercero` por defecto; en el bloque `if (usa('carga'))` el chofer es obligatorio salvo `cc.tercero`, `Object.assign` usa `id_chofer: cc.id_chofer` y `carga_tercero: cc.tercero ? 1 : 0`, y si `cc.tercero && impacta` rechaza con el mismo mensaje de la Tarea 2 y `res.redirect(volver)`. Agregar `'carga_tercero'` a la lista de `campos` de `auditarEdicion`.

- [ ] **Paso 4: Correr y ver que pasan**

Run: `bash <scratchpad>/pglite/correr.sh tests/combustible-otro.test.js tests/compras-editar.test.js`
Expected: PASS las nuevas; `compras-editar` igual que la línea de base.

---

### Tarea 4: Pantallas (formulario, listado y detalle)

**Archivos:**
- Modificar: `views/pages/compras/form.ejs` (`selVehiculo` ~168-172, `selChofer` ~188-192, `<script>` ~339-369), `views/pages/compras/index.ejs` (~55, ~74, ~290-291)
- Test: `tests/combustible-otro.test.js`

**Interfaces:**
- Consume: `egreso.carga_tercero` (Tarea 1; `ed.carga_tercero` en el formulario, `e.carga_tercero` en el listado).

- [ ] **Paso 1: Escribir las pruebas que fallan** (`describe('pantallas')`, con `renderVista(v.vista, { ...v.data, scripts: [] })` como en `compras-combustible-carga.test.js`):
  - `'el formulario ofrece Otro en camión y chofer'`: `nueva` → el HTML coincide con `/id="selVehiculo"[\s\S]*?<option value="otro"[^>]*>Otro<\/option>/` y con `/id="selChofer"[\s\S]*?<option value="otro"[^>]*>Otro<\/option>/`, y sigue el `<select name="id_chofer" id="selChofer" class="form-select" required>`.
  - `'al editar un pago a tercero, Otro viene elegido'`: `editar` de un pago "Otro" → 2 coincidencias de `/<option value="otro"[^>]*selected[^>]*>Otro<\/option>/g`.
  - `'un pago viejo sin chofer no aparece como Otro'` (revisar 5): crear con `EgresosModel.crear({ categoria:'combustible', monto:1000, id_vehiculo: camion })` (sin chofer); `editar` → 0 coincidencias de la regex anterior.
  - `'el listado y el detalle muestran Otro'`: un pago "Otro" (alta de la Tarea 2) y `index` con `preset:'rango'`, `fechaDesde`/`fechaHasta` del pago → el HTML contiene `Camión y chofer: Otro` y, dentro de `data-detalle`, `&#34;Vehículo&#34;,&#34;Otro&#34;` y `&#34;Chofer&#34;,&#34;Otro&#34;`.

- [ ] **Paso 2: Correr y ver que fallan**

Run: `bash <scratchpad>/pglite/correr.sh tests/combustible-otro.test.js`
Expected: FAIL (no hay opción `otro` ni texto "Otro").

- [ ] **Paso 3: Implementar el formulario.**
  - Al final de las opciones de `selVehiculo` y de `selChofer`, solo si `catsCon('carga')` no está vacío: `<option value="otro" data-solo-carga="<%= catsCon('carga') %>" <%= ed && Number(ed.carga_tercero) ? 'selected' : '' %>>Otro</option>`.
  - Debajo de los dos selects (dentro del bloque de la carga), `<small id="avisoOtro" class="text-muted d-block" style="display:none">`: "Carga a tercero: se registra el pago sin camión ni chofer de la flota." y, solo si `ed && ed.id_combustible`, sumar " Al guardar se quita la carga del camión."
  - Script: (a) en `toggle()`, para cada `option[data-solo-carga]`: mostrarla y habilitarla solo si la categoría elegida figura en su lista; si no, ocultarla, deshabilitarla y, si estaba elegida, dejar el select en `''`. (b) Vincular: cuando uno de los dos selects pasa a `otro`, el otro también; cuando uno deja `otro` y el otro estaba en `otro`, el otro vuelve a `''`. (c) `aplicarImpacta()` pasa a calcular `const otro = [selVehiculo, selChofer].some(s => s && !s.disabled && s.value === 'otro')`: con `otro`, destilda y deshabilita "Impacta" y muestra `#avisoOtro`; sin `otro`, "Impacta" queda habilitado solo si su bloque está visible. Todo se vuelve a aplicar en el `change` de ambos selects y al cargar (`toggle()` ya se llama al final).

- [ ] **Paso 4: Implementar el listado y el detalle** en `index.ejs`: en `detalleCompra`, `['Vehículo', e.vehiculo_nombre || (Number(e.carga_tercero) ? 'Otro' : null)]` y `['Chofer', e.chofer_nombre || (Number(e.carga_tercero) ? 'Otro' : null)]`; en el arreglo `carga` del renglón, antes del chofer, `Number(e.carga_tercero) ? 'Camión y chofer: Otro' : null`.

- [ ] **Paso 5: Correr y ver que pasan**

Run: `bash <scratchpad>/pglite/correr.sh tests/combustible-otro.test.js tests/compras-combustible-carga.test.js tests/compras-detalle.test.js`
Expected: PASS todo.

- [ ] **Paso 6: Probar el JavaScript en Chrome headless** (las pruebas del servidor no cubren el script; ver mi nota "Probar UI en Chrome headless"). Adaptar `servidor.js` y `probar_pago.html` del arnés copiado en la Tarea 0 (app real sobre PGlite con sesión inyectada) para abrir `/compras/nueva` con la categoría Combustible en un iframe y verificar, volcando un JSON a un `<pre>`: (1) elegir "Otro" en Vehículo deja Chofer en "Otro"; (2) con "Otro", "Impacta" queda destildado y deshabilitado y aparece el aviso; (3) volver a un camión real deja el chofer en "Seleccionar…" y rehabilita "Impacta"; (4) con otra categoría (sin carga) la opción "Otro" no se ofrece; (5) enviar el formulario con "Otro" guarda el pago (`carga_tercero = 1`). Sin errores en la consola (`--enable-logging=stderr`). Mirar una captura del formulario.

---

### Tarea 5: Regresión y cierre

- [ ] **Paso 1: Correr los archivos relacionados**

Run: `bash <scratchpad>/pglite/correr.sh tests/combustible-otro.test.js tests/compras-combustible-carga.test.js tests/combustible-campos.test.js tests/compras-detalle.test.js tests/compras-editar.test.js tests/estaciones.test.js tests/vincular-estacion.test.js tests/flota-eliminar.test.js`
Expected: lo nuevo pasa; el resto igual que la línea de base de la Tarea 0.

- [ ] **Paso 2: Revisar el diff** (`git diff --stat` y `git status`): solo los archivos de "Estructura de archivos" más el diseño y este plan. Dejar los cambios sin commitear y preguntarle al usuario si commitea, mergea a `main` y despliega.
