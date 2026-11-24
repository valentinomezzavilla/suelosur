# Filtro de cliente y obra unificado — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que Ventas, Transacciones y Libro de ventas filtren por cliente y obra con el mismo componente que Liquidaciones (escribís → lista; elegís cliente → aparecen sus obras, varias a la vez).

**Architecture:** Se reusa `partials/filtro_cliente_obra` + `buscarCliente.js` + `filtroObra.js`. Un helper de servidor (`ClientesModel.seleccionFiltro`) convierte "cliente + claves de obra" en `{ clienteSel, obras, opIds }`; Ventas y Transacciones agregan `opIds` a su WHERE (`= ANY(?::bigint[])`, como Liquidaciones). Un helper de enlaces (`consulta`) hace que varias obras viajen como `obra=a&obra=b`.

**Tech Stack:** Node + Express + EJS, PostgreSQL (`pg`), `node:test`, SCSS (Bootstrap + propio).

**Spec:** `docs/superpowers/specs/2026-11-24-filtro-cliente-obra-unificado-design.md`

## Global Constraints

- Rama de trabajo: `feat/filtro-cliente-obra-unificado` (ya creada). Nada se sube ni se mergea sin que el usuario lo pida.
- Textos de pantalla en español rioplatense ("Empleado / proveedor", "Elegí un cliente para ver sus obras").
- Cliente en la URL: `clienteId` (solo dígitos; todo lo demás se ignora). Obras: `obra`, repetido una vez por obra (clave de `utils/obras.claveObra`). Las obras solo valen con cliente.
- Enlaces viejos siguen andando: `?id_cliente=` (Ventas) y `?idCliente=` (Transacciones) se leen como `clienteId`.
- Los resúmenes (tarjetas, pestañas, contadores) usan el MISMO filtro que la tabla.
- Las exportaciones de Transacciones (PDF/Excel) usan los mismos filtros que la pantalla.
- Acciones de fila y estilos existentes no cambian. Sin cambios de base de datos.
- **No levantar la app ni correr las pruebas con el `.env` real: apunta a producción.** Todo se corre con el arnés PGlite (ver "Cómo correr pruebas"). No tocar `src/config/db.js`.

## Cómo correr pruebas

```bash
PGL="C:/Users/valen/AppData/Local/Temp/claude/048008ffb8ab7c6e/a0ee298e-d501-49bf-ad96-adfbbb4541fe/scratchpad/pglite"
bash "$PGL/correr.sh" tests/<archivo>.test.js     # un archivo; busca "# pass" y "# fail 0"
```
Si esa carpeta ya no existe, rearmarla según la memoria `pruebas-con-pglite` (`npm install @electric-sql/pglite@0.2.17` + `preload.mjs`). Línea de base conocida en `main`: fallan solo `compras-editar` y `estaciones`.

## Review Focus

1. `?clienteId=999999999` (no existe) o `?clienteId=1;DROP` → la pantalla carga sin filtro de cliente ni error (Ventas y Transacciones).
2. `?obra=x` sin cliente → se ignora; con cliente y una obra que ya no existe → lista vacía, **no** "todas las obras".
3. Varias obras con espacios, acentos o comas en el nombre → ordenar, paginar, cambiar de pestaña y exportar las conservan todas.
4. Transacciones con cliente + obra: no aparecen pagos de cliente; con solo el cliente sí aparecen (mismo conteo que antes).
5. Un enlace viejo `?id_cliente=<id>` (Ventas) / `?idCliente=<id>` (Transacciones) sigue filtrando.

(Dónde se prueba cada línea: 1 y 2 → Tasks 1, 4 y 5; 3 → Tasks 3 y 5; 4 → Task 5; 5 → Tasks 4 y 5.)

---

### Task 1: Helpers compartidos (`consulta` y `seleccionFiltro`)

