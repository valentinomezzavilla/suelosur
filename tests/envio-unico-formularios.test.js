'use strict'
// Ningún script de pantalla puede enviar un formulario POST con form.submit(): ese método no
// dispara el evento 'submit', así que appLoader.js no le pone el código de envío único
// (_envio) y un doble click registra dos veces la venta / el pago (y la transferencia a una
// estación de servicio, que baja la deuda con ella). Se usa requestSubmit().
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const JS = path.join(__dirname, '..', 'public', 'js')
const archivos = fs.readdirSync(JS).filter(f => f.endsWith('.js'))

describe('envío único de formularios', () => {
  it('los scripts de pantalla no usan form.submit() sin requestSubmit', () => {
    const sospechosos = archivos.filter(f => {
      const src = fs.readFileSync(path.join(JS, f), 'utf8').replace(/\/\/.*$/gm, '')
      return /\.submit\(\)/.test(src) && !/requestSubmit/.test(src)
    })
    assert.deepEqual(sospechosos, [])
  })

  it('la venta de Cantera se envía con requestSubmit y deshabilita el botón', () => {
    const src = fs.readFileSync(path.join(JS, 'ventasCantera.js'), 'utf8')
    assert.match(src, /btnConfirmar\.disabled = true;\s*\n\s*if \(typeof formCantera\.requestSubmit === 'function'\) formCantera\.requestSubmit\(\)/)
  })

  it('appLoader.js le pone el código _envio a todo formulario POST', () => {
    const src = fs.readFileSync(path.join(JS, 'appLoader.js'), 'utf8')
    assert.match(src, /name = '_envio'/)
  })
})
