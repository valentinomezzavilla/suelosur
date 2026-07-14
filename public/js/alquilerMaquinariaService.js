document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('formNuevoAlquilerMaq')
  if (!form) return

  const configEl = document.getElementById('config-maquinaria')
  const config = configEl ? JSON.parse(configEl.textContent) : { precioHora: 15000, precioDia: 80000, modoPrecio: 'hora' }

  const selectMaq      = document.getElementById('selectMaquinaria')
  const selectChofer   = document.getElementById('selectChofer')
  const modoRadios     = document.querySelectorAll('input[name="modo_precio"]')
  const inputHoras     = document.getElementById('horas_pactadas')
  const inputDias      = document.getElementById('plazo_alquiler')
  const inputPrecio    = document.getElementById('precio_por_hora')
  const inputTotal     = document.getElementById('precio_total')
  const displayTotal   = document.getElementById('precioTotalDisplay')
  const grupoHoras     = document.getElementById('grupoHoras')
  const grupoDias      = document.getElementById('grupoDias')

  // mapa
  const btnBuscar  = document.getElementById('btnBuscarDireccion')
  const mapaDiv    = document.getElementById('mapaEntrega')
  const msgMapa    = document.getElementById('msgMapa')
  const mapaId     = 'mapaMaquinaria'

  if (btnBuscar) {
    btnBuscar.addEventListener('click', async () => {
      const calle  = document.getElementById('calle')?.value.trim()
      const numero = document.getElementById('numero')?.value.trim()
      if (!calle) {
        if (msgMapa) { msgMapa.textContent = 'Ingresá al menos la calle.'; msgMapa.style.display = 'block' }
        return
      }
      if (msgMapa) msgMapa.style.display = 'none'
      if (mapaDiv) mapaDiv.style.display = 'block'

      if (typeof MapService !== 'undefined') {
        if (!MapService.maps[mapaId]) MapService.init(mapaId)
        await MapService.buscarYMostrar(mapaId, calle, numero)
      }
    })
  }

  function getModo() {
    const checked = document.querySelector('input[name="modo_precio"]:checked')
    return checked ? checked.value : 'hora'
  }

  function actualizarVisibilidad() {
    const modo = getModo()
    if (grupoHoras) grupoHoras.style.display = modo === 'hora' ? '' : 'none'
    if (grupoDias) grupoDias.style.display = modo === 'dia' ? '' : 'none'
  }

  function calcularPrecio() {
    const modo = getModo()
    const precioUnit = Number(inputPrecio.value) || 0
    let total = 0
    if (modo === 'hora') {
      const horas = Number(inputHoras.value) || 0
      total = precioUnit * horas
    } else {
      const dias = Number(inputDias.value) || 0
      total = precioUnit * dias
    }
    inputTotal.value = total
    displayTotal.textContent = '$' + total.toLocaleString('es-AR')
    actualizarResumen()
  }

  // al seleccionar maquinaria, cargar precios
  if (selectMaq) {
    selectMaq.addEventListener('change', () => {
      const opt = selectMaq.options[selectMaq.selectedIndex]
      if (!opt || !opt.value) {
        inputPrecio.value = config.precioHora || 0
        calcularPrecio()
        return
      }
      const modo = opt.dataset.modo || 'hora'
      const precioH = Number(opt.dataset.precioHora) || config.precioHora
      const precioD = Number(opt.dataset.precioDia) || config.precioDia

      document.querySelectorAll('input[name="modo_precio"]').forEach(r => {
        if (r.value === modo) r.checked = true
      })
      inputPrecio.value = modo === 'hora' ? precioH : precioD
      actualizarVisibilidad()
      calcularPrecio()
    })
  }

  modoRadios.forEach(r => {
    r.addEventListener('change', () => {
      actualizarVisibilidad()
      const opt = selectMaq?.options[selectMaq.selectedIndex]
      if (opt && opt.value) {
        const modo = getModo()
        inputPrecio.value = modo === 'hora'
          ? (Number(opt.dataset.precioHora) || config.precioHora)
          : (Number(opt.dataset.precioDia) || config.precioDia)
      }
      calcularPrecio()
    })
  })

  ;[inputHoras, inputDias, inputPrecio].forEach(el => {
    if (el) el.addEventListener('input', calcularPrecio)
  })

  function actualizarResumen() {
    const elCliente = document.getElementById('res-cliente')
    const elDir     = document.getElementById('res-direccion')
    const elMaq     = document.getElementById('res-maquinaria')
    const elChofer  = document.getElementById('res-chofer')
    const elModal   = document.getElementById('res-modalidad')
    const elPago    = document.getElementById('res-pago')
    const elTotal   = document.getElementById('res-total-valor')

    if (elCliente) elCliente.textContent = document.getElementById('inputClienteNombre')?.value || '—'
    const calle  = document.getElementById('calle')?.value.trim()
    const numero = document.getElementById('numero')?.value.trim()
    if (elDir) elDir.textContent = calle ? `${calle} ${numero || ''}`.trim() : '—'
    if (elMaq) elMaq.textContent = selectMaq?.options[selectMaq.selectedIndex]?.text || '—'
    if (elChofer) elChofer.textContent = selectChofer?.options[selectChofer.selectedIndex]?.text || '—'

    const modo = getModo()
    if (elModal) elModal.textContent = modo === 'hora' ? 'Por horas' : 'Por día'

    const pagoMap = { efectivo: 'Efectivo', transferencia: 'Transferencia', cheque: 'Cheque', cuenta_corriente: 'Cuenta corriente' }
    const metodoPago = document.getElementById('metodoPago')?.value
    if (elPago) elPago.textContent = pagoMap[metodoPago] || '—'

    if (elTotal) elTotal.textContent = '$' + (Number(inputTotal.value) || 0).toLocaleString('es-AR')
  }

  ;['calle', 'numero', 'metodoPago'].forEach(id => {
    const el = document.getElementById(id)
    if (el) {
      el.addEventListener('change', actualizarResumen)
      el.addEventListener('input', actualizarResumen)
    }
  })
  if (selectChofer) selectChofer.addEventListener('change', actualizarResumen)

  document.addEventListener('clienteSeleccionado', actualizarResumen)
  document.addEventListener('clienteDeseleccionado', actualizarResumen)

  // Prevenir submit con Enter (solo confirmar con el botón)
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.type !== 'submit') {
      e.preventDefault()
    }
  })

  // validacion al submit
  form.addEventListener('submit', (e) => {
    // Solo aceptar submits originados por el botón Confirmar
    if (!e.submitter || !e.submitter.classList.contains('btn-finalizar')) {
      e.preventDefault()
      return
    }

    const clienteId = document.getElementById('inputClienteId')?.value
    if (!clienteId) {
      alert('Buscá y seleccioná un cliente antes de confirmar.')
      e.preventDefault()
      return
    }

    // Validar campos obligatorios
    const campos = [
      { id: 'calle', nombre: 'Calle' },
      { id: 'selectMaquinaria', nombre: 'Maquinaria' },
    ]
    const faltantes = campos.filter(c => !document.getElementById(c.id)?.value.trim())
    if (faltantes.length) {
      e.preventDefault()
      alert('Completá los campos obligatorios: ' + faltantes.map(c => c.nombre).join(', '))
      const primero = document.getElementById(faltantes[0].id)
      if (primero) primero.focus()
      return
    }

    // Validar que precio > 0
    const total = Number(inputTotal.value) || 0
    if (total <= 0) {
      e.preventDefault()
      alert('El precio total debe ser mayor a 0. Verificá la modalidad, las horas/días y el precio.')
      return
    }
  })

  // init
  inputPrecio.value = config.precioHora || 0
  actualizarVisibilidad()
  calcularPrecio()
})
