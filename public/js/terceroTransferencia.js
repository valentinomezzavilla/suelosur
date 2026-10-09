'use strict'
// ═══════════════════════════════════════════════════════════════════
// "Destinado a tercero" en los métodos de pago de cobro.
// En cada <select data-tercero> (método de pago), al elegir Transferencia aparece el
// check "Destinado a tercero"; al marcarlo, el desplegable "¿A qué se destinó?" con las
// mismas categorías de Compras / Pagos, y según la categoría elegida se habilitan sus
// campos (proveedor, vehículo, empleado…). "Otro" pide un concepto libre.
// El servidor registra el egreso por el mismo monto (services/tercero.service.js).
//
//  · data-tercero-valor='{"categoria":…}' precarga un tercero ya guardado.
//  · Si el método se cambia por código, disparar 'change' en el select; el evento
//    'tercero:reset' además limpia lo elegido (modales que se reutilizan).
// ═══════════════════════════════════════════════════════════════════
(function () {
  const CAMPOS = [
    { campo: 'proveedor', col: 'id_proveedor', label: 'Proveedor *', lista: 'proveedores' },
    { campo: 'vehiculo',  col: 'id_vehiculo',  label: 'Vehículo',    lista: 'vehiculos' },
    { campo: 'empleado',  col: 'id_empleado',  label: 'Empleado',    lista: 'empleados' },
    { campo: 'producto',  col: 'id_producto',  label: 'Producto',    lista: 'productos' },
    { campo: 'fletero',   col: 'fletero',      label: 'Fletero',     tipo: 'text' },
    { campo: 'periodo',   col: 'periodo',      label: 'Período',     tipo: 'month' },
  ]
  let cache = null
  const opciones = () => cache || (cache = fetch('/api/tercero/opciones', { credentials: 'same-origin' })
    .then(r => (r.ok ? r.json() : null)).catch(() => null))

  function el(tag, attrs, hijos) {
    const n = document.createElement(tag)
    Object.entries(attrs || {}).forEach(([k, v]) => { if (v != null) n.setAttribute(k, v) })
    ;(hijos || []).forEach(h => n.append(h))
    return n
  }
  const opcion = (value, texto) => { const o = el('option', { value }); o.textContent = texto; return o }
  const grupo = (label, control) => el('div', { class: 'tercero-box__campo' }, [el('label', { class: 'form-label small mb-1' }, [label]), control])

  // Dónde va el bloque: debajo del select (o de su contenedor) sin romper filas/flex
  function ubicar(select, box) {
    const p = select.parentElement
    if (p.tagName === 'FORM') return p.append(box)
    const abuelo = p.parentElement
    if (abuelo && abuelo.tagName === 'FORM' && getComputedStyle(abuelo).display.includes('flex')) return abuelo.append(box)
    if (abuelo && abuelo.classList.contains('row')) box.classList.add('col-12')
    p.after(box)
  }

  async function armar(select) {
    const op = await opciones()
    if (!op || !op.categorias.length) return
    const id = 'tercero' + Math.random().toString(36).slice(2, 8)

    const chk = el('input', { type: 'checkbox', name: 'tercero', value: '1', id: id + 'Chk' })
    const fila = el('label', { class: 'toggle-row mt-1', for: id + 'Chk' }, [chk, ' Destinado a tercero'])

    const cat = el('select', { name: 'tercero_categoria', class: 'form-select form-select-sm' },
      [opcion('', '¿A qué se destinó?…'), ...op.categorias.map(c => opcion(c.clave, c.clave === 'otro' ? 'Otro (escribir concepto)' : c.etiqueta))])
    const campos = CAMPOS.map(c => {
      const control = c.lista
        ? el('select', { name: 'tercero_' + c.col, class: 'form-select form-select-sm' },
            [opcion('', 'Seleccionar…'), ...(op[c.lista] || []).map(x => opcion(x.id, x.nombre))])
        : el('input', { type: c.tipo, name: 'tercero_' + c.col, class: 'form-control form-control-sm' })
      return { ...c, control, wrap: grupo(c.label, control) }
    })
    const concepto = el('input', { type: 'text', name: 'tercero_concepto', class: 'form-control form-control-sm', placeholder: 'Ej.: pago al flete de Juan Pérez', maxlength: '200' })
    const wrapConcepto = grupo('Concepto *', concepto)

    const detalle = el('div', { class: 'tercero-box__detalle' }, [grupo('Destino *', cat), ...campos.map(c => c.wrap), wrapConcepto])
    const box = el('div', { class: 'tercero-box' }, [fila, detalle])
    ubicar(select, box)

    const mostrar = (n, si) => {
      n.hidden = !si
      // Lo oculto no se envía ni se valida
      n.querySelectorAll('input, select').forEach(i => { i.disabled = !si })
    }
    function sync() {
      const esTransf = select.value === 'transferencia' && !select.disabled
      box.hidden = !esTransf
      chk.disabled = !esTransf
      const abierto = esTransf && chk.checked
      mostrar(detalle, abierto)
      if (!abierto) return
      cat.required = true
      const def = op.categorias.find(c => c.clave === cat.value)
      campos.forEach(c => {
        const si = !!def && def.campos.includes(c.campo)
        mostrar(c.wrap, si)
        c.control.required = si && c.campo === 'proveedor'
      })
      mostrar(wrapConcepto, cat.value === 'otro')
      concepto.required = cat.value === 'otro'
    }

    // Precarga (edición de una operación que ya tenía tercero)
    try {
      const v = select.dataset.terceroValor ? JSON.parse(select.dataset.terceroValor) : null
      if (v && v.categoria) {
        chk.checked = true
        cat.value = v.categoria
        campos.forEach(c => { if (v[c.col] != null) c.control.value = v[c.col] })
        concepto.value = v.concepto || ''
      }
    } catch (_) {}

    select.addEventListener('change', sync)
    chk.addEventListener('change', sync)
    cat.addEventListener('change', sync)
    select.addEventListener('tercero:reset', () => {
      chk.checked = false; cat.value = ''; concepto.value = ''
      campos.forEach(c => { c.control.value = '' })
      sync()
    })
    sync()
  }

  function init() { document.querySelectorAll('select[data-tercero]').forEach(armar) }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
