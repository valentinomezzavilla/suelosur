# Filtro de cliente y obra unificado — diseño corto

Fecha: 2026-11-24 · Tamaño: cambio mediano (reusa un componente que ya existe; lo nuevo es el filtrado en el servidor de dos listados).

## Intención
Que todos los filtros por cliente funcionen **exactamente igual que en Liquidaciones**: se escribe y la lista de clientes se arma mientras se tipea; al elegir uno aparecen sus obras (se pueden marcar varias). Hoy cada pantalla lo resuelve distinto, y en dos de ellas ni siquiera se puede filtrar por obra.

## Cómo está hoy
| Pantalla | Cliente | Obra |
|---|---|---|
| Liquidaciones | componente `filtro_cliente_obra` (referencia) | sí |
| Facturación | el mismo componente | sí |
| Libro de ventas | copia a mano del mismo marcado | sí |
| **Ventas** | `<select data-buscable>` | **no** |
| **Transacciones** | texto libre con sugerencias del navegador (`cliente`) | **no** |
| Cuenta corriente del cliente / Reporte | cliente fijo | sí (`filtro_obras`) |
| Alquileres, Cheques, Clientes, Cuentas | solo un buscador de texto general | — |

## Qué se hace (todo igual)
1. **Ventas** (`/ventas`): se reemplaza el select por `partials/filtro_cliente_obra`. Cliente + obras filtran el listado, las pestañas por estado y las tarjetas con el mismo criterio (regla: los resúmenes siguen los filtros).
2. **Transacciones** (`/transacciones`): el componente reemplaza el filtro de cliente. Filtra la tabla, las tarjetas, los botones de categoría y el reporte PDF/Excel con lo mismo.
3. **Libro de ventas**: se cambia la copia a mano por el componente compartido (se ve y anda igual).
4. Se arregla la construcción de enlaces (orden, paginación, pestañas, período, reporte) para que **varias obras** viajen como `obra=a&obra=b` y no como `a,b`.

## Cómo se hace (mi elección)
- **Reusar** `filtro_cliente_obra.ejs`, `buscarCliente.js`, `filtroObra.js` y `/clientes/api/:id/obras`. Sin componentes nuevos.
- **Un solo helper de servidor** para "cliente + obras elegidas → `{ clienteSel, obras, opIds }`": se saca de `filtroCliente()` de Facturación (mismo código) y lo usan Facturación, Ventas y Transacciones.
- **Ventas**: el filtro recibe `opIds` y agrega `op.id = ANY(?::bigint[])` (igual que Liquidaciones). El cliente va como `clienteId`; el parámetro viejo `id_cliente` sigue funcionando para enlaces ya guardados.
- **Transacciones**: el filtro de la unión recibe `opIds` y agrega `u.id_op_encabezado = ANY(...)`. El cliente va como `clienteId` (ya existe `idCliente`; se unifica el nombre). `leerFiltros` lo comparte con el reporte, así lo que se ve es lo que se exporta.
- `th_sort.ejs` y `paginacion.ejs` pasan a aceptar listas (repiten el parámetro).

## Decisiones mías para revisar
1. **Transacciones, "Cliente / persona"**: ese texto también busca empleados y proveedores (los egresos). Lo dejo como un campo aparte llamado **"Empleado / proveedor"** (sin la lista de clientes del navegador) y el cliente pasa al componente. Así no se pierde buscar sueldos o compras por nombre.
2. **Transacciones con una obra elegida**: se ven los movimientos de las operaciones de esa obra. Los **pagos de cliente no se muestran**, porque no pertenecen a una obra (es lo mismo que hace Liquidaciones: con obra no muestra los pagos del cliente). Con solo el cliente elegido se ve todo lo suyo, como ahora.
3. **Ventas** lista solo ventas de material; la lista de obras del cliente incluye también obras de alquileres. Elegir una obra que solo tiene alquileres da lista vacía. No filtro la lista de obras por pantalla para no tener una API distinta por página.
4. **Anulado**: la lista de obras incluye operaciones anuladas (como Facturación), para no perder movimientos al filtrar.

## Fuera de alcance
- Alquileres, Cheques, Clientes y Cuentas corrientes: su buscador de texto es otra cosa (no es "elegir un cliente") y no cambia.
- No se toca Liquidaciones ni cómo se calculan las obras (`utils/obras.js`).
- Sin cambios de base de datos.

## Qué no debe pasar
- Un enlace viejo (`/ventas?id_cliente=12`) deja de filtrar.
- Una exportación (PDF/Excel de Transacciones, Libro) con filtros distintos a los de la pantalla.
- Un cliente elegido que no existe rompe la página (se ignora, como en Facturación).

## Cómo se verifica
- Pruebas del filtro (PGlite, como las demás) para Ventas y Transacciones: cliente solo, cliente + una obra, cliente + varias, obra sin operaciones, `id_cliente` viejo.
- Prueba de armado de enlaces con varias obras.
- Chrome headless contra la app local: escribir, elegir cliente, ver obras, marcar dos, filtrar, ordenar, paginar y exportar en Ventas y Transacciones.
