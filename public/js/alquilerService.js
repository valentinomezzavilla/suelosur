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

// ── Fechas ────────────────────────────────────────────────────
// La fecha de fin la determina si el cliente tiene cuenta corriente habilitada:
// esos clientes tienen un plazo más largo. En carga histórica no rige la regla ni
// ningún tope, porque el alquiler ya pasó y duró lo que haya durado.
const fechaInicio = document.getElementById('fechaInicio');
const fechaFin    = document.getElementById('fechaFin');

const plazosCfgEl = document.getElementById('plazos-config');
const plazosCfg = plazosCfgEl ? JSON.parse(plazosCfgEl.textContent) : { cuenta_corriente: 15, estandar: 4 };
const plazoActual = document.getElementById('plazoActual');

function modoFinalizado()  { return !!document.getElementById('checkFinalizado')?.checked; }
// Histórico que todavía sigue en curso: ocupa el contenedor y no lleva fecha de fin.
function historicoEnCurso() {
    return modoFinalizado() && document.getElementById('estadoHistorico')?.value === 'en_curso';
}
function sinFechaFin()     { return !!document.getElementById('checkSinFechaFin')?.checked; }
// Con el check tildado el usuario fija la fecha de fin a mano y la regla no la pisa.
function fechaFinManual()  { return !!document.getElementById('checkEditarFechaFin')?.checked; }

function clienteTieneCuentaCorriente() {
    return !!(typeof getClienteSeleccionado === 'function' && getClienteSeleccionado()?.cuentaCorriente);
}

// Inicio anterior a hoy = el alquiler ya venía en curso (se carga con el contenedor
// ya en el domicilio del cliente).
function inicioEsPasado() {
    if (!fechaInicio?.value) return false;
    return fechaInicio.value < toInputDate(new Date());
}

// Dejar el alquiler sin fecha de fin se permite a los clientes con cuenta corriente
// y a cualquier alquiler que ya venía en curso.
function permiteSinFechaFin() {
    return modoFinalizado() || clienteTieneCuentaCorriente() || inicioEsPasado();
}

function plazoDelCliente() {
    return clienteTieneCuentaCorriente() ? plazosCfg.cuenta_corriente : plazosCfg.estandar;
}

// Recalcula la fecha de fin a partir del inicio y del plazo que le toca al cliente.
function aplicarFechaFinAutomatica() {
    if (!fechaInicio || !fechaFin) return;
    if (modoFinalizado() || fechaFinManual()) { fechaFin.readOnly = false; return; }
    fechaFin.readOnly = true;
    fechaFin.min = ''; fechaFin.max = '';
    if (!fechaInicio.value) { fechaFin.value = ''; return; }
    const fin = new Date(fechaInicio.value + 'T00:00:00');
    fin.setDate(fin.getDate() + plazoDelCliente());
    fechaFin.value = toInputDate(fin);
    if (plazoActual) {
        plazoActual.textContent = clienteTieneCuentaCorriente()
            ? `Cliente con cuenta corriente: ${plazosCfg.cuenta_corriente} días.`
            : `Cliente sin cuenta corriente: ${plazosCfg.estandar} días.`;
    }
}

if (fechaInicio && fechaFin) {
    // La fecha de inicio es libre: puede ser pasada (alquiler ya en curso) o futura.
    fechaInicio.addEventListener('change', () => {
        sincronizarOpcionesDeFin();
        aplicarFechaFinAutomatica();
        actualizarResumen();
    });
}

