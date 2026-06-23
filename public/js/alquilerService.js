// ── Helpers ───────────────────────────────────────────────────
function toInputDate(date) {
    return date.toISOString().split('T')[0];
}

// tarifa: 9+ dias = precioAlquiler, menos = dias * precioDia (del config)
const preciosCfgEl = document.getElementById('precios-config');
const preciosCfg = preciosCfgEl ? JSON.parse(preciosCfgEl.textContent) : { precioDia: 30000, precioAlquiler: 250000 };

function calcularPrecioAlquiler(dias) {
    if (!dias || dias <= 0) return 0;
    if (dias >= 9) return preciosCfg.precioAlquiler;
    return dias * preciosCfg.precioDia;
}

function formatFechaLocal(val) {
    if (!val) return '—';
    const [y, m, d] = val.split('-');
    return `${d}/${m}/${y}`;
}

// ── Mapa (Leaflet / OSM via MapService) ───────────────────────
const btnBuscar = document.getElementById('btnBuscarDireccion');
const mapaDiv   = document.getElementById('mapaEntrega');
const msgMapa   = document.getElementById('msgMapa');
const mapaContainerId = 'mapaContenedor';

async function cargarMapa(calle, numero) {
    if (mapaDiv) mapaDiv.style.display = 'block';
    if (msgMapa) msgMapa.style.display = 'none';
    if (typeof MapService !== 'undefined') {
        if (!MapService.maps[mapaContainerId]) MapService.init(mapaContainerId);
        await MapService.buscarYMostrar(mapaContainerId, calle, numero);
    }
}

if (btnBuscar) {
    btnBuscar.addEventListener('click', () => {
        const calle  = document.getElementById('calle')?.value.trim();
        const numero = document.getElementById('numero')?.value.trim();
        if (!calle || !numero) {
            if (msgMapa) { msgMapa.textContent = 'Ingresá calle y número para buscar.'; msgMapa.style.display = 'block'; }
            return;
        }
        cargarMapa(calle, numero);
    });
}

// ── Fechas: mínimo 4 días, máximo 9 ───────────────────────────
const fechaInicio = document.getElementById('fechaInicio');
const fechaFin    = document.getElementById('fechaFin');

if (fechaInicio && fechaFin) {
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    fechaInicio.min = toInputDate(hoy);

    fechaInicio.addEventListener('change', () => {
        if (!fechaInicio.value) return;
        const inicio = new Date(fechaInicio.value + 'T00:00:00');
        const minFin = new Date(inicio); minFin.setDate(minFin.getDate() + 4);
        const maxFin = new Date(inicio); maxFin.setDate(maxFin.getDate() + 9);
        fechaFin.min   = toInputDate(minFin);
        fechaFin.max   = toInputDate(maxFin);
        fechaFin.value = '';
        actualizarResumen();
    });
}

// ── Precio editable (toggle) ──────────────────────────────────
const checkEditarPrecio = document.getElementById('checkEditarPrecio');
const precioDisplay     = document.getElementById('precioAlquilerDisplay');
const precioInput       = document.getElementById('precioAlquilerInput');

if (checkEditarPrecio) {
    checkEditarPrecio.addEventListener('change', () => {
        if (precioInput)   precioInput.style.display   = checkEditarPrecio.checked ? 'block' : 'none';
        if (precioDisplay) precioDisplay.style.display = checkEditarPrecio.checked ? 'none' : '';
        if (!checkEditarPrecio.checked) actualizarResumen();
    });
}

// ── Estado de la selección ────────────────────────────────────
let contenedorSeleccionado = null; // { id, numero, fin, alquilerActualId }

