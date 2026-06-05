document.addEventListener('DOMContentLoaded', () => {
  // Stock index — Modal Ajuste
  const modalAjuste = document.getElementById('modalAjuste')
  if (modalAjuste) {
    modalAjuste.addEventListener('show.bs.modal', function (e) {
      const btn = e.relatedTarget
      document.getElementById('modalProductoNombre').textContent = btn.dataset.nombre
      document.getElementById('inputActual').value = btn.dataset.actual
      document.getElementById('inputMinimo').value = btn.dataset.minimo
      document.getElementById('formAjuste').action = '/stock/' + btn.dataset.id + '/ajustar'
    })
  }

  // Stock index — Modal Ingreso
  const selectIngreso = document.getElementById('selectProductoIngreso')
  if (selectIngreso) {
    selectIngreso.addEventListener('change', function () {
      const opt = this.options[this.selectedIndex]
      document.getElementById('unidadIngreso').textContent = opt.dataset.unidad || '—'
      document.getElementById('formIngreso').action = '/stock/' + this.value + '/ingreso'
    })
  }

  // Stock egreso — producto select
  const selectEgreso = document.getElementById('selectProducto')
  if (selectEgreso) {
    selectEgreso.addEventListener('change', function () {
      const opt = this.options[this.selectedIndex]
      const labelUnidad = document.getElementById('labelUnidad')
      const formEgreso = document.getElementById('formEgreso')
      if (labelUnidad) labelUnidad.textContent = opt.dataset.unidad || '—'
      if (formEgreso) formEgreso.action = '/stock/' + this.value + '/egreso'
    })
  }
})