// Muestra u oculta el check de "sin fecha de fin" según a quién le corresponde,
// y avisa cuando el alquiler se va a cargar como ya en curso.
function sincronizarOpcionesDeFin() {
    const permite = permiteSinFechaFin();
    if (rowSinFechaFin) rowSinFechaFin.style.display = permite ? '' : 'none';
    if (!permite && checkSinFechaFin?.checked) {
        checkSinFechaFin.checked = false;
        aplicarSinFechaFin(false);
    }
    if (avisoEnCurso) {
        avisoEnCurso.style.display = (inicioEsPasado() && !modoFinalizado()) ? '' : 'none';
    }
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

    // contenedor (muestra el N° real, no el UUID). En el histórico en curso se elige
    // desde un select propio, no desde las tarjetas.
    const elCont = document.getElementById('res-contenedor');
    if (elCont) {
        const selHist = document.getElementById('contHistorico');
        const textoHist = historicoEnCurso() && selHist?.value
            ? selHist.options[selHist.selectedIndex]?.text : '';
        elCont.textContent = textoHist || (contenedorSeleccionado ? `#${contenedorSeleccionado.numero}` : '—');
    }

    // fechas y días
    const inicioVal = fechaInicio?.value;
    const finVal    = fechaFin?.value;
    const elInicio  = document.getElementById('res-inicio');
    const elFin     = document.getElementById('res-fin');
    const elDias    = document.getElementById('res-dias');
    const elTotal   = document.getElementById('res-total');
    const elTotalV  = document.getElementById('res-total-valor');

    if (elInicio) elInicio.textContent = formatFechaLocal(inicioVal);
    if (elFin)    elFin.textContent    = (sinFechaFin() || historicoEnCurso()) ? 'Sin informar' : formatFechaLocal(finVal);

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
    const pagoMap = { efectivo: 'Efectivo', transferencia: 'Transferencia', cheque: 'Cheque', cuenta_corriente: 'Cuenta corriente' };
    const elPago  = document.getElementById('res-pago');
    if (elPago) elPago.textContent = pagoMap[metodoPagoEl?.value] || '—';
}

['fechaInicio', 'fechaFin', 'calle', 'numero', 'metodoPago'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', actualizarResumen);
    document.getElementById(id)?.addEventListener('input',  actualizarResumen);
});
// El plazo depende del cliente, así que al elegirlo hay que recalcular la fecha de fin.
document.addEventListener('clienteSeleccionado',   () => { sincronizarOpcionesDeFin(); aplicarFechaFinAutomatica(); actualizarResumen(); });
document.addEventListener('clienteDeseleccionado', () => { sincronizarOpcionesDeFin(); aplicarFechaFinAutomatica(); actualizarResumen(); });

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
        }
        aplicarFechaFinAutomatica();

        abrirModalAlquiler();
        actualizarResumen();
    });
});

// ── Pestañas disponibles / próximos a finalizar ───────────────
const listaDisponibles  = document.getElementById('listaDisponibles');
const listaPorFinalizar = document.getElementById('listaPorFinalizar');

document.querySelectorAll('.cont-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.cont-tab').forEach(t => t.classList.remove('is-active'));
        tab.classList.add('is-active');
        const verPorFinalizar = tab.getAttribute('data-target') === 'porFinalizar';
        if (listaDisponibles)  listaDisponibles.style.display  = verPorFinalizar ? 'none' : '';
        if (listaPorFinalizar) listaPorFinalizar.style.display = verPorFinalizar ? '' : 'none';
        document.querySelectorAll('.alquiler-card').forEach(c => c.classList.remove('alquiler-card--selected'));
        contenedorSeleccionado = null;
    });
});

// ── Carga histórica: alquiler ya finalizado ───────────────────
const checkFinalizado       = document.getElementById('checkFinalizado');
const finalizadoHint        = document.getElementById('finalizadoHint');
const seccionChoferCamion   = document.getElementById('seccionChoferCamion');
const modalContLabel        = document.getElementById('modal-cont-label');
const checkSinFechaFin      = document.getElementById('checkSinFechaFin');
const rowSinFechaFin        = document.getElementById('rowSinFechaFin');
const grupoFechaFin         = document.getElementById('grupoFechaFin');
const hintPlazo             = document.getElementById('hintPlazo');
const checkEditarFechaFin   = document.getElementById('checkEditarFechaFin');
const rowEditarFechaFin     = document.getElementById('rowEditarFechaFin');
const hintSinFechaFin       = document.getElementById('hintSinFechaFin');
const avisoEnCurso          = document.getElementById('avisoEnCurso');
const bloqueHistorico       = document.getElementById('bloqueHistorico');
const estadoHistorico       = document.getElementById('estadoHistorico');
const grupoContHistorico    = document.getElementById('grupoContHistorico');
const selContHistorico      = document.getElementById('contHistorico');
const enCursoHint           = document.getElementById('enCursoHint');

