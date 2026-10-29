// Liquidaciones: marcar / quitar "para facturar" varias operaciones de una vez. Cada tarjeta
// tiene una casilla (.js-liq-sel); al enviar #formFacturarGrupo se le agregan los ids.
// Marcar le suma el IVA 21% al neto de cada una (lo que debe el cliente); quitar se lo descuenta.
(function () {
    'use strict';
    const form = document.getElementById('formFacturarGrupo');
    if (!form) return;

    const ALICUOTA = 21;
    const todas = document.getElementById('liqSelTodas');
    const info = document.getElementById('liqSelInfo');
    const btnMarcar = document.getElementById('btnLiqMarcar');
    const btnQuitar = document.getElementById('btnLiqQuitar');
    const textoBase = info.textContent;
    const money = (n) => '$' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const redondear = (n) => Math.round((Number(n) || 0) * 100) / 100;
    const ops = (n) => n + ' operaci' + (n === 1 ? 'ón' : 'ones');

    const habilitadas = () => [...document.querySelectorAll('.js-liq-sel:not(:disabled)')];
    const seleccionadas = () => habilitadas().filter(c => c.checked);
    // A marcar: las tildadas que todavía no están marcadas; a quitar: las tildadas que sí
    const aMarcar = () => seleccionadas().filter(c => c.dataset.marcada !== '1');
    const aQuitar = () => seleccionadas().filter(c => c.dataset.marcada === '1');
    const ivaAMarcar = () => redondear(aMarcar().reduce((s, c) => s + redondear(Number(c.dataset.neto) * ALICUOTA / 100), 0));
    const ivaAQuitar = () => redondear(aQuitar().reduce((s, c) => s + Number(c.dataset.iva), 0));

    function actualizar() {
        const sel = seleccionadas().length;
        const m = aMarcar().length;
        const q = aQuitar().length;
        const hab = habilitadas().length;
        info.textContent = sel ? ops(sel) + (sel === 1 ? ' seleccionada' : ' seleccionadas') : textoBase;
        btnMarcar.disabled = !m;
        btnQuitar.disabled = !q;
        btnMarcar.textContent = 'Marcar para facturar' + (m ? ' (' + m + ')' : '');
        btnQuitar.textContent = 'Quitar de facturación' + (q ? ' (' + q + ')' : '');
        todas.checked = hab > 0 && sel === hab;
        todas.indeterminate = sel > 0 && sel < hab;
        todas.disabled = !hab;
    }

    todas.addEventListener('change', () => {
        habilitadas().forEach(c => { c.checked = todas.checked; });
        actualizar();
    });

    document.addEventListener('change', (e) => {
        if (e.target.closest && e.target.closest('.js-liq-sel')) actualizar();
    });

    // Confirmación: cuántas cambian y cuánto IVA se le suma / descuenta al cliente
    form.addEventListener('submit', (e) => {
        const quitar = e.submitter === btnQuitar;
        const n = quitar ? aQuitar().length : aMarcar().length;
        if (!n) { e.preventDefault(); return; }
        const texto = quitar
            ? '¿Quitar ' + ops(n) + ' de facturación?' + (ivaAQuitar() ? ' Se le descuenta el IVA (' + money(ivaAQuitar()) + ') a lo que debe el cliente.' : '')
            : '¿Marcar ' + ops(n) + ' para facturar? Se le suma el IVA ' + ALICUOTA + '% (' + money(ivaAMarcar()) + ') a lo que debe el cliente.';
        if (!window.confirm(texto)) { e.preventDefault(); return; }
        // Se envían solo las que cambian (las demás tildadas quedan como están)
        form.querySelectorAll('input[name="ids"]').forEach(i => i.remove());
        (quitar ? aQuitar() : aMarcar()).forEach(c => {
            const i = document.createElement('input');
            i.type = 'hidden';
            i.name = 'ids';
            i.value = c.value;
            form.appendChild(i);
        });
    });

    actualizar();
})();