**Files:**
- Create: `src/utils/consulta.js`
- Modify: `src/models/clientes.model.js` (junto a `obrasElegidas`, ~línea 486), `src/app.js:46-56` (`res.locals`), `tests/helpers/vistas.js`
- Test: `tests/filtro-cliente-obra-comun.test.js` (nuevo; las tareas 2 y 3 le suman casos)

**Interfaces:**
- Produces: `consulta(obj: object): string` (sin `?`): omite `''`, `null`, `undefined` y listas vacías; una lista repite el parámetro; conserva el orden de las claves; `0` se conserva. Disponible en vistas como `consulta`.
- Produces: `ClientesModel.seleccionFiltro(clienteId: string|number|undefined, claves: string|string[]|undefined): Promise<{ clienteSel: {id, numero, nombreCompleto}|null, obras: [{clave, nombre, opIds}], obra: object|null, opIds: string[]|null, claves: string[] }>`. Sin cliente válido (no `/^\d+$/` o inexistente): `{ clienteSel: null, obras: [], obra: null, opIds: null, claves: [] }`. Con cliente: `obras` = `this.obras(id, { incluirAnuladas: true })`, `obra` = `this.obrasElegidas(id, claves)`, `opIds` = `obra ? obra.opIds : null`, `claves` = `clavesObra(claves)`.

- [ ] **Step 1: Escribir las pruebas que fallan** en `tests/filtro-cliente-obra-comun.test.js` (mismo armado que `tests/filtro-varias-obras.test.js`: `prueba.abrir()` en `before`, `prueba.cerrar()` en `after`, cliente con tres ventas de obras "Barrio Norte L1", "Barrio Sur L2", "Centro L3" y otro cliente con una venta):
  - `consulta({ a: '1', b: '', c: null, d: undefined, obra: ['x y', 'z'], vacia: [] })` === `'a=1&obra=x+y&obra=z'`; `consulta({ n: 0, obra: ['', 'a', null] })` === `'n=0&obra=a'`.
  - `seleccionFiltro(cliente, [A, B])`: `clienteSel.id` (como texto) igual al cliente; `obras.length === 3`; `opIds` ordenados igual a `[opA, opB]`; `claves` deepEqual `[A, B]`.
  - `seleccionFiltro(cliente, undefined)`: `opIds === null`, `claves` deepEqual `[]`, `obra === null`, `obras.length === 3`.
  - Para `clienteId` en `['999999999', 'abc', '', undefined, '1; DROP TABLE x']`: deepEqual `{ clienteSel: null, obras: [], obra: null, opIds: null, claves: [] }`.
  - `seleccionFiltro(cliente, ['no existe'])`: `opIds` deepEqual `[]` (no `null`).
- [ ] **Step 2: Correr** `bash "$PGL/correr.sh" tests/filtro-cliente-obra-comun.test.js` → FALLA (`Cannot find module '../src/utils/consulta'`).
- [ ] **Step 3: Implementar** `consulta` en `src/utils/consulta.js` (`module.exports = { consulta }`, `URLSearchParams.append` por valor) y `seleccionFiltro` en `ClientesModel` (reusa `obtener`, `nombreCompleto`, `obras`, `obrasElegidas`, `clavesObra`; el `clienteSel` tiene la misma forma que hoy arma Facturación).
- [ ] **Step 4: Cablear `consulta` en las vistas**: `res.locals.consulta = require('./utils/consulta').consulta` en `src/app.js` y `consulta` en los locals de `renderVista` de `tests/helpers/vistas.js`.
- [ ] **Step 5: Correr** el mismo archivo → PASA (`# fail 0`).
- [ ] **Step 6: Commit** (`git add docs src tests`; mensaje `Filtro cliente/obra: helpers compartidos (consulta y seleccionFiltro)`; incluye el diseño y este plan, que están sin commitear).

---

### Task 2: Facturación usa el helper compartido

