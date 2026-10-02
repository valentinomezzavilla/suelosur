'use strict'
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { separarSuperpuestos } = require('../public/js/mapaUtils')

const metros = (a, b) => {
  const dLat = (b.latDibujo - a.lat) * 111320
  const dLng = (b.lngDibujo - a.lng) * 111320 * Math.cos(a.lat * Math.PI / 180)
  return Math.hypot(dLat, dLng)
}

describe('separarSuperpuestos', () => {
  it('un pin solo queda en su lugar', () => {
    const [it1] = separarSuperpuestos([{ id: 1, lat: -31.4, lng: -64.2 }])
    assert.deepEqual([it1.latDibujo, it1.lngDibujo], [-31.4, -64.2])
  })

  it('varios en el mismo punto se reparten a ~12 m sin perder la ubicación real', () => {
    const salida = separarSuperpuestos([1, 2, 3].map(id => ({ id, lat: -31.46, lng: -64.30 })))
    const posiciones = new Set(salida.map(it => `${it.latDibujo.toFixed(7)},${it.lngDibujo.toFixed(7)}`))
    assert.equal(posiciones.size, 3)
    for (const it of salida) {
      assert.deepEqual([it.lat, it.lng], [-31.46, -64.30])
      assert.ok(Math.abs(metros(it, it) - 12) < 0.5)
    }
  })

  it('puntos distintos no se tocan', () => {
    const salida = separarSuperpuestos([{ id: 1, lat: -31.4, lng: -64.2 }, { id: 2, lat: -31.5, lng: -64.3 }])
    for (const it of salida) assert.deepEqual([it.latDibujo, it.lngDibujo], [it.lat, it.lng])
  })
})
