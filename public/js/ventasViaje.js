document.addEventListener('DOMContentLoaded', () => {
    const selectProducto = document.getElementById('productoViaje');
    const inputCantidad  = document.getElementById('cantidadViaje');
    const subtotalEl     = document.getElementById('subtotalProducto');
    const precioHidden   = document.getElementById('precioProductoHidden');
    const checkSubtotal  = document.getElementById('checkEditarSubtotal');
    const subtotalInput  = document.getElementById('subtotalManualInput');
    const inputPrecio    = document.getElementById('precioUnitarioInput');
    const checkPrecio    = document.getElementById('checkEditarPrecio');
    const labelPrecio    = document.getElementById('labelPrecioUnitario');
    const hintPrecio     = document.getElementById('hintPrecioUnitario');
    const HINT_PRECIO    = hintPrecio?.textContent || '';
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

    // La fecha es libre: se pueden cargar viajes ya hechos con su fecha real.
    // Por comodidad arranca en hoy, pero se puede mover hacia atrás o hacia adelante.
    const hoy = new Date().toISOString().split('T')[0];
    if (fechaInput && !fechaInput.value) fechaInput.value = hoy;

    // cuando selecciono un cliente, le cargo el telefono y la zona automaticamente
    document.addEventListener('clienteSeleccionado', (e) => {
        const c = e.detail;
        const telInput = document.getElementById('telefonoViaje');
        if (telInput && c.telefono) telInput.value = c.telefono;
        // Zona del cliente → preseleccionar (si el select la tiene) y autocompletar tarifa
        const zonaSel = document.getElementById('zonaViaje');
        if (zonaSel && c.zona && !zonaSel.value) {
            const opt = Array.from(zonaSel.options).find(o => o.value.toLowerCase() === String(c.zona).toLowerCase());
            if (opt) { zonaSel.value = opt.value; zonaSel.dispatchEvent(new Event('change')); }
        }
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

    // ── Contenedor: cantidad fija en 1, se cargan los días y el precio por día sale
    // del rango en que caen (el servidor recalcula igual al confirmar).
    const grupoCantidad = document.getElementById('grupoCantidadViaje');
    const grupoDias     = document.getElementById('grupoDiasViaje');
    const inputDias     = document.getElementById('diasViaje');
    const hintDias      = document.getElementById('hintDiasViaje');
    const HINT_DIAS     = hintDias?.textContent || '';

    function esContenedor() {
        return selectProducto?.selectedOptions[0]?.dataset.contenedor === '1';
    }
    function rangosSeleccionados() {
        try { return JSON.parse(selectProducto?.selectedOptions[0]?.dataset.rangos || '[]'); } catch (_) { return []; }
    }
    // { precioDia, subtotal } o null si no hay rango para esos días
    function cotizarContenedor() {
        const n = Number(inputDias?.value);
        if (!Number.isInteger(n) || n < 1) return null;
        const r = rangosSeleccionados().find(x => n >= Number(x.dias_desde) && (x.dias_hasta == null || n <= Number(x.dias_hasta)));
        return r ? { precioDia: Number(r.precio_dia), subtotal: n * Number(r.precio_dia) } : null;
    }
    function aplicarModoContenedor() {
        const cont = esContenedor();
        if (grupoCantidad) grupoCantidad.style.display = cont ? 'none' : '';
        if (grupoDias)     grupoDias.style.display     = cont ? '' : 'none';
        if (inputDias)     inputDias.required = cont;
        if (cont && inputCantidad) inputCantidad.value = 1;
    }

    const redondear = (n) => Math.round(n * 100) / 100;

    function calcularPrecios() {
        const cont     = esContenedor();
        const cot      = cont ? cotizarContenedor() : null;
        // Precio unitario de lista: el de catálogo, o para el contenedor el precio por día
        // del rango. Se multiplica por la cantidad (contenedor: por los días).
        const precioLista = cont ? (cot ? cot.precioDia : 0) : getPrecioUnitario();
        const cantidad = cont ? Number(inputDias?.value || 0) : Number(inputCantidad?.value || 1);
        if (cont && hintDias) {
            hintDias.textContent = cot
                ? `${inputDias.value} día(s) × $${cot.precioDia.toLocaleString('es-AR')}/día. Va un solo contenedor por operación.`
                : 'No hay precio para esa cantidad de días.';
        } else if (hintDias) {
            hintDias.textContent = HINT_DIAS;
        }
        if (labelPrecio) labelPrecio.textContent = cont ? 'Precio por día' : 'Precio unitario';

        const flete    = Number(inputFlete?.value || 0);
        const subtotalManual = checkSubtotal?.checked;
        const precioManual   = !subtotalManual && checkPrecio?.checked;
        let precioUnit, subtotal;
        if (subtotalManual) {
            // Subtotal a mano: el precio unitario muestra el resultante
            subtotal   = Number(subtotalInput?.value || 0);
            precioUnit = cantidad > 0 ? redondear(subtotal / cantidad) : 0;
            if (inputPrecio) inputPrecio.value = precioUnit;
        } else {
            // Precio unitario (de lista o editado) × cantidad
            precioUnit = precioManual ? Number(inputPrecio?.value || 0) : precioLista;
            if (!precioManual && inputPrecio) inputPrecio.value = precioLista;
            subtotal   = redondear(precioUnit * cantidad);
        }
        const total    = subtotal + flete;

        if (hintPrecio) {
            hintPrecio.textContent = subtotalManual
                ? `Resulta del subtotal editado ÷ ${cantidad || 0}.`
                : (precioManual && precioUnit !== precioLista
                    ? `Editado (lista: $${precioLista.toLocaleString('es-AR')}). Subtotal = $${precioUnit.toLocaleString('es-AR')} × ${cantidad}.`
                    : HINT_PRECIO);
        }

        if (!subtotalManual) {
            if (subtotalEl)    subtotalEl.value = '$' + subtotal.toLocaleString('es-AR');
            if (subtotalInput) subtotalInput.value = subtotal;
        }
        if (precioHidden) precioHidden.value = subtotal;

        if (!checkEditar.checked) {
            if (totalDisplay) totalDisplay.value = '$' + total.toLocaleString('es-AR');
            if (totalInput)   totalInput.value = total;
        }
    }

    selectProducto?.addEventListener('change', () => {
        actualizarMaxCantidad();
        if (inputCantidad) inputCantidad.value = 1;
        aplicarModoContenedor();
        // Otro producto: vuelve a su precio de lista (no arrastra lo editado del anterior)
        setEditarPrecio(false);
        calcularPrecios();
    });
    inputDias?.addEventListener('input', calcularPrecios);
    inputCantidad?.addEventListener('input', () => {
        const stock = getStockDisponible();
        if (stock && Number(inputCantidad.value) > stock) {
            inputCantidad.value = stock;
        }
        calcularPrecios();
    });
    inputFlete?.addEventListener('input', calcularPrecios);
    subtotalInput?.addEventListener('input', calcularPrecios);

    // Precio unitario y subtotal se editan de a uno: el otro se calcula solo
    function setEditarPrecio(on) {
        if (!inputPrecio || !checkPrecio) return;
        checkPrecio.checked = on;
        inputPrecio.readOnly = !on;
        inputPrecio.classList.toggle('input-readonly', !on);
    }
    function setEditarSubtotal(on) {
        if (!checkSubtotal) return;
        checkSubtotal.checked = on;
        subtotalInput.style.display = on ? 'block' : 'none';
        subtotalEl.style.display    = on ? 'none' : 'block';
    }

    // toggle para editar el precio unitario: el subtotal = precio × cantidad
    inputPrecio?.addEventListener('input', calcularPrecios);
    checkPrecio?.addEventListener('change', () => {
        const on = checkPrecio.checked;
        if (on) setEditarSubtotal(false);
        setEditarPrecio(on);
        if (on) { inputPrecio.focus(); inputPrecio.select(); }
        calcularPrecios();
    });

    // toggle para editar el subtotal del producto manualmente
    checkSubtotal?.addEventListener('change', () => {
        const on = checkSubtotal.checked;
        if (on) setEditarPrecio(false);
        setEditarSubtotal(on);
        if (on) subtotalInput.focus();
        calcularPrecios();
    });

    // Zona → autocompleta el precio del flete con la tarifa de la zona
    const selectZona = document.getElementById('zonaViaje');
    selectZona?.addEventListener('change', () => {
        const opt = selectZona.options[selectZona.selectedIndex];
        const tarifa = Number(opt?.dataset.tarifa || 0);
        if (tarifa > 0 && inputFlete) { inputFlete.value = tarifa; calcularPrecios(); }
    });

    // toggle para editar el total manualmente
    checkEditar.addEventListener('change', () => {
        totalInput.style.display = checkEditar.checked ? 'block' : 'none';
        totalDisplay.style.display = checkEditar.checked ? 'none' : 'block';
        if (!checkEditar.checked) calcularPrecios();
    });

    // tipo de operacion: finalizar ahora o programar
    opFinalizar?.addEventListener('change', () => { hiddenFinalizar.value = 'true'; });
    opProgramar?.addEventListener('change', () => { hiddenFinalizar.value = 'false'; });

    // ── Auto-completar chofer ↔ camión según asignación ────────
    const selectChofer = document.getElementById('selectChofer');
    const selectCamion = document.getElementById('selectCamion');
    const msgAsignacion = document.getElementById('msgAsignacion');
    let autoFillInProgress = false;

    function mostrarMsgAsig(texto) {
        if (!msgAsignacion) return;
        msgAsignacion.textContent = texto;
        msgAsignacion.style.display = texto ? 'block' : 'none';
        if (texto) setTimeout(() => { msgAsignacion.style.display = 'none'; }, 5000);
    }

    selectCamion?.addEventListener('change', async () => {
        if (autoFillInProgress) return;
        const idCamion = selectCamion.value;
        if (!idCamion) return;
        try {
            const resp = await fetch(`/ventas/api/chofer-de-camion/${encodeURIComponent(idCamion)}`);
            const data = await resp.json();
            if (data && data.id && selectChofer) {
                // Solo auto-completar si la opción existe (ids vienen como número desde la API)
                const opt = Array.from(selectChofer.options).find(o => String(o.value) === String(data.id));
                if (opt) {
                    autoFillInProgress = true;
                    selectChofer.value = String(data.id);
                    autoFillInProgress = false;
                    mostrarMsgAsig(`✓ Chofer ${data.nombre} (asignado a este camión)`);
                }
            }
        } catch (err) { console.error(err); }
    });

    selectChofer?.addEventListener('change', async () => {
        if (autoFillInProgress) return;
        const idChofer = selectChofer.value;
        if (!idChofer) return;
        try {
            const resp = await fetch(`/ventas/api/camion-de-chofer/${encodeURIComponent(idChofer)}`);
            const data = await resp.json();
            if (data && data.id && selectCamion) {
                const opt = Array.from(selectCamion.options).find(o => String(o.value) === String(data.id));
                if (opt) {
                    autoFillInProgress = true;
                    selectCamion.value = String(data.id);
                    autoFillInProgress = false;
                    const label = [data.numero_interno ? '#' + data.numero_interno : null, data.patente, data.nombre].filter(Boolean).join(' · ');
                    mostrarMsgAsig(`✓ Camión ${label} (asignado a este chofer)`);
                }
            }
        } catch (err) { console.error(err); }
    });

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

    // prevenir submit con Enter (solo confirmar con el botón)
    const formViaje = document.getElementById('formViaje');
    if (formViaje) {
        formViaje.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.type !== 'submit') {
                e.preventDefault();
            }
        });
    }

    // validacion al enviar
    formViaje?.addEventListener('submit', (e) => {
        // solo aceptar submits originados por un botón
        if (!e.submitter || e.submitter.type !== 'submit') {
            e.preventDefault();
            return;
        }
        const campos = ['#productoViaje', '#cantidadViaje', '#fechaViaje'];

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

        const remitoV = document.getElementById('remitoViaje');
        if (remitoV && remitoV.dataset.invalido === '1') {
            alert(remitoV.dataset.mensaje || 'Revisá el número de remito.');
            remitoV.focus();
            e.preventDefault();
            return;
        }

        // Destino: al menos uno entre dirección (calle) y obra
        const calleV = document.getElementById('calleViaje')?.value.trim();
        const obraV  = document.getElementById('obraViaje')?.value.trim();
        if (!calleV && !obraV) {
            alert('Cargá la dirección (calle) o la obra. Al menos uno es obligatorio.');
            e.preventDefault();
            return;
        }

        if (!validarFormulario(e.target, campos)) {
            e.preventDefault();
            return;
        }

        // Contenedor: tiene que haber precio para los días cargados (no mueve stock)
        if (esContenedor()) {
            if (!cotizarContenedor()) {
                alert('Revisá los días del contenedor: no hay precio para esa cantidad de días.');
                e.preventDefault();
                return;
            }
            if (!checkEditar.checked) calcularPrecios();
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

    aplicarModoContenedor();
    calcularPrecios();
});