// Alquiler sin fecha de fin: se oculta el campo (validarFormulario saltea solo
// los campos no visibles) y el fin deja de ser obligatorio.
function aplicarSinFechaFin(activo) {
    if (grupoFechaFin)    grupoFechaFin.style.display = activo ? 'none' : '';
    if (hintSinFechaFin)  hintSinFechaFin.style.display = activo ? '' : 'none';
    if (hintPlazo)        hintPlazo.style.display = (activo || modoFinalizado()) ? 'none' : '';
    if (rowEditarFechaFin) rowEditarFechaFin.style.display = (activo || modoFinalizado()) ? 'none' : '';
    if (fechaFin) {
        fechaFin.required = !activo;
        if (activo) { fechaFin.value = ''; fechaFin.min = ''; fechaFin.max = ''; }
    }
    // Al destildarlo hay que volver a calcular el fin, que había quedado vacío.
    if (!activo) aplicarFechaFinAutomatica();
    actualizarResumen();
}

// Dentro del histórico: "ya finalizó" pide fecha de fin y no toca contenedores;
// "sigue en curso" pide el contenedor y no lleva fecha de fin.
function aplicarEstadoHistorico() {
    const enCurso = historicoEnCurso();
    if (grupoContHistorico) grupoContHistorico.style.display = enCurso ? '' : 'none';
    if (finalizadoHint)     finalizadoHint.style.display = enCurso ? 'none' : '';
    if (enCursoHint)        enCursoHint.style.display = enCurso ? '' : 'none';
    if (grupoFechaFin)      grupoFechaFin.style.display = enCurso ? 'none' : '';
    if (fechaFin && enCurso) { fechaFin.value = ''; fechaFin.required = false; }
    if (rowSinFechaFin)     rowSinFechaFin.style.display = enCurso ? 'none' : (permiteSinFechaFin() ? '' : 'none');
    if (!enCurso && selContHistorico) selContHistorico.value = '';
    sincronizarContenedorHistorico();
    actualizarResumen();
}

// El select del histórico escribe en el mismo hidden que usa la selección por tarjetas.
function sincronizarContenedorHistorico() {
    if (!historicoEnCurso()) return;
    const inputId = document.getElementById('inputContenedorId');
    if (inputId) inputId.value = selContHistorico?.value || '';
}

function aplicarModoFinalizado(activo) {
    if (bloqueHistorico)     bloqueHistorico.style.display = activo ? '' : 'none';
    if (seccionChoferCamion) seccionChoferCamion.style.display = activo ? 'none' : '';
    // En histórico la fecha de fin ya se carga a mano, así que el check de edición
    // y el cartel de la regla no tienen sentido. El de "sin fecha de fin" sirve en ambos.
    if (activo && checkEditarFechaFin) checkEditarFechaFin.checked = false;
    if (!activo && selContHistorico) selContHistorico.value = '';
    sincronizarOpcionesDeFin();
    aplicarFechaFinAutomatica();
    aplicarSinFechaFin(!!checkSinFechaFin?.checked);
    if (activo) aplicarEstadoHistorico();
    if (activo && modalContLabel) modalContLabel.textContent = 'Alquiler histórico';
}

