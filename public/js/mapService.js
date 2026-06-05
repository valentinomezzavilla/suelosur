const MapService = {
  maps: {},

  init(containerId, options) {
    const opts = options || {}
    const container = document.getElementById(containerId)
    if (!container || !window.L) return null

    const map = L.map(containerId).setView(
      opts.center || [-31.4167, -64.1833],
      opts.zoom || 14
    )
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map)

    this.maps[containerId] = { map: map, marker: null }
    return map
  },

  async geocode(address) {
    const query = encodeURIComponent(address + ', Córdoba, Argentina')
    const url = 'https://nominatim.openstreetmap.org/search?q=' + query + '&format=json&limit=1&countrycodes=ar'
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Suelosur-ERP/1.0' }
      })
      const data = await resp.json()
      if (!data.length) return null
      return {
        lat: parseFloat(data[0].lat),
        lng: parseFloat(data[0].lon),
        display: data[0].display_name,
      }
    } catch (err) {
      console.error('Geocoding error:', err)
      return null
    }
  },

  async buscarYMostrar(containerId, calle, numero) {
    const entry = this.maps[containerId]
    if (!entry) return null

    const query = (calle + ' ' + (numero || '')).trim()
    const result = await this.geocode(query)
    if (!result) return null

    if (entry.marker) entry.map.removeLayer(entry.marker)
    entry.marker = L.marker([result.lat, result.lng]).addTo(entry.map)
    entry.map.setView([result.lat, result.lng], 16)

    const inputLat = document.getElementById('inputLat')
    const inputLng = document.getElementById('inputLng')
    if (inputLat) inputLat.value = result.lat
    if (inputLng) inputLng.value = result.lng

    return result
  },

  destroy(containerId) {
    if (this.maps[containerId]) {
      this.maps[containerId].map.remove()
      delete this.maps[containerId]
    }
  }
}
