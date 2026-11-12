// ═══════════════════════════════════════════════════════════════════
// Modal "Registrar pago" de la cuenta corriente (views/partials/modal_pago_cuenta.ejs).
// Lo abre cualquier botón .btn-abonar:
//   data-id (cliente), data-nombre, data-deuda
//   data-clave ('op:ID' | 'cargo:ID') + data-descripcion → "Saldar" UNA operación: el monto es
//   exactamente lo que falta pagar de ella y el pago se aplica a ella.
// Trae lo que debe el cliente (GET /clientes/:id/cuenta/pendientes) y deja elegir a qué
// operaciones se aplica el pago: las más antiguas primero, las más nuevas primero o importes
// a mano. Envía la elección en el campo "imputaciones" ([{ clave, monto }]). Lo que no se
// elige se aplica a las deudas más antiguas; si sobra, queda a favor del cliente.
// ═══════════════════════════════════════════════════════════════════
(function () {
    const modal = document.getElementById('modal-abonar');
    if (!modal) return;
    const $ = (id) => document.getElementById(id);
    const form = $('formAbonar');
    const inputMonto = $('inputMonto');
    const inputImp = $('inputImputaciones');
    const inputDescripcion = $('inputDescripcionAbonar');
    const seccion = $('pagoOperaciones');
    const lista = $('pagoLista');
    const resumen = $('pagoResumen');
    const sinDeuda = $('pagoSinDeuda');
    const btnConfirmar = $('confirmarPago');

    const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
    const pesos = (n) => '$' + r2(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const fecha = (f) => (f ? String(f).slice(0, 10).split('-').reverse().join('/') : '');

    // items: [{ clave, nro, remito, fecha, descripcion, total, resta, marcada, monto, fila }]
    let st = { items: [], clave: null, deuda: 0, montoTocado: false };

    const criterio = () => (form.querySelector('input[name="criterioPago"]:checked') || {}).value || 'antiguas';
    const setCriterio = (v) => { const r = form.querySelector(`input[name="criterioPago"][value="${v}"]`); if (r) r.checked = true; };
    const monto = () => r2(inputMonto.value);
    const marcadas = () => st.items.filter(it => it.marcada);
    const asignado = () => r2(st.items.reduce((s, it) => s + (it.marcada ? it.monto : 0), 0));

    // Antiguas / nuevas: el monto se reparte entre las marcadas, cada una hasta lo que debe
    function repartir() {
        const c = criterio();
        if (c === 'manual') return;
        let disponible = monto();
        const orden = marcadas().slice();
        if (c === 'nuevas') orden.reverse();
        st.items.forEach(it => { it.monto = 0; });
        for (const it of orden) {
            const usado = Math.min(it.resta, disponible);
            it.monto = r2(usado);
            disponible = r2(disponible - usado);
        }
    }

    function crearFilas() {
        lista.innerHTML = '';
        st.items.forEach((it, i) => {
            const fila = document.createElement('div');
            fila.className = 'pago-op';
            const idCheck = `pagoOp${i}`;
            const nro = [it.nro, it.remito ? `Remito ${it.remito}` : null].filter(Boolean).join(' · ') || 'Cargo a mano';
            fila.innerHTML = `
                <input type="checkbox" class="pago-op__check" id="${idCheck}">
                <label class="pago-op__info" for="${idCheck}">
                    <span class="pago-op__nro"></span>
                    <span class="pago-op__desc"></span>
                </label>
                <span class="pago-op__debe"></span>
                <span class="pago-op__aplica">
                    <span class="pago-op__aplica-txt"></span>
                    <input type="number" class="form-control form-control-sm pago-op__input" min="0" step="0.01" inputmode="decimal" aria-label="Importe a aplicar">
                </span>
                <span class="pago-op__queda"></span>`;
            fila.querySelector('.pago-op__nro').textContent = `${nro} · ${fecha(it.fecha)}`;
            fila.querySelector('.pago-op__desc').textContent = it.descripcion || '';
            fila.querySelector('.pago-op__debe').innerHTML = `Debe <strong>${pesos(it.resta)}</strong>` +
                (it.total - it.resta > 0.005 ? ` <small>de ${pesos(it.total)}</small>` : '');
            const check = fila.querySelector('.pago-op__check');
            const input = fila.querySelector('.pago-op__input');
            input.max = it.resta;
            check.addEventListener('change', () => {
                it.marcada = check.checked;
                if (criterio() === 'manual') {
                    const otros = r2(asignado() - (it.marcada ? it.monto : 0));
                    it.monto = it.marcada ? r2(st.montoTocado ? Math.min(it.resta, Math.max(0, monto() - otros)) : it.resta) : 0;
                    if (it.marcada && it.monto <= 0) it.monto = it.resta;
                }
                actualizar();
            });
            input.addEventListener('input', () => {
                const v = Math.max(0, Math.min(it.resta, r2(input.value)));
                it.monto = v;
                it.marcada = v > 0;
                actualizar({ desde: input });
            });
            input.addEventListener('blur', () => { input.value = it.monto ? it.monto : ''; });
            it.fila = fila;
            lista.appendChild(fila);
        });
    }

    // Vuelca el estado en la pantalla (sin pisar el campo que se está escribiendo)
    function pintar(desde) {
        const manual = criterio() === 'manual';
        st.items.forEach(it => {
            const f = it.fila;
            f.classList.toggle('is-marcada', it.marcada);
            f.querySelector('.pago-op__check').checked = it.marcada;
            const input = f.querySelector('.pago-op__input');
            input.hidden = !manual;
            if (input !== desde) input.value = it.marcada && it.monto ? it.monto : '';
            const txt = f.querySelector('.pago-op__aplica-txt');
            txt.hidden = manual;
            txt.textContent = it.marcada && it.monto > 0 ? `Se aplica ${pesos(it.monto)}` : '';
            const queda = f.querySelector('.pago-op__queda');
            const resto = r2(it.resta - (it.marcada ? it.monto : 0));
            if (!it.marcada || it.monto <= 0) { queda.textContent = ''; queda.className = 'pago-op__queda'; }
            else if (resto <= 0.005) { queda.textContent = 'Queda pagada'; queda.className = 'pago-op__queda pago-op__queda--pagada'; }
            else { queda.textContent = `Queda debiendo ${pesos(resto)}`; queda.className = 'pago-op__queda pago-op__queda--parcial'; }
        });
    }

    function resumir() {
        const m = monto();
        const a = asignado();
        const ops = marcadas().filter(it => it.monto > 0);
        const pagadas = ops.filter(it => it.resta - it.monto <= 0.005).length;
        const sinElegir = st.items.some(it => !it.marcada || it.monto < it.resta - 0.005);
        let texto = '';
        let error = false;
        if (a - m > 0.005) {
            texto = `Lo aplicado a las operaciones (${pesos(a)}) es más que el monto del pago (${pesos(m)}). Ajustá los importes o el monto.`;
            error = true;
        } else if (m <= 0) {
            texto = criterio() === 'manual' ? 'Marcá las operaciones y el importe de cada una.' : 'Ingresá el monto que entrega el cliente.';
        } else {
            const partes = [];
            if (ops.length) {
                partes.push(`Se aplican ${pesos(a)} a ${ops.length} ${ops.length === 1 ? 'operación' : 'operaciones'}` +
                    (pagadas ? `: ${pagadas} queda${pagadas === 1 ? '' : 'n'} pagada${pagadas === 1 ? '' : 's'}` : '') +
                    (ops.length - pagadas ? `${pagadas ? ' y' : ':'} ${ops.length - pagadas} con saldo` : '') + '.');
            }
            const resto = r2(m - a);
            if (resto > 0.005) {
                partes.push(sinElegir
                    ? `Los ${pesos(resto)} restantes se aplican a las demás deudas, de la más antigua a la más nueva (lo que sobre queda a favor).`
                    : `Los ${pesos(resto)} restantes quedan a favor del cliente.`);
            }
            texto = partes.join(' ');
        }
        resumen.textContent = texto;
        resumen.classList.toggle('pago-cuenta__resumen--error', error);
        btnConfirmar.disabled = error;
    }

    function actualizar({ desde = null } = {}) {
        if (criterio() === 'manual' && !st.montoTocado) inputMonto.value = asignado() || '';
        repartir();
        pintar(desde);
        resumir();
    }

    async function cargar(idCliente) {
        st.items = [];
        lista.innerHTML = '<p class="pago-cuenta__cargando">Cargando lo que debe el cliente…</p>';
        seccion.hidden = false;
        sinDeuda.classList.add('d-none');
        try {
            const r = await fetch(`/clientes/${encodeURIComponent(idCliente)}/cuenta/pendientes`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const datos = await r.json();
            st.items = (datos.pendientes || []).map(it => ({ ...it, marcada: false, monto: 0 }));
        } catch (_) {
            // Sin la lista se puede pagar igual: se aplica a las deudas más antiguas
            seccion.hidden = true;
            return;
        }
        if (!st.items.length) {
            seccion.hidden = true;
            sinDeuda.classList.remove('d-none');
            return;
        }
        const elegida = st.clave ? st.items.find(it => it.clave === st.clave) : null;
        if (elegida) {
            // Saldar una operación: exactamente lo que falta de ella
            setCriterio('manual');
            elegida.marcada = true;
            elegida.monto = elegida.resta;
            inputMonto.value = elegida.resta;
            st.montoTocado = false;
            $('modal-abonar-deuda').textContent = pesos(elegida.resta);
        } else {
            setCriterio('antiguas');
            st.items.forEach(it => { it.marcada = true; });
        }
        crearFilas();
        actualizar();
    }

    // Delegado: en Cuentas corrientes las filas se reemplazan al buscar en vivo
    document.addEventListener('click', e => {
        const btn = e.target.closest('.btn-abonar');
        if (!btn) return;
        st = { items: [], clave: btn.dataset.clave || null, deuda: Number(btn.dataset.deuda) || 0, montoTocado: false };
        const concepto = btn.dataset.descripcion || '';
        $('modal-abonar-nombre').textContent = btn.dataset.nombre || '';
        $('modal-abonar-accion').textContent = st.clave ? 'Saldar' : 'Registrar pago';
        $('modal-abonar-deuda').textContent = pesos(st.deuda);
        $('modal-abonar-deuda-label').textContent = st.clave ? 'Lo que falta pagar de esta operación' : 'Deuda en cuenta corriente';
        const refConcepto = $('modal-abonar-concepto');
        refConcepto.textContent = concepto ? `Operación: ${concepto}` : '';
        refConcepto.classList.toggle('d-none', !concepto);
        if (inputDescripcion) inputDescripcion.value = concepto;
        inputMonto.value = st.clave ? st.deuda : '';
        inputImp.value = '[]';
        resumen.textContent = '';
        btnConfirmar.disabled = false;
        form.action = `/clientes/${btn.dataset.id}/abonar`;
        // Transferencia a tercero: no arrastrar lo elegido en un pago anterior
        $('inputMetodoAbonar')?.dispatchEvent(new Event('tercero:reset'));
        // Fecha de pago: cada pago arranca en hoy (el máximo permitido)
        const inputFecha = $('inputFechaAbonar');
        if (inputFecha && inputFecha.max) inputFecha.value = inputFecha.max;
        modal.style.display = 'flex';
        document.body.style.overflow = 'hidden';
        inputMonto.focus();
        cargar(btn.dataset.id);
    });

    inputMonto.addEventListener('input', () => {
        st.montoTocado = true;
        repartir();
        pintar();
        resumir();
    });

    form.querySelectorAll('input[name="criterioPago"]').forEach(r => r.addEventListener('change', () => {
        if (criterio() === 'manual') st.montoTocado = inputMonto.value !== '';
        actualizar();
    }));

    // "Usar el total": lo que deben las marcadas (o toda la deuda si no hay lista)
    $('btnPagarTotal')?.addEventListener('click', () => {
        if (st.items.length && !marcadas().length) st.items.forEach(it => { it.marcada = true; });
        const total = st.items.length ? r2(marcadas().reduce((s, it) => s + it.resta, 0)) : st.deuda;
        inputMonto.value = total || '';
        st.montoTocado = true;
        if (criterio() === 'manual') st.items.forEach(it => { if (it.marcada) it.monto = it.resta; });
        actualizar();
    });
    $('pagoMarcarTodas')?.addEventListener('click', () => {
        st.items.forEach(it => {
            if (!it.marcada && criterio() === 'manual') it.monto = it.resta;
            it.marcada = true;
        });
        if (criterio() === 'manual') st.montoTocado = false;
        actualizar();
    });
    $('pagoDesmarcarTodas')?.addEventListener('click', () => {
        st.items.forEach(it => { it.marcada = false; it.monto = 0; });
        actualizar();
    });

    form.addEventListener('submit', e => {
        if (asignado() - monto() > 0.005) { e.preventDefault(); resumir(); return; }
        inputImp.value = JSON.stringify(seccion.hidden ? [] : marcadas()
            .filter(it => it.monto > 0)
            .map(it => ({ clave: it.clave, monto: r2(it.monto) })));
    });

    function cerrar() {
        modal.style.display = 'none';
        document.body.style.overflow = '';
    }
    $('cerrarModalAbonar')?.addEventListener('click', cerrar);
    $('cancelarModalAbonar')?.addEventListener('click', cerrar);
    modal.addEventListener('click', e => { if (e.target === e.currentTarget) cerrar(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && modal.style.display === 'flex') cerrar(); });
})();