**Files:**
- Modify: `src/controllers/facturacion.controller.js:66-79` (`filtroCliente`)
- Test: `tests/filtro-cliente-obra-comun.test.js` (suma caso), existentes `tests/resumenes-segun-filtros.test.js`, `tests/filtro-varias-obras.test.js`

**Interfaces:**
- Consumes: `ClientesModel.seleccionFiltro` (Task 1).
- Produces: `filtroCliente(filtros)` mantiene su contrato: devuelve `{ clienteSel, obras, opIds, obra }` (más `claves`) y, si el cliente no existe, deja `filtros.clienteId = ''` y `filtros.obra = []`.

- [ ] **Step 1: Prueba de caracterización** (pasa antes y después): `llamar(Facturacion, 'index', { query: { clienteId: '999999999', obra: ['x'] } })` → `data.clienteSel === null`, `data.filtros.clienteId === ''`, `data.filtros.obra` deepEqual `[]`; y con el cliente real y `obra: [A, B]` → `String(data.clienteSel.id) === String(cliente)` y `data.obras.length === 3`.
- [ ] **Step 2: Correr** → PASA (es el comportamiento actual). Correr también `tests/resumenes-segun-filtros.test.js` y `tests/filtro-varias-obras.test.js` y anotar el resultado.
- [ ] **Step 3: Reemplazar el cuerpo de `filtroCliente`** para que delegue en `ClientesModel.seleccionFiltro(filtros.clienteId, filtros.obra)`, resetee `filtros.clienteId`/`filtros.obra` si `clienteSel` es null y devuelva el resultado.
- [ ] **Step 4: Correr** los tres archivos → mismos resultados que en el Step 2.
- [ ] **Step 5: Commit** (`Facturación: usa el helper compartido de cliente y obras`).

---

### Task 3: Enlaces de orden y paginación aceptan varias obras

**Files:**
- Modify: `views/partials/th_sort.ejs`, `views/partials/paginacion.ejs`
- Test: `tests/filtro-cliente-obra-comun.test.js` (suma caso)

**Interfaces:**
- Produces: ambos parciales, con `filtros` que traiga `obra: ['barrio norte l1', 'centro, l3']`, generan `obra=barrio+norte+l1&amp;obra=centro%2C+l3` (un parámetro por obra). Siguen omitiendo `''`, `null`, `page` (y `sort`/`dir` en `th_sort`). Los parciales NO dependen del local `consulta` (hay pruebas que los renderizan sin él): armar el `URLSearchParams` adentro.

- [ ] **Step 1: Prueba que falla**: `renderVista('partials/paginacion', { page: 1, totalPaginas: 3, total: 50, limit: 20, filtros: { clienteId: '5', obra: ['barrio norte l1', 'centro, l3'], q: '' } })` → el HTML contiene `href="?clienteId=5&amp;obra=barrio+norte+l1&amp;obra=centro%2C+l3&amp;page=2"` y no contiene `obra=barrio+norte+l1%2C`. Igual con `th_sort` (`sortKey: 'fecha'`, `sortLabel: 'Fecha'`, `currentSort: ''`, `currentDir: 'ASC'`): contiene `obra=barrio+norte+l1&amp;obra=centro%2C+l3&amp;sort=fecha&amp;dir=ASC`.
- [ ] **Step 2: Correr** → FALLA (hoy sale `obra=barrio+norte+l1%2Ccentro%2C+l3`).
- [ ] **Step 3: Implementar** en los dos parciales: por cada entrada de `filtros`, si el valor es lista se hace `append` por elemento no vacío; si no, `append` del valor.
- [ ] **Step 4: Correr** el archivo y `tests/consistencia-vistas.test.js` y `tests/filtro-cuentas.test.js` → PASAN.
- [ ] **Step 5: Commit** (`Orden y paginación: conservan varias obras`).

---

### Task 4: Ventas filtra por cliente y obras

