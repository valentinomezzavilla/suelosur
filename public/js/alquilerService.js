// ── Helpers ───────────────────────────────────────────────────
// Fecha local 'YYYY-MM-DD' (toISOString da la fecha UTC: de noche ya es "mañana").
function toInputDate(date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

function formatFechaLocal(val) {
    if (!val) return '—';
    const [y, m, d] = val.split('-');
    return `${d}/${m}/${y}`;
}

// Suma N días hábiles (lun-sáb) a una fecha. El día de inicio CUENTA como día 1 del
// plazo (un alquiler de 4 días que arranca jueves cubre jueves-viernes-sábado-lunes),
// así que para llegar al día N hay que avanzar N-1 días hábiles desde el inicio. Espejo
// de sumar_dias_habiles (SQL) y de src/utils/diasHabiles.js (Node) — mismo resultado en
// el navegador, el servidor y la base.
function sumarDiasHabilesJS(fecha, dias) {
    const d = new Date(fecha.getTime());
    let restantes = dias - 1;
    while (restantes > 0) {
        d.setDate(d.getDate() + 1);
        const dow = d.getDay(); // 0 = domingo
        if (dow !== 0) restantes--;
    }
    return d;
}

// Inverso de sumarDiasHabilesJS: el plazo (en días, contando el de inicio como día 1)
// que hay entre dos fechas. Espejo de diasHabilesEntre (src/utils/diasHabiles.js) — el
// plazo se guarda y cobra en días hábiles, así que el resumen tiene que mostrar esto y
// no la diferencia en días corridos (que da de más cuando el período cruza un fin de
// semana: p. ej. 10 días hábiles caen más de 10 días corridos después si arrancan un lunes).
function diasHabilesEntreJS(inicio, fin) {
    if (fin < inicio) return Math.round((fin - inicio) / 86400000);
    let dias = 0;
    const d = new Date(inicio.getTime());
    while (d < fin) {
        d.setDate(d.getDate() + 1);
        const dow = d.getDay();
        if (dow !== 0) dias++;
    }
    return dias + 1;
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

// Recalcula la fecha de fin a partir del inicio y del plazo que le toca al cliente
// (en días hábiles). Con cuenta corriente el plazo lo elige el botón que se haya
// tocado (rowPlazoCC); por defecto arranca en el de cuenta corriente (el más largo).
let plazoElegidoCC = null;
function plazoDelCliente() {
    if (clienteTieneCuentaCorriente()) return plazoElegidoCC || plazosCfg.cuenta_corriente;
    return plazosCfg.estandar;
}

function aplicarFechaFinAutomatica() {
    if (!fechaInicio || !fechaFin) return;
    if (modoFinalizado() || fechaFinManual()) {
        fechaFin.readOnly = false;
        // Sin cuenta corriente el plazo es siempre el estándar: aunque se tilde "editar a
        // mano", no se puede elegir una fecha más lejana (el servidor igual lo recorta,
        // pero acá directamente no se puede seleccionar).
        if (!modoFinalizado() && !clienteTieneCuentaCorriente() && fechaInicio.value) {
            fechaFin.max = toInputDate(sumarDiasHabilesJS(new Date(fechaInicio.value + 'T00:00:00'), plazosCfg.estandar));
        } else {
            fechaFin.max = '';
        }
        return;
    }
    fechaFin.readOnly = true;
    fechaFin.min = ''; fechaFin.max = '';
    if (!fechaInicio.value) { fechaFin.value = ''; return; }
    const fin = sumarDiasHabilesJS(new Date(fechaInicio.value + 'T00:00:00'), plazoDelCliente());
    fechaFin.value = toInputDate(fin);
    if (plazoActual) {
        plazoActual.textContent = clienteTieneCuentaCorriente()
            ? `Cliente con cuenta corriente: ${plazoDelCliente()} días hábiles.`
            : `Cliente sin cuenta corriente: ${plazosCfg.estandar} días hábiles.`;
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
    // Cuenta corriente: se puede elegir entre el plazo estándar (4) o el largo (10)
    const rowPlazoCC = document.getElementById('rowPlazoCC');
    const muestraCC = clienteTieneCuentaCorriente() && !modoFinalizado();
    if (rowPlazoCC) rowPlazoCC.style.display = muestraCC ? '' : 'none';
    if (!muestraCC) plazoElegidoCC = null;
}

// Botones de plazo (cuenta corriente): eligen 4 o 10 días hábiles con un clic. Fuerzan
// el modo "editar fecha de fin manualmente" para que el servidor calcule el plazo a
// partir de la fecha que se ve acá (si no, ignoraría el botón y usaría el default).
function elegirPlazoCC(dias) {
    if (!fechaInicio?.value) return;
    plazoElegidoCC = dias;
    if (checkEditarFechaFin) checkEditarFechaFin.checked = true;
    if (fechaFin) {
        fechaFin.readOnly = false;
        fechaFin.value = toInputDate(sumarDiasHabilesJS(new Date(fechaInicio.value + 'T00:00:00'), dias));
    }
    if (plazoActual) plazoActual.textContent = `Elegido: ${dias} días hábiles.`;
    actualizarResumen();
}
document.getElementById('btnPlazo4')?.addEventListener('click', () => elegirPlazoCC(plazosCfg.estandar));
document.getElementById('btnPlazo10')?.addEventListener('click', () => elegirPlazoCC(plazosCfg.cuenta_corriente));

// ── Precio y método de pago ───────────────────────────────────
// Los alquileres nuevos se cargan SIN precio ni método de pago: se asignan después en
// Cobranzas → Asignar precio. Solo la carga histórica de un alquiler que YA terminó los pide
// (se registra su ingreso con la fecha pasada). El resto del tiempo el bloque está oculto y
// sus campos deshabilitados, así no se mandan ni se validan.
const precioInput = document.getElementById('precioAlquilerInput');
const bloqueCobroHistorico = document.getElementById('bloqueCobroHistorico');
const avisoSinPrecio = document.getElementById('avisoSinPrecio');

function pideCobro() { return modoFinalizado() && !historicoEnCurso(); }

function aplicarBloqueCobroHistorico() {
    const visible = pideCobro();
    if (bloqueCobroHistorico) {
        bloqueCobroHistorico.style.display = visible ? '' : 'none';
        bloqueCobroHistorico.querySelectorAll('input, select').forEach(el => { el.disabled = !visible; });
    }
    if (avisoSinPrecio) avisoSinPrecio.style.display = visible ? 'none' : '';
}

// ── Estado de la selección ────────────────────────────────────
let contenedorSeleccionado = null; // { id, numero, fin, alquilerActualId }
// Alquiler con varios contenedores: los elegidos en "Disponibles", en orden de selección.
let seleccionMultiple = []; // [{ id, numero }]
function esMultiple() { return seleccionMultiple.length >= 2; }

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
        elCont.textContent = textoHist
            || (esMultiple() ? seleccionMultiple.map(c => `#${c.numero}`).join(', ')
                : (contenedorSeleccionado ? `#${contenedorSeleccionado.numero}` : '—'));
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
        // Días hábiles (lo que se guarda y se cobra), no la diferencia en días corridos:
        // si el período cruza un fin de semana, los corridos dan de más (ver diasHabilesEntreJS).
        const dias = diasHabilesEntreJS(new Date(inicioVal + 'T00:00:00'), new Date(finVal + 'T00:00:00'));
        if (elDias) elDias.textContent = dias > 0 ? `${dias} días` : '—';
    } else {
        if (elDias) elDias.textContent = '—';
    }

    // Precio: solo lo pide la carga histórica ya finalizada; los demás alquileres se cargan sin precio.
    const precio = pideCobro() ? (Number(precioInput?.value) || 0) : 0;
    if (elTotalV) elTotalV.textContent = precio > 0 ? `$${precio.toLocaleString('es-AR')}` : '—';
    if (elTotal)  elTotal.style.display = precio > 0 ? 'flex' : 'none';

    // dirección
    const calle  = document.getElementById('calle')?.value.trim();
    const numero = document.getElementById('numero')?.value.trim();
    const elDir  = document.getElementById('res-direccion');
    if (elDir) elDir.textContent = calle && numero ? `${calle} ${numero}` : calle || '—';

    // método de pago
    const pagoMap = { efectivo: 'Efectivo', transferencia: 'Transferencia', cheque: 'Cheque', cuenta_corriente: 'Cuenta corriente', saldo_a_favor: 'Saldo a favor' };
    const elPago  = document.getElementById('res-pago');
    if (elPago) elPago.textContent = pideCobro() ? (pagoMap[metodoPagoEl?.value] || '—') : 'A definir (Cobranzas → Asignar precio)';
}

['fechaInicio', 'fechaFin', 'calle', 'numero', 'metodoPago', 'precioAlquilerInput'].forEach(id => {
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

// ── Selección de contenedores ─────────────────────────────────
// En "Disponibles" se pueden elegir varios contenedores para un mismo alquiler (se sigue
// con "Continuar"). En "Próximos a finalizar" es de a uno y abre el modal directo: el
// próximo alquiler encadenado es de a un contenedor.
const barraSeleccion = document.getElementById('barraSeleccion');
const seleccionTexto = document.getElementById('seleccionTexto');
const bloqueVarios   = document.getElementById('bloqueVariosContenedores');
const listaVarios    = document.getElementById('listaVariosContenedores');
const inputsConts    = document.getElementById('inputsContenedores');
const rowCheckFinal  = document.getElementById('rowCheckFinalizado');

function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function actualizarBarraSeleccion() {
    const n = seleccionMultiple.length;
    if (barraSeleccion) barraSeleccion.style.display = n ? 'flex' : 'none';
    if (seleccionTexto) {
        const nums = seleccionMultiple.map(c => `#${c.numero}`).join(', ');
        seleccionTexto.textContent = n === 1 ? `1 contenedor elegido (${nums})` : `${n} contenedores elegidos (${nums})`;
    }
    document.querySelectorAll('#listaDisponibles .alquiler-card').forEach(card => {
        const elegido = seleccionMultiple.some(c => c.id === card.dataset.id);
        card.classList.toggle('alquiler-card--selected', elegido);
        const btn = card.querySelector('.btn-seleccionar-cont');
        if (btn) btn.textContent = elegido ? 'Quitar' : 'Seleccionar';
    });
}

// Con 2 o más contenedores: una fila por contenedor (fecha de fin propia, opcional) y los
// hidden ids_contenedor[]. Con 0 o 1, el bloque queda oculto y vacío. Las claves llevan "c"
// adelante (fin_c[c<ID>]): con claves numéricas el servidor perdería a qué contenedor
// corresponde cada valor.
function armarBloqueVarios() {
    if (inputsConts) inputsConts.innerHTML = '';
    if (listaVarios) listaVarios.innerHTML = '';
    if (bloqueVarios) bloqueVarios.style.display = esMultiple() ? '' : 'none';
    if (rowCheckFinal) rowCheckFinal.style.display = esMultiple() ? 'none' : '';
    if (!esMultiple()) return;
    seleccionMultiple.forEach(c => {
        const id = escHtml(c.id);
        inputsConts?.insertAdjacentHTML('beforeend', `<input type="hidden" name="ids_contenedor[]" value="${id}">`);
        listaVarios?.insertAdjacentHTML('beforeend', `
            <div class="multi-cont-fila">
                <span class="multi-cont-fila__num">#${escHtml(c.numero)}</span>
                <label>Fin
                    <input type="date" name="fin_c[c${id}]" class="input-sm multi-cont-fin">
                </label>
            </div>`);
    });
    listaVarios?.querySelectorAll('input').forEach(inp => {
        inp.addEventListener('input', actualizarResumen);
        inp.addEventListener('change', actualizarResumen);
    });
}

function limpiarSeleccionMultiple() {
    seleccionMultiple = [];
    actualizarBarraSeleccion();
    armarBloqueVarios();
}

// Un solo contenedor: carga los hidden y abre el modal (igual que siempre).
function abrirConUnContenedor(card) {
    document.querySelectorAll('.alquiler-card').forEach(c => c.classList.remove('alquiler-card--selected'));
    card.classList.add('alquiler-card--selected');

    contenedorSeleccionado = {
        id:               card.dataset.id,
        numero:           card.dataset.numero,
        fin:              card.dataset.fin || null,
        alquilerActualId: card.dataset.alquilerActual || '',
    };

    const inputId  = document.getElementById('inputContenedorId');
    const inputAct = document.getElementById('inputAlquilerActualId');
    if (inputId)  inputId.value  = contenedorSeleccionado.id;
    if (inputAct) inputAct.value = contenedorSeleccionado.alquilerActualId;

    const labelModal = document.getElementById('modal-cont-label');
    if (labelModal) labelModal.textContent = `Contenedor #${contenedorSeleccionado.numero}`;

    // si es "por finalizar", el alquiler nuevo arranca después de la liberación
    if (contenedorSeleccionado.fin && fechaInicio) {
        fechaInicio.min   = contenedorSeleccionado.fin;
        fechaInicio.value = '';
    }
    aplicarFechaFinAutomatica();
    armarBloqueVarios();
    abrirModalAlquiler();
    actualizarResumen();
}

// Varios contenedores: sin contenedor único ni encadenado; los ids van en las filas.
function abrirConVariosContenedores() {
    contenedorSeleccionado = null;
    const inputId  = document.getElementById('inputContenedorId');
    const inputAct = document.getElementById('inputAlquilerActualId');
    if (inputId)  inputId.value  = '';
    if (inputAct) inputAct.value = '';
    if (fechaInicio) fechaInicio.min = '';
    const labelModal = document.getElementById('modal-cont-label');
    if (labelModal) labelModal.textContent = `${seleccionMultiple.length} contenedores (${seleccionMultiple.map(c => '#' + c.numero).join(', ')})`;
    // La carga histórica es de a un contenedor
    if (checkFinalizado?.checked) { checkFinalizado.checked = false; aplicarModoFinalizado(false); }
    aplicarFechaFinAutomatica();
    armarBloqueVarios();
    abrirModalAlquiler();
    actualizarResumen();
}

document.querySelectorAll('#listaDisponibles .btn-seleccionar-cont').forEach(btn => {
    btn.addEventListener('click', () => {
        const card = btn.closest('.alquiler-card');
        if (!card) return;
        const i = seleccionMultiple.findIndex(c => c.id === card.dataset.id);
        if (i >= 0) seleccionMultiple.splice(i, 1);
        else seleccionMultiple.push({ id: card.dataset.id, numero: card.dataset.numero });
        actualizarBarraSeleccion();
    });
});

document.querySelectorAll('#listaPorFinalizar .btn-seleccionar-cont').forEach(btn => {
    btn.addEventListener('click', () => {
        const card = btn.closest('.alquiler-card');
        if (!card) return;
        limpiarSeleccionMultiple();
        abrirConUnContenedor(card);
    });
});

document.getElementById('btnLimpiarSeleccion')?.addEventListener('click', limpiarSeleccionMultiple);
document.getElementById('btnContinuarSeleccion')?.addEventListener('click', () => {
    if (esMultiple()) { abrirConVariosContenedores(); return; }
    if (seleccionMultiple.length === 1) {
        const card = Array.from(document.querySelectorAll('#listaDisponibles .alquiler-card'))
            .find(c => c.dataset.id === seleccionMultiple[0].id);
        if (card) abrirConUnContenedor(card);
    }
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
        limpiarSeleccionMultiple();
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
    aplicarBloqueCobroHistorico();
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
    aplicarBloqueCobroHistorico();
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
    limpiarSeleccionMultiple();
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
    } else if (!modoFinalizado() && !contenedorSeleccionado && !esMultiple()) {
        e.preventDefault(); alert('Seleccioná un contenedor.'); return;
    }
    const clienteId = document.getElementById('inputClienteId')?.value;
    if (!clienteId) { e.preventDefault(); alert('Buscá y seleccioná un cliente antes de confirmar.'); return; }

    // Solo el histórico ya finalizado pide precio; los demás se cargan sin precio.
    if (pideCobro() && !(Number(precioInput?.value) > 0)) {
        e.preventDefault(); alert('Ingresá el precio del alquiler.'); precioInput?.focus(); return;
    }

    // Validar campos obligatorios manualmente
    // Calle u obra ya se validan al enviar (al menos uno); el número es opcional (esquinas).
    const campos = [
        { id: 'fechaInicio', nombre: 'Fecha de inicio' },
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
    const requeridos = ['#fechaInicio'];
    if (!sinFechaFin() && !historicoEnCurso()) requeridos.push('#fechaFin');
    if (typeof validarFormulario === 'function' && !validarFormulario(e.target, requeridos)) {
        e.preventDefault();
    }
});

aplicarBloqueCobroHistorico();
actualizarResumen();
