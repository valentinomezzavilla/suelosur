document.addEventListener('DOMContentLoaded', () => {
    const selectProducto = document.getElementById('productoViaje');
    const inputCantidad  = document.getElementById('cantidadViaje');
    const subtotalEl     = document.getElementById('subtotalProducto');
    const precioHidden   = document.getElementById('precioProductoHidden');
    const inputFlete     = document.getElementById('precioFlete');
    const totalDisplay   = document.getElementById('totalDisplay');
    const checkEditar    = document.getElementById('checkEditarTotal');
    const totalInput     = document.getElementById('precioTotalInput');
    const btnBuscar      = document.getElementById('btnBuscarDireccionViaje');
    const msgMapa        = document.getElementById('msgMapaViaje');
    const mapaDiv        = document.getElementById('mapaViaje');
    const iframeMapa     = document.getElementById('iframeMapaViaje');
    const opFinalizar    = document.getElementById('opFinalizar');
    const opProgramar    = document.getElementById('opProgramar');
    const hiddenFinalizar = document.getElementById('inputFinalizarAhora');
    const fechaInput     = document.getElementById('fechaViaje');

    // fecha minima: hoy
    const hoy = new Date().toISOString().split('T')[0];
    if (fechaInput) fechaInput.min = hoy;

    // cuando selecciono un cliente, le cargo el telefono automaticamente
    document.addEventListener('clienteSeleccionado', (e) => {
        const c = e.detail;
        const telInput = document.getElementById('telefonoViaje');
        if (telInput && c.telefono) telInput.value = c.telefono;
    });

    // stock disponible del producto seleccionado
    function getStockDisponible() {
        const opt = selectProducto?.selectedOptions[0];
        return opt && opt.value ? Number(opt.dataset.stock || 0) : 0;
    }

    function actualizarMaxCantidad() {
        const stock = getStockDisponible();
        if (inputCantidad) {
            inputCantidad.max = stock || '';
            if (stock && Number(inputCantidad.value) > stock) {
                inputCantidad.value = stock;
            }
        }
    }

    function getPrecioUnitario() {
        const opt = selectProducto?.selectedOptions[0];
        return opt ? Number(opt.dataset.precio || 0) : 0;
    }

    function calcularPrecios() {
        const precio   = getPrecioUnitario();
        const cantidad = Number(inputCantidad?.value || 1);
        const flete    = Number(inputFlete?.value || 0);
        const subtotal = precio * cantidad;
        const total    = subtotal + flete;

        if (subtotalEl) subtotalEl.value = '$' + subtotal.toLocaleString('es-AR');
        if (precioHidden) precioHidden.value = subtotal;

        if (!checkEditar.checked) {
            if (totalDisplay) totalDisplay.value = '$' + total.toLocaleString('es-AR');
            if (totalInput)   totalInput.value = total;
        }
    }

    selectProducto?.addEventListener('change', () => {
        actualizarMaxCantidad();
        if (inputCantidad) inputCantidad.value = 1;
        calcularPrecios();
    });
    inputCantidad?.addEventListener('input', () => {
        const stock = getStockDisponible();
        if (stock && Number(inputCantidad.value) > stock) {
            inputCantidad.value = stock;
        }
        calcularPrecios();
    });
    inputFlete?.addEventListener('input', calcularPrecios);

    // toggle para editar el total manualmente
    checkEditar.addEventListener('change', () => {
        totalInput.style.display = checkEditar.checked ? 'block' : 'none';
        totalDisplay.style.display = checkEditar.checked ? 'none' : 'block';
        if (!checkEditar.checked) calcularPrecios();
    });

    // tipo de operacion: finalizar ahora o programar
    opFinalizar?.addEventListener('change', () => { hiddenFinalizar.value = 'true'; });
    opProgramar?.addEventListener('change', () => { hiddenFinalizar.value = 'false'; });

    // mapa (Leaflet / OSM via MapService)
    const mapaContainerId = 'mapaViajeLeaflet';
    if (btnBuscar) {
        btnBuscar.addEventListener('click', async () => {
            const calle  = document.getElementById('calleViaje')?.value.trim();
            const numero = document.getElementById('numeroViaje')?.value.trim();
            if (!calle) {
                if (msgMapa) { msgMapa.style.display = 'block'; msgMapa.textContent = 'Ingresá al menos la calle.'; }
                return;
            }
            if (mapaDiv) mapaDiv.style.display = 'block';
            if (msgMapa) msgMapa.style.display = 'none';
            if (typeof MapService !== 'undefined') {
                if (!MapService.maps[mapaContainerId]) MapService.init(mapaContainerId);
                await MapService.buscarYMostrar(mapaContainerId, calle, numero);
            }
        });
    }

    // validacion al enviar
    document.getElementById('formViaje')?.addEventListener('submit', (e) => {
        const campos = ['#productoViaje', '#cantidadViaje', '#fechaViaje', '#calleViaje'];

        const clienteId = document.getElementById('inputClienteId')?.value;
        if (!clienteId) {
            alert('Busca y selecciona un cliente antes de confirmar.');
            e.preventDefault();
            return;
        }

        const tel = document.getElementById('telefonoViaje')?.value.trim();
        if (!tel) {
            alert('El telefono de contacto es obligatorio.');
            e.preventDefault();
            return;
        }

        if (!validarFormulario(e.target, campos)) {
            e.preventDefault();
            return;
        }

        // valido stock disponible
        const stock = getStockDisponible();
        const cant = Number(inputCantidad?.value || 0);
        if (stock && cant > stock) {
            alert(`Stock insuficiente. Disponible: ${stock} unidades.`);
            e.preventDefault();
            return;
        }

        if (!checkEditar.checked) calcularPrecios();
    });

    calcularPrecios();
});