**Files:**
- Modify: `src/models/ventas.model.js` (`_filtroVentas`, `contarPorEstado`, `listar`, `resumen`; quitar `listarClientes`), `src/controllers/ventas.controller.js:79-107` (`index`), `views/pages/ventas/index.ejs` (cabecera de helpers y formulario de filtros)
- Test: `tests/filtro-cliente-obra-ventas.test.js` (nuevo)

**Interfaces:**
- Consumes: `ClientesModel.seleccionFiltro`, `consulta` (Task 1); `paginacion` con listas (Task 3).
- Produces: `VentasModel._filtroVentas/listar/resumen/contarPorEstado({ ..., opIds })`: con `opIds` (lista de ids como texto) agrega `op.id = ANY(?::bigint[])`; `null`/ausente = sin filtro; `[]` = ningún resultado. `index` renderiza con `clienteSel`, `obras` (para el componente) y `filtros` que incluye `clienteId` (texto, `''` si no hay) y `obra` (lista de claves); `filtros` ya no trae `id_cliente`.

- [ ] **Step 1: Pruebas que fallan** en `tests/filtro-cliente-obra-ventas.test.js` (mismos datos que la Task 1: 3 ventas del cliente en obras A/B/C + 1 venta de otro cliente; `llamar` como en `tests/resumenes-segun-filtros.test.js`):
  - Modelo: `listar({ opIds: [opA, opB], limit: 50 })` devuelve exactamente esas dos ops; `opIds: []` → `total === 0`; `opIds: null` incluye también la del otro cliente; `contarPorEstado({ opIds: [opA] })` suma 1 y `resumen({ opIds: [opA, opB] }).count === 2`.
  - Controlador, con `query: { clienteId: String(cliente), obra: [A, B] }`: `data.ops` son las de A y B; `data.metricas.count === 2`; `data.clienteSel.id` es el cliente; `data.obras.length === 3`; `data.filtros.obra` deepEqual `[A, B]`; `data.filtros.id_cliente === undefined`.
  - Enlace viejo: `query: { id_cliente: String(cliente) }` → `data.filtros.clienteId === String(cliente)` y trae las 3 ops del cliente (no la del otro).
  - Cliente inexistente `clienteId: '999999999'` → `data.clienteSel === null`, `data.filtros.clienteId === ''`, `data.total` incluye ops de cualquier cliente. `obra: [A]` sin cliente → se ignora (`data.filtros.obra` deepEqual `[]`).
  - Obra vieja: `clienteId` + `obra: ['no existe']` → `data.total === 0`.
  - Vista (`renderVista('pages/ventas/index', { ...data, user })` con cliente + obras A y C): contiene `data-filtro-obras data-dinamico`; `<input type="hidden" name="clienteId" id="inputClienteId" value="<id>">`; exactamente dos `<input type="checkbox" name="obra" ... checked>` con los valores A y C; **no** contiene `name="id_cliente"` ni `data-buscable`; el href de la pestaña "Pendientes" contiene `clienteId=<id>&amp;obra=<A>&amp;obra=<C>` (con A y C ya codificadas como las deja `consulta`); los links de orden de columna también.
