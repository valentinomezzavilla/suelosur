// Mapa de Contenedores — muestra los contenedores alquilados con las coordenadas que
// se guardaron al crear/editar cada alquiler. No geocodifica nada: si un alquiler no
// tiene coordenadas, va a la lista "Sin ubicar" (y se puede marcar a mano).
(function () {
  if (!window.L || !document.getElementById('mapaContenedores')) return

  const CFG = window.MAPA_CONTENEDORES || {}
  const CORDOBA_CENTER = [-31.4167, -64.1833]
  const MOTIVOS = {
    sin_resultado: 'No se encontró la dirección',
    ambigua:       'Dirección ambigua (varios lugares posibles)',
    sin_direccion: 'Solo tiene obra, sin calle',
    error:         'Falló la búsqueda (reintentar con el backfill)',
  }

  const map = L.map('mapaContenedores').setView(CORDOBA_CENTER, 12)
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map)
  const capa = L.layerGroup().addTo(map)

  const $ = (id) => document.getElementById(id)
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const fmtFecha = (iso) => {
    if (!iso) return '—'
    const [a, m, d] = String(iso).slice(0, 10).split('-')
    return `${d}/${m}/${a}`
  }
  const nroOp = (n) => 'OP-' + String(n).padStart(4, '0')
  const contTxt = (it) => it.numero_contenedor != null ? 'N° ' + it.numero_contenedor : 'Sin n°'

  function overlay(msg) {
    $('mapaOverlay').style.display = msg ? 'flex' : 'none'
    $('mapaOverlayMsg').textContent = msg || ''
  }

  function icono(it) {
    const estado = it.estado === 'pendiente_retiro' ? 'pendiente_retiro' : 'en_alquiler'
    return L.divIcon({
      className: '',
      html: `<div class="pin-cont pin-cont--${estado}"><span>${esc(it.numero_contenedor ?? '?')}</span></div>`,
      iconSize: [34, 34], iconAnchor: [17, 34], popupAnchor: [0, -32],
    })
  }

  function popup(it) {
    const estado = it.estado === 'pendiente_retiro' ? 'Pendiente de retiro' : 'En alquiler'
    const comoLlegar = `https://www.google.com/maps/dir/?api=1&destination=${it.lat},${it.lng}`
    return `
      <div class="popup-cont">
        <div class="popup-cont__titulo">Contenedor ${esc(contTxt(it))}</div>
        <div class="popup-cont__fila"><b>Cliente:</b> ${esc(it.cliente) || '—'}</div>
        <div class="popup-cont__fila"><b>Dirección:</b> ${esc(it.direccion) || '—'}</div>
        ${it.obra ? `<div class="popup-cont__fila"><b>Obra:</b> ${esc(it.obra)}</div>` : ''}
        <div class="popup-cont__fila"><b>Inicio:</b> ${fmtFecha(it.fecha_inicio)}</div>
        <div class="popup-cont__fila"><b>Estado:</b> ${estado}${it.geo_estado === 'manual' ? ' · <i>ubicado a mano</i>' : ''}</div>
        <div class="popup-cont__acciones">
          <a href="${comoLlegar}" target="_blank" rel="noopener">Cómo llegar</a>
          ${CFG.puedeEditar ? `<a href="/alquileres/contenedores/${it.id}">Ver ${nroOp(it.nro_op)}</a>` : ''}
        </div>
      </div>`
  }

  function renderSinUbicar(lista) {
    $('cardSinUbicar').style.display = lista.length ? '' : 'none'
    $('sinUbicarCount').textContent = lista.length
    $('listaSinUbicar').innerHTML = lista.map(it => `
      <div class="sin-ubicar-item">
        <div class="sin-ubicar-item__info">
          <div class="fw-semibold">${esc(contTxt(it))} · ${esc(it.cliente) || '—'}
            ${CFG.puedeEditar ? `<a href="/alquileres/contenedores/${it.id}" class="text-orange text-decoration-none small ms-1">${nroOp(it.nro_op)}</a>` : ''}
          </div>
          <div class="sin-ubicar-item__dir">${esc(it.direccion || (it.obra ? 'Obra: ' + it.obra : 'Sin dirección'))}</div>
          <small class="text-muted">${esc(MOTIVOS[it.geo_estado] || 'Ubicación pendiente de buscar')}</small>
        </div>
        ${CFG.puedeEditar ? `
        <div class="sin-ubicar-item__acciones">
          <button type="button" class="btn btn-sm btn-naranja" data-marcar="${it.id}">Marcar en el mapa</button>
          <a href="/alquileres/contenedores/${it.id}/editar" class="btn btn-sm btn-outline-secondary">Editar dirección</a>
        </div>` : ''}
      </div>`).join('')
  }

  let sinUbicarPorId = {}

  async function cargar() {
    overlay('Cargando…')
    let data
    try {
      const resp = await fetch('/alquileres/contenedores/mapa-data', { headers: { Accept: 'application/json' } })
      if (!resp.ok) throw new Error()
      data = await resp.json()
    } catch (e) {
      overlay('No se pudieron cargar los datos del mapa. Probá con "Actualizar".')
      return
    }

    capa.clearLayers()
    const { ubicados = [], sinUbicar = [] } = data
    sinUbicarPorId = Object.fromEntries(sinUbicar.map(it => [String(it.id), it]))

    ubicados.forEach(it => {
      L.marker([it.lat, it.lng], { icon: icono(it), title: contTxt(it) })
        .bindPopup(popup(it), { maxWidth: 280 })
        .addTo(capa)
    })
    renderSinUbicar(sinUbicar)

    const total = ubicados.length + sinUbicar.length
    $('mapaResumen').textContent = total
      ? `${ubicados.length} en el mapa${sinUbicar.length ? ` · ${sinUbicar.length} sin ubicar` : ''}`
      : ''

    if (!total) {
      overlay('No hay contenedores alquilados en este momento.')
      map.setView(CORDOBA_CENTER, 12)
    } else if (!ubicados.length) {
      overlay('Ningún contenedor alquilado tiene ubicación todavía. Revisá la lista "Sin ubicar".')
      map.setView(CORDOBA_CENTER, 12)
    } else {
      overlay(null)
      if (ubicados.length === 1) map.setView([ubicados[0].lat, ubicados[0].lng], 16)
      else map.fitBounds(L.latLngBounds(ubicados.map(it => [it.lat, it.lng])), { padding: [40, 40], maxZoom: 16 })
    }
  }

  // ── Ubicación manual: tocar el mapa donde está el contenedor ──
  let marcando = null      // alquiler que se está ubicando
  let marcaTemporal = null

  function salirDeMarcado() {
    marcando = null
    if (marcaTemporal) { capa.removeLayer(marcaTemporal); marcaTemporal = null }
    $('mapaAviso').style.display = 'none'
    $('mapaWrap').classList.remove('mapa-cont-picking')
  }

  function empezarMarcado(id) {
    const it = sinUbicarPorId[String(id)]
    if (!it) return
    salirDeMarcado()
    marcando = it
    overlay(null)
    $('mapaAvisoTxt').textContent = `Tocá dónde está el contenedor ${contTxt(it)}`
    $('mapaAviso').style.display = 'flex'
    $('mapaWrap').classList.add('mapa-cont-picking')
    $('mapaWrap').scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  map.on('click', (e) => {
    if (!marcando) return
    if (marcaTemporal) capa.removeLayer(marcaTemporal)
    const it = marcando
    marcaTemporal = L.marker(e.latlng, { icon: icono(it) }).addTo(capa)
    marcaTemporal.bindPopup(`
      <div class="popup-cont">
        <div class="popup-cont__titulo">¿Contenedor ${esc(contTxt(it))} acá?</div>
        <div class="popup-cont__acciones">
          <button type="button" class="btn btn-sm btn-naranja" id="btnGuardarUbic">Guardar ubicación</button>
        </div>
      </div>`).openPopup()
  })

  map.on('popupopen', (ev) => {
    const btn = ev.popup.getElement()?.querySelector('#btnGuardarUbic')
    if (!btn || !marcando || !marcaTemporal) return
    btn.addEventListener('click', async () => {
      btn.disabled = true
      const { lat, lng } = marcaTemporal.getLatLng()
      try {
        const resp = await fetch(`/alquileres/contenedores/${marcando.id}/ubicacion`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ lat, lng }),
        })
        if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || 'Error')
        salirDeMarcado()
        await cargar()
      } catch (e) {
        btn.disabled = false
        btn.textContent = 'No se pudo guardar — reintentar'
      }
    })
  })

  $('listaSinUbicar').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-marcar]')
    if (btn) empezarMarcado(btn.getAttribute('data-marcar'))
  })
  $('mapaAvisoCancelar').addEventListener('click', salirDeMarcado)
  $('btnRecargarMapa').addEventListener('click', () => { salirDeMarcado(); cargar() })

  cargar()
})()
