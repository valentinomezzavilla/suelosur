# Editar ventas ya entregadas — diseño corto

Fecha: 2026-11-25 · Tamaño: cambio mediano (modelo, controlador y vista de Ventas; sin cambios de base de datos).

## Intención
Poder corregir una venta (**viaje o cantera**) después de entregada. Si cambia el monto, la cantidad o el método de pago, todo lo que se generó al entregar acompaña: stock, cobro (transacción), cuenta corriente y egreso a tercero. Es lo que hoy ya pasa al editar un alquiler cobrado (`corregirCobro`).

## Cómo está hoy
- Una venta `entregada` no se edita: lo impiden el botón (`ventas/detalle.ejs`), el controlador (`editarViaje`) y el modelo (`actualizarViaje`).
- Al entregar se genera: stock real descontado (`cantidad_actual`, y baja el pendiente), una transacción por el total con IVA, el cargo en cuenta corriente (si corresponde) y, si fue transferencia a tercero, su egreso.
- Cantera no tiene edición en ningún estado, puede tener **varios productos**, y el formulario de edición (`editar_viaje.ejs`) es de un solo producto con campos de envío (fecha, hora, dirección, zona).

## Approaches (elegido: A)
- **A. Corregir en el lugar** *(elegido)*: la transacción existente pasa al nuevo total/método/descripción, el stock se corrige por la diferencia, el cargo de cuenta corriente y el egreso a tercero se rehacen. Un solo cobro, el correcto, en Transacciones y resúmenes; igual que los alquileres. Contra: el monto anterior no queda a la vista (se mitiga con auditoría, ver abajo).
- **B. Transacción de "Ajuste" por la diferencia**: deja historial pero la venta tiene dos filas, complica método de pago y tercero, y no se parece a los alquileres.
- **C. Deshacer la entrega y rehacerla**: descartada; se pierde la fecha de cobro y el id de la transacción.

## Qué se hace
1. **Se levanta el bloqueo** para ventas entregadas (viaje y cantera). Anuladas siguen bloqueadas. Pendientes y despachadas: igual que hoy.
2. **Un solo camino de guardado para viaje y cantera** (`actualizarVenta`, N líneas; `actualizarViaje` queda como su caso de una línea para no romper nada). Dentro de **una transacción de base de datos**, después de guardar la venta, si estaba entregada se reconcilia:
   - **Stock**: por cada línea que mueve stock, `cantidad_actual −= (nueva − vieja)`, con piso en 0 (como `entregar`); el pendiente no se toca. Contenedores y productos sin control de stock no mueven.
   - **Transacción** de la venta (tipo ≠ Ajuste): `monto` = nuevo total **con IVA**, `metodo_pago` nuevo, descripción rehecha con el mismo texto que arma la entrega. **La fecha de cobro no se toca** (se cambia con el cambio de fecha de pago que ya existe).
   - **Egreso a tercero**: se borra el de la transacción y, si el método es transferencia con tercero, se rehace con el monto nuevo.
   - **Cuenta corriente / saldo a favor**: `sincronizarCargoCC` (ya existe) deja el cargo por el total nuevo; los descuentos siguen al cargo como hoy.
   - Si la venta se dejó **pendiente de cobro** (sin transacción), solo cambia el total; el saldo se recalcula solo.
3. **Facturadas** (`facturado = 1`): se bloquean los cambios que alteran el total — cantidad, precio, flete y total manual (el servidor lo rechaza y el formulario muestra esos campos deshabilitados con un aviso). El resto (dirección, fechas, observaciones, método de pago) sigue editable. El N° de factura ya se comporta así.
4. **Formulario**: se reusa `editar_viaje.ejs`. En cantera se ocultan fecha de envío, hora, dirección y zona (no existen en cantera) y se muestra **una fila por producto** con cantidad y precio editables; el producto no se cambia ni se agregan o quitan. Cantidad de contenedores sigue siendo entera.
5. **Botón Editar** en el detalle de Ventas para viaje y cantera, entregada o no (salvo anulada).
6. **Auditoría** *(mi agregado)*: si una venta entregada cambia de monto, cantidad o método, se registra con `registrarAuditoria` (`entidad_tipo: 'operacion'`, antes y después), como ya hace Estado de pago. Así el monto anterior no se pierde.

## Decisiones mías para revisar
1. **Stock insuficiente**: si la cantidad sube más que el stock actual, queda en 0 sin bloquear (igual que entregar).
2. **Descripción de cantera**: la entrega arma `Producto xN, … — nota`. Al editar, la parte de productos se reescribe con las cantidades nuevas **solo si el texto todavía empieza con el armado automático viejo**; si alguien lo escribió a mano, no se toca.
3. **Cliente, producto y remito** no se editan (como en viajes hoy).
4. **Pagos ya aplicados a la cuenta corriente** de una venta a cuenta corriente: el cargo cambia de monto y el saldo se recalcula por la regla de siempre; no se reasignan pagos a mano.

## A verificar al implementar
- Cómo calcula Facturación el monto de una venta "para facturar" no facturada (`monto_facturar` / transacción): que quede coherente tras el cambio.
- Que `Tercero.egresoDeCobro` y `borrarDeTransaccion` rehagan bien el egreso dentro de la transacción de base de datos (`q`).

## Fuera de alcance
- Cambiar cliente, producto, remito o agregar/quitar productos.
- Ventas anuladas.
- Cambios de esquema de la base de datos.
- Tocar alquileres (ya se editan cobrados).

## Qué no debe pasar
- Que el stock, la transacción y la cuenta corriente queden con totales distintos entre sí tras editar.
- Un egreso a tercero duplicado o con el monto viejo.
- Editar el total de una venta facturada.
- Que un error a mitad de la edición deje la venta cambiada pero el cobro sin corregir (todo va en una transacción de base de datos).
- Que editar una venta pendiente o despachada cambie su comportamiento actual.

## Cómo se verifica
- Pruebas con PGlite (como las demás), venta entregada de viaje y de cantera:
  - cantidad sube/baja → `cantidad_actual` y pendiente correctos; piso en 0;
  - monto cambia en efectivo → transacción con el total con IVA, fecha intacta;
  - método efectivo ↔ cuenta corriente ↔ transferencia con tercero → cargo y egreso correctos;
  - venta pendiente de cobro (sin transacción) → solo cambia el total;
  - facturada → rechaza cambios de total y deja el resto;
  - anulada → sigue rechazando;
  - una falla en el medio revierte todo.
- Chrome headless contra la app local: abrir una venta entregada de cada tipo, editar cantidad y monto, guardar, y ver detalle, Transacciones y cuenta corriente.