- [ ] **Step 2: Correr** → FALLA.
- [ ] **Step 3: Modelo**: `_filtroVentas` recibe `opIds` y agrega la condición; `listar`, `resumen` y `contarPorEstado` lo reciben y lo pasan. Borrar `listarClientes` (solo lo usaba el select).
- [ ] **Step 4: Controlador `index`**: `const sel = await ClientesModel.seleccionFiltro(req.query.clienteId || req.query.id_cliente, req.query.obra)`; los cuatro llamados al modelo usan `id_cliente: sel.clienteSel ? sel.clienteSel.id : null` y `opIds: sel.opIds`; se deja de pedir `clientes`; `scripts: ['/js/buscarCliente.js', '/js/filtroObra.js', '/js/estadoPago.js', '/js/nroFactura.js']`; `filtros: { ...resto de req.query sin id_cliente, clienteId: sel.clienteSel ? String(sel.clienteSel.id) : '', obra: sel.claves, fechaDesde, fechaHasta, preset }`; render con `clienteSel` y `obras: sel.obras`.
- [ ] **Step 5: Vista**: en el bloque `<% %>` de arriba, `baseFiltros`/`tabHref`/`presetHref`/`thSort` pasan a armarse con `consulta({...})` con las claves `estado, clienteId, obra, q, sort, dir, preset, fechaDesde, fechaHasta, mes` (los que correspondan a cada helper, igual que hoy pero con `clienteId` y `obra` en lugar de `id_cliente`). El formulario queda en dos filas Bootstrap: fila 1 = Buscar (`col-md-4`), `include('../../partials/filtro_cliente_obra', { clienteSel, obras, obraSel: filtros.obra, claseCliente: 'col-12 col-md-4', claseObra: 'col-12 col-md-4', claseInput: 'form-control form-control-sm' })`; fila 2 = Desde, Hasta (`col-md-2` cada una) y los botones Filtrar / Limpiar (igual que hoy). Se saca el `<select name="id_cliente" data-buscable>`.
- [ ] **Step 6: Correr** el archivo nuevo, `tests/resumenes-segun-filtros.test.js`, `tests/estado-pago-operacion.test.js` y `tests/nro-factura-operaciones.test.js` → PASAN (los dos últimos renderizan esta vista).
- [ ] **Step 7: Commit** (`Ventas: filtro por cliente y obras (mismo componente que Liquidaciones)`).

---

### Task 5: Transacciones filtra por cliente y obras (tabla, tarjetas, reporte)

**Files:**
- Modify: `src/models/movimientosDinero.model.js:107-128` (`filtro`), `src/controllers/transacciones.controller.js` (`leerFiltros`, `index`, `exportar`), `views/pages/transacciones/index.ejs` (helpers de enlaces y barra de filtros), el SCSS donde se define `.mov-chips` (buscar con `grep -rn "mov-chip" src/scss`)
- Test: `tests/filtro-cliente-obra-transacciones.test.js` (nuevo); actualizar los locals de `tests/consistencia-vistas.test.js` (agregar `clienteSel: null, obras: []`; en `filtros` cambiar `idCliente: ''` por `clienteId: '', obra: []`; quitar `clientesLista`)

**Interfaces:**
- Consumes: `ClientesModel.seleccionFiltro`, `consulta`.
- Produces: `MovimientosDineroModel._filtro/listar/todos/resumen({ ..., opIds })`: con `opIds` agrega `u.id_op_encabezado = ANY(?::bigint[])` (los pagos de cliente tienen `id_op_encabezado` nulo, así que quedan afuera). `leerFiltros(q)` pasa a ser `async` y devuelve `{ periodo, filtros, sel }` donde `filtros` trae `clienteId` (id numérico o `undefined`) y `opIds`; lee `q.clienteId || q.idCliente` y `q.obra`. El texto libre sigue siendo el parámetro `cliente` (filtra `u.persona`).

