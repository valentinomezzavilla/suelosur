# Descuentos a clientes — diseño

Fecha: 2026-11-19 · Rama: `feat/descuentos`

## Para qué

Poder hacerle un descuento a un cliente desde **Liquidaciones** y desde **Cuenta corriente**, y
que ese descuento **baje de verdad lo que el cliente debe**: su saldo, el estado de pago de las
operaciones, la liquidación y el PDF tienen que decir lo mismo. También tiene que poder verse qué
descuentos tiene aplicados el cliente y **revertir** cualquiera de ellos.

## Objetivos

- Botón **"Agregar descuento"** arriba de las operaciones, en Liquidaciones (con un cliente
  elegido) y en el detalle de la Cuenta corriente (`/clientes/cuentas/:id`).
- Descuento por **porcentaje** (cualquier valor > 0 y ≤ 100) o por **monto fijo** (cualquier
  importe > 0).
- Alcance: **todas las operaciones**, **una operación**, **un N° de remito**, **un N° de factura**
  o **sobre el saldo total** del cliente (sin atarlo a una operación).
- Con remito o factura que abarcan varias operaciones, el descuento se reparte entre todas.
- Botón **"Ver descuentos aplicados"** al lado, solo si el cliente tiene alguno vigente: el
  detalle de cada uno y la opción de **revertirlo**.
- Las operaciones con **factura emitida** se pueden descontar, pero con un cartel que avisa que
  hace falta una nota de crédito por fuera del sistema (decidido: opción B).

## No objetivos

- Generar la nota de crédito (ni en AFIP ni en PDF).
- Cambiar los precios de las operaciones, el remito o la factura.
- Descuentos en otros módulos (Ventas, Alquileres, Facturación); se ven ahí solo porque el estado
  de pago usa el mismo cálculo.
- Revertir un descuento a medias (solo en algunas operaciones): se revierte entero.
- Editar un descuento: se revierte y se carga otro.

## Anti-objetivos (sería un fracaso aunque funcione)

- Que la Cuenta corriente, la Liquidación y el PDF muestren saldos distintos después de un
  descuento.
- Que un descuento deje al cliente con saldo a favor que no pagó (se le descuenta más de lo que
  debe).
- Que revertir deje restos (ajustes sueltos, renglones colgados) o toque otras operaciones.

## Enfoques considerados

1. **Registro propio de descuentos + ajuste en la cuenta corriente (elegido).** Tablas nuevas
   con cada descuento y cuánto le tocó a cada operación. En las operaciones a cuenta corriente se
   carga además un ajuste a favor atado a la operación (el mismo mecanismo que "quitar el IVA",
   paso 1 de `utils/imputacion.js`). En las de contado el descuento baja el total en el cálculo de
   la liquidación. Revertir = anular los ajustes y marcar el descuento revertido.
2. **Solo ajustes en la cuenta corriente.** No sirve para operaciones de contado (no pasan por la
   cuenta) y para ver / revertir habría que reconstruir qué ajustes van juntos por la
   descripción. Descartado.
3. **Cambiar los precios de las operaciones.** Se pierde el precio original, la operación deja de
   coincidir con su remito y su factura, y revertir es frágil. Descartado.

## Reglas

### Sobre qué se calcula

- El descuento se calcula sobre **lo que falta pagar** (`resta`) de cada operación, no sobre su
  total original. Un 10% de "todas" no toca las que ya están pagadas.
- **Porcentaje:** a cada operación le toca `resta × %`, redondeado al centavo.
- **Monto fijo:** no puede superar la suma de lo que falta pagar de las operaciones alcanzadas. Se
  reparte **proporcional a la `resta`** de cada una; la diferencia de redondeo va a la última.
- **Sobre el saldo total:** porcentaje o monto sobre lo que el cliente debe en total
  (`saldoDelCliente(...).total`); el monto no puede superarlo.
- La `resta` ya incluye el IVA cuando la operación es para facturar: el descuento es sobre lo que
  el cliente paga.

### Qué operaciones se pueden descontar

Las del cliente que **ya son deuda** y deben algo:

- no anuladas, no "a convenir", con `resta` > 0,01;
- en cuenta corriente (`enCuenta`) o de contado ya entregadas y sin cobrar del todo;
- **no** se incluyen: alquileres en curso (`estimado` / `enCurso`, el importe todavía no es
  final), operaciones sin entregar (`estadoOp` pendiente / despachado) y alquileres agrupados con
  cobro "todo junto" (`grupoTodoJunto`, el cargo está anclado a otra OP). El modal dice por qué no
  aparecen y que se puede usar "sobre el saldo total".

### Alcance

| Alcance | Operaciones |
|---|---|
| Todas las operaciones | Las descontables **que se ven en pantalla** (mismos filtros de período, obra y tipo) |
| Una operación | Se elige de un listado de las descontables en pantalla |
| N° de remito | **Todas** las descontables del cliente con ese remito, sin importar el período (igual que "marcar pendiente por remito") |
| N° de factura | **Todas** las descontables del cliente con ese `nro_factura`, sin importar el período |
| Sobre el saldo total | Ninguna: un crédito general del cliente |

