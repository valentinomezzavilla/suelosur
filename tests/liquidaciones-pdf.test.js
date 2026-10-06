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