- [ ] **Step 1: Pruebas que fallan** en `tests/filtro-cliente-obra-transacciones.test.js` (datos de la Task 1 + por cada venta una `TransaccionesModel.crear({ tipo: 'Venta Viaje', id_op_encabezado, cliente_id, cliente, monto, metodo_pago: 'efectivo', fecha: '2026-11-05' })` + un pago `ClientesModel.agregarMovimiento(cliente, { tipo: 'pago', descripcion: 'Pago', monto: 500, metodo_pago: 'transferencia', fecha: '2026-11-06 10:00:00' })`):
  - Modelo: `listar({ clienteId: cliente, opIds: [opA, opB], limit: 50 })` → solo los 2 cobros de A y B (`origen === 'transaccion'`), ningún `pago_cliente`; sin `opIds` (solo `clienteId`) → los 3 cobros + el pago; `opIds: []` → 0; `resumen({ clienteId: cliente, opIds: [opA] }).conteo.ventas === 1`.
  - Controlador `index` con `query: { clienteId: String(cliente), obra: [A, B], preset: 'rango', fechaDesde: '2026-11-01', fechaHasta: '2026-11-30' }`: `data.movimientos` son los cobros de A y B; `data.metricas.entradas` es la suma de esos dos; `data.clienteSel.id` es el cliente; `data.obras.length === 3`; `data.filtros.obra` deepEqual `[A, B]` y `data.filtros.clienteId` es el id; `data.clientesLista === undefined`.
  - Solo cliente → incluye el pago de cliente. Enlace viejo `query: { idCliente: String(cliente) }` → igual que el anterior. Cliente inexistente → `data.clienteSel === null`, `data.filtros.clienteId === ''`. `obra` sin cliente → ignorada. `obra: ['no existe']` con cliente → `data.movimientos.length === 0`.
  - Texto libre intacto: `query: { cliente: 'PRUEBA' }` sigue filtrando por nombre (no depende de `clienteId`).
  - Reporte: `exportar` con `params: { formato: 'excel' }` y `query` como arriba, con un `res` que junta los bytes (como `resFalso` de `tests/filtro-varias-obras.test.js`; leer el libro con `new ExcelJS.Workbook().xlsx.load(buffer)`): la celda A1 contiene `Cliente: ` + el nombre del cliente y `Obras: Barrio Norte L1, Barrio Sur L2`; las filas de datos son solo las de A y B (por código `CAN-`/`VIA-`…); y A1 no contiene `Cliente / persona:`.
  - Vista (`renderVista('pages/transacciones/index', { ...data, user })`): contiene `data-filtro-obras data-dinamico`, `name="clienteId"`, dos casillas `obra` marcadas, la etiqueta `Empleado / proveedor`, y **no** contiene `listaClientesTx`; el href de un chip de categoría y los de `qsReporte` (Excel/PDF) contienen `obra=<A>&amp;obra=<B>`.
- [ ] **Step 2: Correr** → FALLA.
- [ ] **Step 3: Modelo**: `filtro({ ..., opIds })` agrega la condición.
- [ ] **Step 4: Controlador**: `leerFiltros` async con `seleccionFiltro` (el cliente queda en `filtros.clienteId` solo si existe); `index` y `exportar` hacen `await leerFiltros(req.query)`; `index` arma `filtros` para la vista con `clienteId` (`''` si no hay) y `obra: sel.claves` (sin `idCliente`), renderiza `clienteSel` y `obras: sel.obras`, deja de pedir `clientesLista` y suma `'/js/buscarCliente.js', '/js/filtroObra.js'` a `scripts`; `exportar` cambia la línea `Cliente / persona: …` por `Persona: …` y agrega `Cliente: <nombre>` y `<obra.etiqueta>: <obra.nombre>` cuando corresponda.
- [ ] **Step 5: Vista**: `conFiltros` y `qsReporte` se arman con `consulta(...)` (mismos filtros que hoy excluidos: `sortBy`, `sortDir`, `categoria === 'todas'`); en la barra de filtros el grupo "Cliente / persona" se reemplaza por `include('../../partials/filtro_cliente_obra', { clienteSel, obras, obraSel: filtros.obra, claseCliente: 'filtro-group tx-filtro-cliente', claseObra: 'filtro-group tx-filtro-obra', claseInput: '', claseLabel: '' })` y a continuación el grupo de texto (`name="cliente"`) con la etiqueta "Empleado / proveedor", placeholder "Nombre del empleado o proveedor..." y sin `list`/`<datalist>`. SCSS: `.tx-filtro-cliente { flex: 1 1 240px }` y `.tx-filtro-obra { flex: 1 1 200px }`, junto a los estilos de `.mov-chips`; correr `npm run build` para regenerar el CSS (no se commitea: está ignorado).
- [ ] **Step 6: Correr** el archivo nuevo, `tests/consistencia-vistas.test.js`, `tests/transacciones-codigo.test.js`, `tests/transacciones-filtro.test.js`, `tests/resumenes-segun-filtros.test.js` y `tests/estado-pago-operacion.test.js` → PASAN.
- [ ] **Step 7: Commit** (`Transacciones: filtro por cliente y obras (tabla, tarjetas y reporte)`).