Remito y factura se eligen de una lista con los números que tienen operaciones descontables.

### Cómo impacta

- **Operación a cuenta corriente** (`enCuenta`): `movimientos_cuenta` tipo `ajuste`, monto
  positivo, `id_op_encabezado` = la operación, descripción `Descuento 10% — OP-0123` (o
  `Descuento $ 50.000 — …`). La imputación ya lo trata como rebaja de esa operación
  (`creditoPropio`) y el saldo del cliente baja solo. Como el descuento es ≤ `resta`, lo ya pagado
  sigue entrando en lo que queda.
- **Operación de contado:** no hay movimiento. El descuento baja el total de la operación al
  armarla.
- **En las dos**, `armar()` (`liquidaciones.model.js`) agrega un renglón negativo por cada
  descuento vigente de la operación: `Descuento 10% (19/11/2026)`. Así el total armado coincide con
  lo que figura en la cuenta (sin renglón "Diferencia con lo cargado…") y en la de contado la
  `resta` baja. "Marcar como pagada" cobra la `resta`, o sea el importe con descuento.
- **Sobre el saldo total:** `movimientos_cuenta` tipo `ajuste`, monto positivo, **sin**
  operación: funciona como un crédito que se aplica a lo más viejo (o queda a favor y se usa con
  "saldo a favor" en las de contado). Vale también para clientes sin cuenta corriente habilitada:
  el saldo del cliente existe igual.

### Facturas emitidas

Una operación tiene factura emitida si `facturado = 1` o tiene `nro_factura`. Se puede descontar,
y cada vez que entra en un descuento:

- en la vista previa del modal, al lado de la operación:
  **"Tiene factura emitida (N° X): el descuento requiere una nota de crédito por fuera del
  sistema."**;
- el mismo aviso en "Ver descuentos aplicados", en los descuentos que tocaron operaciones
  facturadas.

### Revertir

- Se revierte el descuento **entero**, con motivo obligatorio (como "Anular pago").
- Anula sus movimientos de cuenta (`anulado = 1`, `anulado_en`, `anulado_por`,
  `anulado_motivo`; el saldo lo recalcula la base) y marca el descuento revertido. Los renglones
  dejan de aparecer.
- Si la operación ya se cobró con el importe con descuento, al revertir vuelve a deber la
  diferencia (queda parcial). La confirmación lo avisa: "Las operaciones vuelven a deber lo
  descontado".
- Se registra en auditoría (`registrarAuditoria`), igual que crear.

## Pantallas

### Botones

Arriba de las tarjetas de operaciones (Liquidaciones con cliente y Cuenta corriente):

```
[ Agregar descuento ]  [ Ver descuentos aplicados (2) ]
```

El segundo aparece solo con descuentos vigentes. Roles: `dueno` y `admin_contable`.

### Modal "Agregar descuento"

```
Tipo:      (•) Porcentaje   ( ) Monto fijo
Valor:     [ 10 ] %
Se aplica: (•) Todas las operaciones en pantalla
           ( ) Una operación      [ OP-0123 · Remito 456 · debe $ 120.000 ▾ ]
           ( ) N° de remito       [ 456 ▾ ]
           ( ) N° de factura      [ A-0001-00001234 ▾ ]
           ( ) Sobre el saldo total (debe $ 850.000)
Motivo:    [ opcional ]

Vista previa
 Operación          Debe          Descuento     Queda
 OP-0123 Rem. 456   $ 120.000     − $ 12.000    $ 108.000
 OP-0124 Rem. 456   $  80.000     − $  8.000    $  72.000
   ⚠ Tiene factura emitida (N° A-0001-00001234): el descuento requiere una nota de crédito…
 Total                            − $ 20.000

                                      [ Cancelar ] [ Aplicar descuento ]
```

La vista previa la calcula el servidor con la misma lógica que se usa al guardar (endpoint de
vista previa), así lo que se ve es exactamente lo que se aplica.

### Modal "Ver descuentos aplicados"

Uno por renglón, del más nuevo al más viejo:

```
19/11/2026 · 10% · Remito 456 · − $ 20.000 · cargado por Ana · Motivo: cliente fiel
   OP-0123 − $ 12.000 · OP-0124 − $ 8.000   ⚠ factura emitida
                                                       [ Revertir ]
```

Los revertidos se pueden mostrar con "Ver revertidos" (atenuados, con quién y por qué), sin
botón.

### PDF de la liquidación

- El renglón `Descuento …` aparece en el detalle de cada operación afectada.
- Los descuentos "sobre el saldo total" vigentes se listan en el resumen del saldo como
  `Descuento sobre el saldo (19/11/2026) − $ 50.000`.

## Datos

Las tablas se crean en `initDB` (`src/config/db.js`) con `CREATE TABLE IF NOT EXISTS`. **Ojo:**
el entorno local corre `initDB` contra la base de producción en cada guardado: frenar nodemon
antes de tocar `db.js` y probar con PGlite.