// ── Resumen en tiempo real ────────────────────────────────────
function actualizarResumen() {
    const metodoPagoEl = document.getElementById('metodoPago');

    // cliente
    const clienteNombre = document.getElementById('inputClienteNombre')?.value || '—';
    const elCliente = document.getElementById('res-cliente');
    if (elCliente) elCliente.textContent = clienteNombre;

    // contenedor (muestra el N° real, no el UUID)
    const elCont = document.getElementById('res-contenedor');
    if (elCont) elCont.textContent = contenedorSeleccionado ? `#${contenedorSeleccionado.numero}` : '—';

    // fechas y días
    const inicioVal = fechaInicio?.value;
    const finVal    = fechaFin?.value;
    const elInicio  = document.getElementById('res-inicio');
    const elFin     = document.getElementById('res-fin');
    const elDias    = document.getElementById('res-dias');
    const elTotal   = document.getElementById('res-total');
    const elTotalV  = document.getElementById('res-total-valor');

    if (elInicio) elInicio.textContent = formatFechaLocal(inicioVal);
    if (elFin)    elFin.textContent    = formatFechaLocal(finVal);

    if (inicioVal && finVal) {
        const dias = Math.round((new Date(finVal) - new Date(inicioVal)) / 86400000);
        if (elDias) elDias.textContent = dias > 0 ? `${dias} días` : '—';
        const precio = calcularPrecioAlquiler(dias);
        const perDia = dias > 0 ? Math.round(precio / dias) : 0;

        if (elTotalV) elTotalV.textContent = dias > 0 ? `$${precio.toLocaleString('es-AR')}` : '—';
        if (elTotal)  elTotal.style.display = dias > 0 ? 'flex' : 'none';

        if (precioDisplay && !checkEditarPrecio?.checked) {
            precioDisplay.textContent = dias > 0
                ? `$${perDia.toLocaleString('es-AR')} x ${dias} día${dias === 1 ? '' : 's'} = $${precio.toLocaleString('es-AR')}`
                : '$' + precio.toLocaleString('es-AR');
        }
        if (precioInput && !checkEditarPrecio?.checked) precioInput.value = precio;
    } else {
        if (elDias)  elDias.textContent    = '—';
        if (elTotal) elTotal.style.display = 'none';
    }

    // dirección
    const calle  = document.getElementById('calle')?.value.trim();
    const numero = document.getElementById('numero')?.value.trim();
    const elDir  = document.getElementById('res-direccion');
    if (elDir) elDir.textContent = calle && numero ? `${calle} ${numero}` : calle || '—';

    // método de pago
    const pagoMap = { efectivo: 'Efectivo', transferencia: 'Transferencia', cuenta_corriente: 'Cuenta corriente' };
    const elPago  = document.getElementById('res-pago');
    if (elPago) elPago.textContent = pagoMap[metodoPagoEl?.value] || '—';
}

['fechaInicio', 'fechaFin', 'calle', 'numero', 'metodoPago'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', actualizarResumen);
    document.getElementById(id)?.addEventListener('input',  actualizarResumen);
});
document.addEventListener('clienteSeleccionado',   actualizarResumen);
document.addEventListener('clienteDeseleccionado', actualizarResumen);

// ── Modal ─────────────────────────────────────────────────────
const modalAlquiler = document.getElementById('modal-alquiler');
function abrirModalAlquiler() {
    if (modalAlquiler) modalAlquiler.style.display = 'flex';
    document.body.style.overflow = 'hidden';
}
function cerrarModalAlquiler() {
    if (modalAlquiler) modalAlquiler.style.display = 'none';
    document.body.style.overflow = '';
}
document.getElementById('cerrarModalAlquiler')?.addEventListener('click', cerrarModalAlquiler);
document.getElementById('cancelarModalAlquiler')?.addEventListener('click', cerrarModalAlquiler);
modalAlquiler?.addEventListener('click', (e) => { if (e.target === modalAlquiler) cerrarModalAlquiler(); });