checkFinalizado?.addEventListener('change', () => aplicarModoFinalizado(checkFinalizado.checked));
estadoHistorico?.addEventListener('change', aplicarEstadoHistorico);
selContHistorico?.addEventListener('change', () => { sincronizarContenedorHistorico(); actualizarResumen(); });
checkSinFechaFin?.addEventListener('change', () => aplicarSinFechaFin(checkSinFechaFin.checked));
// Al destildar "editar fecha de fin" vuelve a mandar la regla del cliente.
checkEditarFechaFin?.addEventListener('change', () => { aplicarFechaFinAutomatica(); actualizarResumen(); });

// Abrir el modal SIN contenedor, directo en modo histórico
document.getElementById('btnCargarFinalizado')?.addEventListener('click', () => {
    contenedorSeleccionado = null;
    const inputId  = document.getElementById('inputContenedorId');
    const inputAct = document.getElementById('inputAlquilerActualId');
    if (inputId)  inputId.value  = '';
    if (inputAct) inputAct.value = '';
    document.querySelectorAll('.alquiler-card').forEach(c => c.classList.remove('alquiler-card--selected'));
    if (checkFinalizado) checkFinalizado.checked = true;
    aplicarModoFinalizado(true);
    if (modalContLabel) modalContLabel.textContent = 'Alquiler finalizado (histórico)';
    abrirModalAlquiler();
    actualizarResumen();
});

// Al cerrar/cancelar el modal, salir del modo histórico
['cerrarModalAlquiler', 'cancelarModalAlquiler'].forEach(id => {
    document.getElementById(id)?.addEventListener('click', () => {
        if (checkFinalizado) checkFinalizado.checked = false;
        aplicarModoFinalizado(false);
    });
});

// ── Prevenir submit con Enter (solo confirmar con el botón) ────
const formAlquiler = document.getElementById('formNuevoAlquiler');
if (formAlquiler) {
    formAlquiler.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.type !== 'submit') {
            e.preventDefault();
        }
    });
    // Destino: al menos uno entre dirección (calle) y obra
    formAlquiler.addEventListener('submit', (e) => {
        const calleV = document.getElementById('calle')?.value.trim();
        const obraV  = document.getElementById('obraAlquiler')?.value.trim();
        if (!calleV && !obraV) {
            alert('Cargá la dirección (calle) o la obra. Al menos uno es obligatorio.');
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
    // El histórico ya finalizado no ocupa contenedor; el que sigue en curso sí.
    if (historicoEnCurso()) {
        if (!selContHistorico?.value) {
            e.preventDefault(); alert('Elegí el contenedor que está en el domicilio del cliente.'); return;
        }
    } else if (!modoFinalizado() && !contenedorSeleccionado) {
        e.preventDefault(); alert('Seleccioná un contenedor.'); return;
    }
    const clienteId = document.getElementById('inputClienteId')?.value;
    if (!clienteId) { e.preventDefault(); alert('Buscá y seleccioná un cliente antes de confirmar.'); return; }

    // Validar campos obligatorios manualmente
    const campos = [
        { id: 'fechaInicio', nombre: 'Fecha de inicio' },
        { id: 'calle',       nombre: 'Calle' },
        { id: 'numero',      nombre: 'Número' },
    ];
    if (!sinFechaFin() && !historicoEnCurso()) campos.push({ id: 'fechaFin', nombre: 'Fecha de fin' });
    const faltantes = campos.filter(c => !document.getElementById(c.id)?.value.trim());
    if (faltantes.length) {
        e.preventDefault();
        alert('Completá los campos obligatorios: ' + faltantes.map(c => c.nombre).join(', '));
        const primero = document.getElementById(faltantes[0].id);
        if (primero) primero.focus();
        return;
    }
    const requeridos = ['#fechaInicio', '#calle', '#numero'];
    if (!sinFechaFin() && !historicoEnCurso()) requeridos.push('#fechaFin');
    if (typeof validarFormulario === 'function' && !validarFormulario(e.target, requeridos)) {
        e.preventDefault();
    }
});

actualizarResumen();
