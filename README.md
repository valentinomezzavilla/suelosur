# Suelosur S.A.S. — Sistema de Gestión Integral

## Instalación

```bash
npm install
npm run dev    # desarrollo con nodemon
npm start      # producción
```

La base de datos SQLite se crea automáticamente en `data/suelosur.db` al primer inicio.

## Credenciales de prueba (contraseña: suelosur123)

| Usuario          | Rol             |
|-----------------|-----------------|
| valentino        | Dueño (todos los módulos) |
| admin_ventas     | Admin Ventas    |
| admin_contable   | Admin Contable  |
| chofer1          | Chofer          |

## Módulos disponibles (Sprint 1)

- `/ventas` — Ventas en cantera y con viaje (áridos)
- `/alquileres/contenedores` — Alquileres de contenedores
- `/alquileres/maquinaria` — Alquileres de Bobcat / maquinaria
- `/contenedores` — Catálogo físico de contenedores
- `/maquinaria` — Catálogo físico de maquinaria
- `/clientes` — Gestión de clientes
- `/productos` — Catálogo de áridos
- `/stock` — Control de stock de áridos
- `/transacciones` — Historial de transacciones

## Sprints futuros

| Sprint | Módulo |
|--------|--------|
| 3 | Circuitos logísticos |
| 4 | Cobranzas y CC clientes |
| 5 | Compras y proveedores |
| 6 | Flota + facturación ARCA |
| 7 | Dashboard KPIs + deploy Railway |
