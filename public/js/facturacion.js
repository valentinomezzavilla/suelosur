(() => {
  const root = document.getElementById('factRoot')
  if (!root) return
  const empresa = root.dataset.empresa || 'RI'
  const afipOk  = root.dataset.afip === '1'
  const money = (n) => '$' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const redondear = (n) => Math.round((Number(n) || 0) * 100) / 100
  const tipoSugerido = (cond) => empresa === 'MT' ? 'C' : (['RI', 'MT'].includes(cond) ? 'A' : 'B')
  const $ = (id) => document.getElementById(id)

  // ── Selección de operaciones (todas del mismo cliente) ──────────
  const seleccionadas = () => [...document.querySelectorAll('.js-sel:checked')]
  const btnSel = $('btnFacturarSel')
  const selInfo = $('selInfo')
  const textoBase = selInfo ? selInfo.textContent : ''

  function actualizarBarra(aviso) {
    if (!btnSel) return
    const s = seleccionadas()
    const total = s.reduce((a, c) => a + Number(c.dataset.monto), 0)
    selInfo.textContent = aviso || (s.length
      ? `${s.length} seleccionada${s.length === 1 ? '' : 's'} de ${s[0].dataset.cliente} · ${money(total)}`
      : textoBase)
    btnSel.disabled = !s.length
  }

  document.addEventListener('change', (e) => {
    const cb = e.target.closest('.js-sel')
    if (!cb) return
    let aviso = ''
    if (cb.checked) {
      const otras = seleccionadas().filter(o => o !== cb && o.dataset.clienteId !== cb.dataset.clienteId)
      if (otras.length) {
        otras.forEach(o => { o.checked = false })
        aviso = `Se deseleccionaron operaciones de otro cliente: una factura es para un solo cliente.`
      }
    }
    actualizarBarra(aviso)
  })

  // ── Modal de factura ────────────────────────────────────────────
  const modalFact = $('modalFacturar')
  let totalModal = 0

  function actualizarPreview() {
    const tipo = $('fTipo').value
    const alic = tipo === 'C' ? 0 : Number($('fAlicuota').value)
    $('wrapAlicuota').hidden = tipo === 'C'
    const neto = alic ? redondear(totalModal / (1 + alic / 100)) : totalModal
    $('pvNeto').textContent = money(neto)
    $('pvIva').textContent = money(redondear(totalModal - neto))
    $('pvTotal').textContent = money(totalModal)
  }

  function actualizarModo(form, camposId, inputId) {
    const afip = form.querySelector('input[name="modo"]:checked')?.value === 'afip'
    $(camposId).hidden = afip
    $(inputId).required = !afip
  }

  function abrirFacturar(checks) {
    if (!checks.length || !modalFact) return
    const d = checks[0].dataset
    totalModal = redondear(checks.reduce((a, c) => a + Number(c.dataset.monto), 0))
    $('facturarIds').value = checks.map(c => c.dataset.id).join(',')
    $('facturarResumen').innerHTML = ''
    const strong = document.createElement('strong')
    strong.textContent = d.cliente
    $('facturarResumen').append(strong, ` · ${checks.map(c => c.dataset.op).join(', ')}`)
    $('fCond').value = d.cond || 'CF'
    $('fCuit').value = d.cuit || ''
    $('fRazon').value = d.razon || ''
    const sug = tipoSugerido($('fCond').value)
    if ([...$('fTipo').options].some(o => o.value === sug)) $('fTipo').value = sug
    $('fAlicuota').value = '21'
    $('fNumero').value = ''
    $('formFacturar').querySelector('input[name="modo"][value="manual"]').checked = true
    actualizarModo($('formFacturar'), 'camposManual', 'fNumero')
    actualizarPreview()
    bootstrap.Modal.getOrCreateInstance(modalFact).show()
  }

  btnSel?.addEventListener('click', () => abrirFacturar(seleccionadas()))

  document.addEventListener('click', (e) => {
    const uno = e.target.closest('.js-facturar-uno')
    if (uno) {
      const cb = document.querySelector(`.js-sel[data-id="${uno.dataset.id}"]`)
      document.querySelectorAll('.js-sel').forEach(o => { o.checked = o === cb })
      actualizarBarra()
      abrirFacturar(cb ? [cb] : [])
    }
  })

  if (modalFact) {
    $('fCond').addEventListener('change', () => {
      const sug = tipoSugerido($('fCond').value)
      if ([...$('fTipo').options].some(o => o.value === sug)) $('fTipo').value = sug
      actualizarPreview()
    })
    $('fTipo').addEventListener('change', actualizarPreview)
    $('fAlicuota').addEventListener('change', actualizarPreview)
    $('formFacturar').addEventListener('change', (e) => {
      if (e.target.name === 'modo') actualizarModo($('formFacturar'), 'camposManual', 'fNumero')
    })
    $('formFacturar').addEventListener('submit', (e) => {
      if ($('fTipo').value === 'A' && !$('fCuit').value.trim()) {
        e.preventDefault()
        $('fCuit').setCustomValidity('La factura A requiere el CUIT del cliente.')
        $('fCuit').reportValidity()
      }
    })
    $('fCuit').addEventListener('input', () => $('fCuit').setCustomValidity(''))
  }

  // ── Modal de nota de crédito ────────────────────────────────────
  const modalNC = $('modalNC')
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.js-nc')
    if (!btn || !modalNC) return
    $('formNC').action = `/facturacion/${btn.dataset.id}/nota-credito`
    $('ncLabel').textContent = btn.dataset.label
    $('ncNumero').value = ''
    const puedeAfip = afipOk && btn.dataset.origen === 'afip'
    $('ncModoAfip').disabled = !puedeAfip
    $('ncModoAfip').closest('label').title = puedeAfip ? '' : 'Solo para facturas emitidas con AFIP'
    $('formNC').querySelector('input[name="modo"][value="manual"]').checked = true
    actualizarModo($('formNC'), 'ncCamposManual', 'ncNumero')
    bootstrap.Modal.getOrCreateInstance(modalNC).show()
  })
  $('formNC')?.addEventListener('change', (e) => {
    if (e.target.name === 'modo') actualizarModo($('formNC'), 'ncCamposManual', 'ncNumero')
  })
})()
