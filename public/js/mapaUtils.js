// Utilidades del mapa de contenedores (se usan en el navegador y en las pruebas con Node).
(function (raiz) {
  // Varios contenedores en el mismo punto (un alquiler agrupado, o varios en el centro del
  // mismo barrio) quedarían uno encima del otro. Se reparten en un círculo chico alrededor
  // del punto real, solo para dibujarlos: lat/lng no cambian (las usan "Cómo llegar" y el
  // encuadre del mapa).
  function separarSuperpuestos(items, radioMetros) {
    const radio = radioMetros || 12
    const grupos = new Map()
    items.forEach(it => {
      const clave = Number(it.lat).toFixed(5) + ',' + Number(it.lng).toFixed(5)
      if (!grupos.has(clave)) grupos.set(clave, [])
      grupos.get(clave).push(it)
    })
    const salida = []
    grupos.forEach(lista => {
      if (lista.length === 1) {
        salida.push(Object.assign({}, lista[0], { latDibujo: lista[0].lat, lngDibujo: lista[0].lng }))
        return
      }
      lista.forEach((it, i) => {
        const angulo = (2 * Math.PI * i) / lista.length
        const dLat = (radio * Math.cos(angulo)) / 111320
        const dLng = (radio * Math.sin(angulo)) / (111320 * Math.cos(it.lat * Math.PI / 180))
        salida.push(Object.assign({}, it, { latDibujo: it.lat + dLat, lngDibujo: it.lng + dLng }))
      })
    })
    return salida
  }

  const api = { separarSuperpuestos }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else raiz.MapaUtils = api
})(typeof window !== 'undefined' ? window : this)