// ── Selección de contenedor → abre el modal ───────────────────
document.querySelectorAll('.btn-seleccionar-cont').forEach(btn => {
    btn.addEventListener('click', () => {
        const card = btn.closest('.alquiler-card');
        if (!card) return;

        document.querySelectorAll('.alquiler-card').forEach(c => c.classList.remove('alquiler-card--selected'));
        card.classList.add('alquiler-card--selected');

        contenedorSeleccionado = {
            id:               card.dataset.id,
            numero:           card.dataset.numero,
            fin:              card.dataset.fin || null,
            alquilerActualId: card.dataset.alquilerActual || '',
        };

        // cargo los hidden del form
        const inputId  = document.getElementById('inputContenedorId');
        const inputAct = document.getElementById('inputAlquilerActualId');
        if (inputId)  inputId.value  = contenedorSeleccionado.id;
        if (inputAct) inputAct.value = contenedorSeleccionado.alquilerActualId;

        // etiqueta del modal
        const labelModal = document.getElementById('modal-cont-label');
        if (labelModal) labelModal.textContent = `Contenedor #${contenedorSeleccionado.numero}`;

        // si es "por finalizar", el alquiler nuevo arranca después de la liberación
        if (contenedorSeleccionado.fin && fechaInicio) {
            fechaInicio.min   = contenedorSeleccionado.fin;
            fechaInicio.value = '';
            if (fechaFin) fechaFin.value = '';
        }

        abrirModalAlquiler();
        actualizarResumen();
    });
});

// ── Toggle disponibles / próximos a finalizar ─────────────────
const checkPorFinalizar = document.getElementById('contenedorPorFinalizar');
const listaDisponibles  = document.getElementById('listaDisponibles');
const listaPorFinalizar = document.getElementById('listaPorFinalizar');

if (checkPorFinalizar) {
    checkPorFinalizar.addEventListener('change', () => {
        const usar = checkPorFinalizar.checked;
        if (listaDisponibles)  listaDisponibles.style.display  = usar ? 'none' : '';
        if (listaPorFinalizar) listaPorFinalizar.style.display = usar ? '' : 'none';
        document.querySelectorAll('.alquiler-card').forEach(c => c.classList.remove('alquiler-card--selected'));
        contenedorSeleccionado = null;
    });
}

// ── Prevenir submit con Enter (solo confirmar con el botón) ────
const formAlquiler = document.getElementById('formNuevoAlquiler');
if (formAlquiler) {
    formAlquiler.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.type !== 'submit') {
            e.preventDefault();
        }
    });
}

// ── Validación al enviar ──────────────────────────────────────
formAlquiler?.addEventListener('submit', (e) => {
    // Solo aceptar submits originados por el botón "Confirmar"
    if (!e.submitter || !e.submitter.classList.contains('btn-finalizar')) {
        e.preventDefault();
        return;
    }
    if (!contenedorSeleccionado) { e.preventDefault(); alert('Seleccioná un contenedor.'); return; }
    const clienteId = document.getElementById('inputClienteId')?.value;
    if (!clienteId) { e.preventDefault(); alert('Buscá y seleccioná un cliente antes de confirmar.'); return; }

    // Validar campos obligatorios manualmente
    const campos = [
        { id: 'fechaInicio', nombre: 'Fecha de inicio' },
        { id: 'fechaFin',    nombre: 'Fecha de fin' },
        { id: 'calle',       nombre: 'Calle' },
        { id: 'numero',      nombre: 'Número' },
    ];
    const faltantes = campos.filter(c => !document.getElementById(c.id)?.value.trim());
    if (faltantes.length) {
        e.preventDefault();
        alert('Completá los campos obligatorios: ' + faltantes.map(c => c.nombre).join(', '));
        const primero = document.getElementById(faltantes[0].id);
        if (primero) primero.focus();
        return;
    }
    if (typeof validarFormulario === 'function' &&
        !validarFormulario(e.target, ['#fechaInicio', '#fechaFin', '#calle', '#numero'])) {
        e.preventDefault();
    }
});

actualizarResumen();