```
descuentos
  id BIGINT identity PK
  cliente_id BIGINT NOT NULL → clientes
  tipo TEXT CHECK (tipo IN ('porcentaje','monto'))
  valor DOUBLE PRECISION NOT NULL           -- 10 (= 10%) o 50000
  alcance TEXT CHECK (alcance IN ('todas','operacion','remito','factura','saldo'))
  referencia TEXT                           -- N° de remito / de factura / id de OP, según el alcance
  total DOUBLE PRECISION NOT NULL           -- lo descontado en total
  motivo TEXT
  id_usuario BIGINT, created_at TEXT DEFAULT ahora_local()
  revertido INT DEFAULT 0, revertido_en TEXT, revertido_por BIGINT, revertido_motivo TEXT

descuento_operaciones
  id BIGINT identity PK
  id_descuento BIGINT NOT NULL → descuentos ON DELETE CASCADE
  id_op_encabezado BIGINT → op_encabezado   -- NULL en "sobre el saldo total"
  monto DOUBLE PRECISION NOT NULL CHECK (monto > 0)
  id_movimiento BIGINT → movimientos_cuenta -- el ajuste, si la OP está en la cuenta o es "saldo"
  factura_emitida INT DEFAULT 0             -- foto al momento de aplicar (para el aviso)
```

Crear y revertir corren en **una transacción** (`transaction` de `config/db`): se vuelve a
calcular la vista previa adentro y, si cambió (alguien cobró en el medio), se rechaza con "Los
importes cambiaron, revisá la vista previa".

## Componentes

| Archivo | Qué hace |
|---|---|
| `src/utils/descuentos.js` | Lógica pura: validar tipo / valor, qué operaciones son descontables, repartir (porcentaje y monto proporcional, redondeo), textos |
| `src/models/descuentos.model.js` | Vista previa, aplicar, revertir, listar por cliente, descuentos vigentes por operación (para `armar`) |
| `src/models/liquidaciones.model.js` | `armar()` / `calcularOperaciones` suman los renglones de descuento; el saldo lista los "sobre el saldo" |
| `src/controllers/descuentos.controller.js` + `src/routes/descuentos.routes.js` | `GET /descuentos/vista-previa`, `POST /descuentos`, `GET /descuentos/cliente/:id`, `POST /descuentos/:id/revertir`; `auth` + `roles('admin_contable','dueno')`, `envioUnico` en los POST |
| `views/partials/descuentos_botones.ejs`, `views/partials/modal_descuento.ejs`, `views/partials/modal_descuentos_aplicados.ejs` | Botones y modales, incluidos en `liquidaciones/index.ejs` y `clientes/cuenta_detalle.ejs` |
| `public/js/descuentos.js` | Modal: cambia campos según tipo / alcance, pide la vista previa, envía, revierte |
| `src/utils/pdfLiquidacion.js` | Descuentos sobre el saldo en el resumen |

## A revisar al construir

- Que las rutinas que re-sincronizan cargos de la cuenta (`sincronizarCargoCC` en ventas,
  `alquileres.model.js` ~línea 1490, el IVA de `facturacion.model.js`) **no borren ni pisen** los
  ajustes de descuento. Hoy saltean el tipo `ajuste`; verificarlo con una prueba.
- `estadoPago.model.js` (marcar pendiente) ya excluye los ajustes atados a una operación de lo que
  "es plata": un descuento no se revierte al marcar pendiente.
- Si una operación se marca para facturar **después** de un descuento, el IVA se calcula sobre el
  precio sin descuento (el descuento es sobre el total). Aceptado; queda anotado.

## Pruebas

- **Unitarias** (`tests/descuentos.test.js`): porcentaje y monto, reparto proporcional y
  redondeo, tope al total que debe, operaciones excluidas, alcance remito / factura.
- **Modelo con PGlite** (`tests/descuentos-modelo.test.js`): cliente con una OP a cuenta corriente
  con pago parcial, una de contado entregada sin cobrar y una facturada → aplicar por remito,
  por factura y sobre el saldo; el saldo del cliente, la liquidación y la cuenta corriente
  coinciden; marcar pagada cobra el importe con descuento; revertir deja todo como antes.
- **UI** en Chrome headless contra la app local (PGlite): abrir el modal, vista previa, aplicar,
  ver aplicados, revertir.

## Decisiones mías (revisar)

- "Todas las operaciones" = las de la pantalla (respeta los filtros); remito y factura = todas las
  del cliente, sin importar el período.
- Quedan afuera los alquileres en curso, las operaciones sin entregar y los grupos "todo junto".
- Los informes de ventas (Libro de ventas, dashboard) siguen mostrando el precio original: el
  descuento cambia lo que se cobra, no lo que se vendió. Lo cobrado en Transacciones ya sale con
  descuento.
- Motivo opcional al aplicar y obligatorio al revertir.
