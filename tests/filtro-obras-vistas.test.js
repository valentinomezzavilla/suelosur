'use strict'
// Componente de filtro por obra con varias obras (views/partials/filtro_obras.ejs) y los
// formularios que lo usan (Libro de ventas, Reporte de cliente, filtro cliente + obra).
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { renderVista } = require('./helpers/vistas')

const obras = [{ clave: 'barrio norte l1', nombre: 'Barrio Norte L1' }, { clave: 'barrio sur l2', nombre: 'Barrio Sur L2' }, { clave: 'centro l3', nombre: 'Centro L3' }]
const casillas = (html) => html.match(/<input type="checkbox" name="obra"[^>]*>/g) || []
const texto = (html) => html.match(/<span class="filtro-obras__texto">([^<]*)<\/span>/)[1]
const boton = (html) => html.match(/<button type="button" id="filtroObra"[^>]*>/)[0]

describe('partials/filtro_obras', () => {
  it('ninguna marcada: "Todas las obras", una casilla por obra y "Desmarcar" apagado', async () => {
    const html = await renderVista('partials/filtro_obras', { obras })
    assert.equal(casillas(html).length, 3)
    assert.equal(casillas(html).filter(c => /checked/.test(c)).length, 0)
    assert.equal(texto(html), 'Todas las obras')
    assert.doesNotMatch(boton(html), /disabled/)
    assert.match(html, /class="filtro-obras__limpiar" disabled/)
    // Pocas obras: sin buscador
    assert.match(html, /filtro-obras__buscar"[^>]*hidden/)
  })

  it('varias marcadas: quedan tildadas y el botón las resume', async () => {
    const html = await renderVista('partials/filtro_obras', { obras, elegidas: ['barrio norte l1', 'centro l3'] })
    const marcadas = casillas(html).filter(c => /checked/.test(c))
    assert.deepEqual(marcadas.map(c => c.match(/value="([^"]*)"/)[1]), ['barrio norte l1', 'centro l3'])
    assert.equal(texto(html), '2 obras: Barrio Norte L1, Centro L3')
    assert.match(boton(html), /title="Barrio Norte L1 · Centro L3"/)
    assert.match(html, /2 de 3 marcadas/)
  })

  it('una marcada (como texto): su nombre en el botón', async () => {
    const html = await renderVista('partials/filtro_obras', { obras, elegidas: 'barrio sur l2' })
    assert.equal(texto(html), 'Barrio Sur L2')
  })

  it('una obra elegida que ya no está en el listado se muestra marcada', async () => {
    const html = await renderVista('partials/filtro_obras', { obras, elegidas: ['vieja'] })
    assert.equal(casillas(html).length, 4)
    assert.equal(texto(html), 'vieja')
  })

  it('sin obras: deshabilitado con el texto que corresponda', async () => {
    const html = await renderVista('partials/filtro_obras', { obras: [], textoVacio: 'Elegí un cliente para ver sus obras', dinamico: true })
    assert.match(boton(html), /disabled/)
    assert.equal(texto(html), 'Elegí un cliente para ver sus obras')
    assert.match(html, /data-filtro-obras data-dinamico/)
  })

  it('con muchas obras aparece el buscador', async () => {
    const muchas = Array.from({ length: 8 }, (_, i) => ({ clave: `obra ${i}`, nombre: `Obra ${i}` }))
    const html = await renderVista('partials/filtro_obras', { obras: muchas })
    assert.doesNotMatch(html.match(/<input type="search"[^>]*>/)[0], /hidden/)
  })
})

describe('formularios con el filtro de obras', () => {
  it('filtro cliente + obra sin cliente: obras deshabilitadas y se cargan al elegir cliente', async () => {
    const html = await renderVista('partials/filtro_cliente_obra', { clienteSel: null, obras: [], obraSel: [] })
    assert.match(boton(html), /disabled/)
    assert.equal(texto(html), 'Elegí un cliente para ver sus obras')
    assert.match(html, /data-dinamico/)
  })

  it('Libro de ventas: el componente nuevo, sin el select viejo', async () => {
    const html = await renderVista('pages/ventas/libro', { filtros: {} })
    assert.match(html, /data-filtro-obras data-dinamico/)
    assert.doesNotMatch(html, /<select name="obra"/)
  })

  it('Libro de ventas: usa el componente compartido de cliente y obras (no una copia a mano)', async () => {
    const html = await renderVista('pages/ventas/libro', { filtros: {} })
    assert.match(html, /class="col-12 col-md-6 filtro-cliente position-relative"/)
    assert.ok(html.includes('<input type="hidden" name="clienteId" id="inputClienteId" value="">'))
    assert.match(html, /data-filtro-obras data-dinamico/)
    assert.doesNotMatch(html, /Cliente \(opcional\)/)
  })

  it('Reporte de cliente: casillas con las obras del cliente', async () => {
    const html = await renderVista('pages/clientes/reporte', { cliente: { id: 7, numero: 7, nombre: 'Ana', apellido: 'Paz' }, obras,
      filtros: { fechaDesde: '', fechaHasta: '' } })
    assert.equal(casillas(html).length, 3)
    assert.doesNotMatch(html, /<select name="obra"/)
  })
})