---

### Task 6: Libro de ventas usa el componente compartido

**Files:**
- Modify: `views/pages/ventas/libro.ejs:10-24`
- Test: `tests/filtro-obras-vistas.test.js` (el caso "Libro de ventas" ya existente + un caso)

**Interfaces:**
- Consumes: `partials/filtro_cliente_obra`.

- [ ] **Step 1: Prueba que falla** (en `describe('formularios con el filtro de obras')`): `renderVista('pages/ventas/libro', { filtros: {} })` contiene `class="col-12 col-md-6 filtro-cliente position-relative"` (clases que da el componente), `<input type="hidden" name="clienteId" id="inputClienteId" value="">` y `data-filtro-obras data-dinamico`, y ya no contiene `Cliente (opcional)`.
- [ ] **Step 2: Correr** `tests/filtro-obras-vistas.test.js` → FALLA en el caso nuevo.
- [ ] **Step 3: Reemplazar** el bloque cliente + obras de `libro.ejs` por un único `include('../../partials/filtro_cliente_obra', { clienteSel: null, obras: [], obraSel: [], claseCliente: 'col-12 col-md-6', claseObra: 'col-12 col-md-6' })` dentro del mismo `row`; el comentario HTML se actualiza.
- [ ] **Step 4: Correr** `tests/filtro-obras-vistas.test.js` → PASA.
- [ ] **Step 5: Commit** (`Libro de ventas: usa el componente compartido de cliente y obras`).

---

### Task 7: Verificación completa en navegador y cierre

**Files:** ninguno (verificación). Memoria: `memory/filtro-cliente-obra-unificado.md` + línea en `MEMORY.md`.

- [ ] **Step 1: Suite completa**: correr cada `tests/*.test.js` con el arnés PGlite (un `for` sobre los archivos con `correr.sh`, ~15 min, en segundo plano). Esperado: solo fallan `compras-editar` y `estaciones` (línea de base); cualquier otra falla se arregla antes de seguir.
- [ ] **Step 2: Prueba en Chrome headless** (receta de la memoria `probar-ui-chrome-headless`, con `servidor.js` del arnés PGlite, nunca contra producción): en `/ventas` y en `/transacciones`, sin recargar: escribir 2 letras del cliente → aparece la lista; elegir → se ve el nombre con "Cambiar" y el botón de obras se habilita; marcar dos obras → el botón dice "2 obras: …"; "Filtrar" → la URL trae `clienteId=…&obra=…&obra=…`, la tabla y las tarjetas se recalculan; ordenar una columna y pasar de página (Ventas) conservan las dos obras; en Transacciones el botón "Excel" descarga solo lo filtrado. Mirar la consola (sin `Uncaught`) y sacar una captura de cada pantalla con el filtro desplegado; revisar el ancho de la barra de filtros de Transacciones.
- [ ] **Step 3: Revisión de la rama** con `/code-review` sobre el diff completo contra `main`; arreglar lo que sea real.
- [ ] **Step 4: Memoria**: guardar `filtro-cliente-obra-unificado.md` (tipo project: dónde está el componente, que Ventas y Transacciones lo usan, que Transacciones con obra no muestra pagos de cliente, y que "Empleado / proveedor" es el texto libre) y agregar su línea a `MEMORY.md`.
- [ ] **Step 5: Informar al usuario** el resultado (pruebas, capturas, qué decidí) y esperar su OK para mergear a `main` (`--no-ff`) y pushear, recordando que después hay que correr `deploy.sh` en el VPS.
