'use strict'
// Botones de solo ícono de la columna de acciones (partials/btn_icono.ejs + estilos + tooltip).
// Sin base de datos.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { renderVista } = require('./helpers/vistas')

const RAIZ = path.join(__dirname, '..')
const leer = (...p) => fs.readFileSync(path.join(RAIZ, ...p), 'utf8')
const sinSvg = (html) => html.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]*>/g, '').trim()

describe('partial btn_icono', () => {
  it('un botón: nombre accesible = tooltip, solo ícono, tono y atributos en el orden dado', async () => {
    const html = await renderVista('partials/btn_icono', {
      icono: 'checkCircle', etiqueta: 'Marcar como pagada', clase: 'btn-outline-success btn-estado-pago',
      attrs: { 'data-id': 5, 'data-accion': 'pagada', 'data-nombre': 'OP-0005 · "Viaje"' },
    })
    assert.match(html, /^\s*<button type="button"/)
    assert.match(html, /class="btn btn-sm btn-icon btn-outline-success btn-estado-pago"/)
    assert.match(html, /title="Marcar como pagada" aria-label="Marcar como pagada"/)
    assert.match(html, /data-bs-toggle="tooltip" data-bs-placement="top"/)
    assert.match(html, /data-id="5" data-accion="pagada" data-nombre="OP-0005 · &#34;Viaje&#34;"/)   // escapado
    assert.match(html, /<svg class="ic" width="16" height="16"/)
    assert.equal(sinSvg(html), '')
  })

  it('con href es un enlace (y en otra pestaña lleva rel="noopener")', async () => {
    const html = await renderVista('partials/btn_icono', { icono: 'printer', etiqueta: 'Imprimir remito PDF', href: '/remitos/3/pdf', target: '_blank' })
    assert.match(html, /^\s*<a href="\/remitos\/3\/pdf" target="_blank" rel="noopener"/)
    assert.match(html, /<\/a>\s*$/)
    assert.doesNotMatch(html, /type="button"/)
    const mismaPestana = await renderVista('partials/btn_icono', { icono: 'eye', etiqueta: 'Ver detalle', href: '/ventas/3' })
    assert.doesNotMatch(mismaPestana, /target=|rel=/)
  })

  it('en un formulario puede ser submit', async () => {
    const html = await renderVista('partials/btn_icono', { icono: 'ban', etiqueta: 'Anular este pago', clase: 'btn-outline-danger', tipo: 'submit' })
    assert.match(html, /<button type="submit"/)
  })

  it('sin etiqueta no se puede dibujar: un botón sin texto no puede quedar sin nombre', async () => {
    await assert.rejects(() => renderVista('partials/btn_icono', { icono: 'eye' }), /etiqueta/)
  })
})

describe('botones de pago y de factura', () => {
  const e = { id: 7, nombre: 'OP-0007 · Venta', acciones: { pagada: true, pendiente: true } }

  it('compacto: solo ícono (✓ verde y reloj rojo); en el detalle de la operación siguen con texto', async () => {
    const compacto = await renderVista('partials/botones_estado_pago', { e, compacto: true })
    assert.match(compacto, /aria-label="Marcar como pagada"/)
    assert.match(compacto, /aria-label="Marcar pendiente"/)
    assert.match(compacto, /btn-outline-success btn-estado-pago/)
    assert.match(compacto, /btn-outline-danger btn-estado-pago/)
    assert.match(compacto, /data-id="7" data-accion="pagada"/)
    assert.equal(sinSvg(compacto), '')
    const detalle = await renderVista('partials/botones_estado_pago', { e })
    assert.match(detalle, />Marcar como pagada<\/button>/)
    assert.match(detalle, />Marcar pendiente<\/button>/)
    assert.doesNotMatch(detalle, /btn-icon/)
  })

  it('sin permiso no hay botones', async () => {
    const html = await renderVista('partials/botones_estado_pago', { e, compacto: true, user: { rol: 'admin_ventas' } })
    assert.equal(html.trim(), '')
  })

  it('N°Factura: "+" neutro si no tiene número; documento en tono de acento y con el número en el nombre si lo tiene', async () => {
    const sin = await renderVista('partials/boton_nro_factura', { op: { id: 5, nro_op: 12, nro_factura: null, facturado: 0, estado: 'pendiente' } })
    assert.match(sin, /btn-outline-secondary btn-nro-factura/)
    assert.match(sin, /aria-label="Agregar N°Factura"/)
    assert.match(sin, /<line x1="9" y1="15" x2="15" y2="15"\/>/)   // el "+" del documento
    const con = await renderVista('partials/boton_nro_factura', { op: { id: 5, nro_op: 12, nro_factura: '0001-00001234', facturado: 0, estado: 'pendiente' } })
    assert.match(con, /btn-outline-primary btn-nro-factura/)
    assert.match(con, /aria-label="Editar N°Factura: 0001-00001234"/)
    assert.match(con, /title="Editar N°Factura: 0001-00001234"/)
    assert.doesNotMatch(con, /<line x1="9" y1="15" x2="15" y2="15"\/>/)
    assert.equal(sinSvg(sin) + sinSvg(con), '')
  })
})

describe('estilos y tooltip', () => {
  it('el componente está definido, importado y con medidas táctiles en mobile', () => {
    const scss = leer('src', 'scss', 'components', '_buttons-icon.scss')
    assert.match(scss, /\.acciones-fila\s*\{/)
    assert.match(scss, /\.btn\.btn-icon\s*\{/)
    assert.match(scss, /\.tooltip\s*\{/)
    assert.match(scss, /prefers-reduced-motion/)
    assert.match(leer('src', 'scss', 'main.scss'), /@use 'components\/buttons-icon';/)
    assert.match(leer('src', 'scss', 'base', '_mobile.scss'), /\.btn\.btn-icon\s*\{\s*width:\s*38px/)
  })

  it('el layout carga el script de tooltips después de Bootstrap, y sin Bootstrap no rompe', () => {
    const layout = leer('views', 'layouts', 'main.ejs')
    assert.ok(layout.indexOf('bootstrap.bundle.min.js') < layout.indexOf('/js/tooltips.js'))
    const js = leer('public', 'js', 'tooltips.js')
    assert.match(js, /if \(!window\.bootstrap \|\| !window\.bootstrap\.Tooltip\) return;/)
    assert.match(js, /container: 'body'/)           // la tabla no lo recorta
    assert.match(js, /trigger: 'hover focus'/)      // también con teclado
    assert.match(js, /addEventListener\('click'/)   // se esconde al abrir el modal
  })
})
