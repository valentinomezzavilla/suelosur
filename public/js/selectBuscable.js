// Select buscable: a un <select data-buscable> le agrega un campo de texto para ir
// escribiendo y filtrar las opciones (sin distinguir mayúsculas ni acentos), con el mismo
// desplegable de siempre. El <select> queda oculto y sigue siendo el que viaja en el form.
(() => {
    const normalizar = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim()

    function mejorar(select) {
        if (select.dataset.buscableListo) return
        select.dataset.buscableListo = '1'

        const vacia = [...select.options].find(o => o.value === '')
        const opciones = [...select.options].filter(o => o.value !== '')

        const cont = document.createElement('div')
        cont.className = 'select-buscable'
        const input = document.createElement('input')
        input.type = 'text'
        input.autocomplete = 'off'
        input.className = select.className.replace(/\bform-select\b/g, 'form-control').replace(/\bform-select-sm\b/g, 'form-control-sm')
        input.placeholder = vacia ? vacia.textContent.trim() : 'Escribí para buscar...'
        const lista = document.createElement('ul')
        lista.className = 'autocomplete-dropdown'
        lista.style.display = 'none'

        select.parentNode.insertBefore(cont, select)
        cont.append(input, lista, select)
        select.style.display = 'none'

        const textoElegido = () => (select.value ? select.options[select.selectedIndex].textContent.trim() : '')
        input.value = textoElegido()

        let activa = -1
        let visibles = []

        function pintar() {
            const filtro = normalizar(input.value === textoElegido() ? '' : input.value)
            visibles = [vacia, ...opciones.filter(o => normalizar(o.textContent).includes(filtro))].filter(Boolean)
            lista.innerHTML = ''
            visibles.forEach((o, i) => {
                const li = document.createElement('li')
                li.className = 'autocomplete-item' + (i === activa ? ' is-activa' : '')
                li.textContent = o.textContent.trim()
                // mousedown (no click): se elige antes de que el input pierda el foco
                li.addEventListener('mousedown', (e) => { e.preventDefault(); elegir(o) })
                lista.appendChild(li)
            })
            if (visibles.length === (vacia ? 1 : 0)) {
                const li = document.createElement('li')
                li.className = 'autocomplete-item select-buscable__vacio'
                li.textContent = 'Sin resultados'
                lista.appendChild(li)
            }
            lista.style.display = ''
        }

        function elegir(o) {
            select.value = o.value
            select.dispatchEvent(new Event('change', { bubbles: true }))
            input.value = textoElegido()
            cerrar()
        }

        function cerrar() {
            lista.style.display = 'none'
            activa = -1
        }

        input.addEventListener('focus', () => { input.select(); activa = -1; pintar() })
        input.addEventListener('input', () => { activa = -1; pintar() })
        input.addEventListener('blur', () => {
            // Lo escrito sin elegir nada no cuenta: vuelve a mostrar lo que está elegido
            input.value = textoElegido()
            cerrar()
        })
        input.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                if (lista.style.display === 'none') pintar()
                const n = visibles.length
                if (!n) return
                activa = e.key === 'ArrowDown' ? (activa + 1) % n : (activa - 1 + n) % n
                pintar()
                lista.children[activa]?.scrollIntoView({ block: 'nearest' })
            } else if (e.key === 'Enter') {
                if (lista.style.display === 'none') return
                // Enter elige la marcada (o la primera que coincide) en vez de mandar el form
                const o = visibles[activa] || visibles.find(v => v.value !== '')
                if (o) { e.preventDefault(); elegir(o) }
            } else if (e.key === 'Escape') {
                input.value = textoElegido()
                cerrar()
            }
        })
        // Si otro código cambia el select (ej. "Limpiar"), se refleja en el campo
        select.addEventListener('change', () => { input.value = textoElegido() })
        select.form?.addEventListener('reset', () => setTimeout(() => { input.value = textoElegido() }))
    }

    const iniciar = () => document.querySelectorAll('select[data-buscable]').forEach(mejorar)
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar)
    else iniciar()
})()
