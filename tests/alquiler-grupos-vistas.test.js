'use strict'
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { renderVista } = require('./helpers/vistas')

describe('vistas de alquileres agrupados', () => {
  it('nuevo: barra de selección múltiple y bloque de varios contenedores con selector de cobro', async () => {
    const html = await renderVista('pages/alquileres/nuevo', {
      disponibles: [{ id: 3, numero_contenedor: 19 }, { id: 5, numero_contenedor: 20 }],
      porLiberar: [], choferesDisp: [], camionesDisp: [], zonas: [],
      configPlazos: { cuenta_corriente: 10, estandar: 4 },
    })
    assert.match(html, /id="barraSeleccion"/)
    assert.match(html, /id="btnContinuarSeleccion"/)
    assert.match(html, /id="bloqueVariosContenedores"/)
    assert.match(html, /id="inputsContenedores"/)
    assert.match(html, /name="cobro_modo" value="contenedor" checked/)
    assert.match(html, /name="cobro_modo" value="alquiler"/)
    assert.match(html, /id="rowCheckFinalizado"/)
  })
})
