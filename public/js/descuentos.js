// ═══════════════════════════════════════════════════════════════════
// Descuentos del cliente (views/partials/descuentos.ejs).
//  · "Agregar descuento": trae las operaciones que se pueden descontar
//    (GET /descuentos/opciones), pide la vista previa al servidor con cada cambio
//    (POST /descuentos/vista-previa, la misma cuenta que se guarda) y envía el formulario.
//  · "Ver descuentos aplicados": lista (GET /descuentos/cliente/:id) con "Revertir" (motivo).
// ═══════════════════════════════════════════════════════════════════
(function () {
  'use strict';
  const barra = document.querySelector('.desc-barra');
  if (!barra) return;
  const $ = (id) => document.getElementById(id);
  const cliente = barra.dataset.descCliente;
  const filtros = barra.dataset.descFiltros || '';
  const volver = barra.dataset.descVolver || location.pathname + location.search;

  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const pesos = (n) => '$ ' + r2(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fecha = (f) => (f ? String(f).slice(0, 10).split('-').reverse().join('/') : '');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ICONO_AVISO = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
  const aviso = (t) => `<p class="desc-aviso" role="note">${ICONO_AVISO}<span>${esc(t)}</span></p>`;

  // ── Abrir / cerrar ───────────────────────────────────────────
  let abierto = null;
  let anteriorFoco = null;
  function abrir(modal) {
    anteriorFoco = document.activeElement;
    modal.style.display = 'flex';
    abierto = modal;
    document.body.classList.add('modal-abierto');
    setTimeout(() => { const f = modal.querySelector('input:not([type=hidden]):not([disabled]), button'); if (f) f.focus(); }, 30);
  }
  function cerrar() {
    if (!abierto) return;
    abierto.style.display = 'none';
    abierto = null;
    document.body.classList.remove('modal-abierto');
    if (anteriorFoco && anteriorFoco.focus) anteriorFoco.focus();
  }
  document.querySelectorAll('.js-desc-cerrar').forEach(b => b.addEventListener('click', cerrar));
  ['modal-descuento', 'modal-descuentos'].forEach(id => {
    const m = $(id);
    if (m) m.addEventListener('mousedown', (e) => { if (e.target === m) cerrar(); });
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && abierto) cerrar(); });

  // ── Agregar descuento ────────────────────────────────────────
  const modal = $('modal-descuento');
  const form = $('formDescuento');
  const inputValor = $('descValor');
  const previa = $('descPrevia');
  const btnAplicar = $('descAplicar');
  const inputRef = $('descReferencia');
  const inputEsperado = $('descTotalEsperado');
  let opciones = null;
  let pedidoActual = 0;
  let espera = null;

  const tipo = () => (form.querySelector('input[name=tipo]:checked') || {}).value || 'porcentaje';
  const alcance = () => (form.querySelector('input[name=alcance]:checked') || {}).value || 'todas';
  const selectDe = (a) => form.querySelector(`.js-desc-ref[data-alcance="${a}"]`);

  function opcion(valor, texto) { const o = document.createElement('option'); o.value = valor; o.textContent = texto; return o; }
  function llenar(sel, items, texto, vacio) {
    sel.innerHTML = '';
    if (!items.length) { sel.appendChild(opcion('', vacio)); sel.disabled = true; return; }
    items.forEach(it => sel.appendChild(opcion(it.valor, texto(it))));
    sel.disabled = false;
  }
  function habilitarAlcance(a, si) {
    const r = form.querySelector(`input[name=alcance][value="${a}"]`);
    r.disabled = !si;
    r.closest('.desc-alcance').classList.toggle('is-disabled', !si);
  }

  function pintarOpciones() {
    const o = opciones;
    const deuda = r2(o.enPantalla.reduce((s, x) => s + x.resta, 0));
    $('descInfoTodas').textContent = o.enPantalla.length
      ? `${o.enPantalla.length} ${o.enPantalla.length === 1 ? 'operación debe' : 'operaciones deben'} ${pesos(deuda)}.`
      : 'No hay operaciones con saldo pendiente en pantalla.';
    llenar(selectDe('operacion'), o.enPantalla.map(x => ({ ...x, valor: x.id })),
      (x) => `${x.nombre} · ${fecha(x.fecha)} · debe ${pesos(x.resta)}${x.facturada ? ' · facturada' : ''}`, 'Sin operaciones para descontar');
    llenar(selectDe('remito'), o.remitos.map(x => ({ ...x, valor: x.numero })),
      (x) => `Remito ${x.numero} · ${x.cantidad} ${x.cantidad === 1 ? 'operación' : 'operaciones'} · debe ${pesos(x.resta)}`, 'Sin remitos con saldo pendiente');
    llenar(selectDe('factura'), o.facturas.map(x => ({ ...x, valor: x.numero })),
      (x) => `Factura ${x.numero} · ${x.cantidad} ${x.cantidad === 1 ? 'operación' : 'operaciones'} · debe ${pesos(x.resta)}`, 'Sin facturas con saldo pendiente');
    $('descInfoSaldo').textContent = o.saldoTotal > 0
      ? `Debe ${pesos(o.saldoTotal)} en total. Un crédito que se aplica a lo más viejo.`
      : 'El cliente no debe nada.';
    habilitarAlcance('todas', o.enPantalla.length > 0);
    habilitarAlcance('operacion', o.enPantalla.length > 0);
    habilitarAlcance('remito', o.remitos.length > 0);
    habilitarAlcance('factura', o.facturas.length > 0);
    habilitarAlcance('saldo', o.saldoTotal > 0);
    // Si el elegido quedó deshabilitado, el primero que se pueda
    const elegido = form.querySelector('input[name=alcance]:checked');
    if (!elegido || elegido.disabled) {
      const primero = form.querySelector('input[name=alcance]:not([disabled])');
      if (primero) primero.checked = true;
    }
    const exc = $('descExcluidas');
    if (o.excluidas.length) {
      exc.hidden = false;
      exc.innerHTML = `<strong>No se pueden descontar ${o.excluidas.length === 1 ? 'esta operación' : 'estas operaciones'} de la pantalla:</strong> ` +
        o.excluidas.map(x => `${esc(x.nombre)} (${esc(x.motivo.replace(/\.$/, '').toLowerCase())})`).join(' · ') +
        '. Si hace falta, usá “Sobre el saldo total”.';
    } else exc.hidden = true;
    marcarAlcance();
  }

  function marcarAlcance() {
    form.querySelectorAll('.desc-alcance').forEach(el => el.classList.toggle('is-activo', el.querySelector('input').checked));
    const sel = selectDe(alcance());
    inputRef.value = sel && !sel.disabled ? sel.value : '';
  }

  function cambiarTipo() {
    const pct = tipo() === 'porcentaje';
    $('descSufijo').hidden = !pct;
    $('descPrefijo').hidden = pct;
    $('descValorLabel').textContent = pct ? 'Porcentaje a descontar' : 'Monto a descontar';
    inputValor.placeholder = pct ? 'Ej: 10' : 'Ej: 250.000';
  }

  function estadoPrevia(html, ok) {
    previa.innerHTML = html;
    btnAplicar.disabled = !ok;
  }

  function pedirPrevia() {
    clearTimeout(espera);
    inputEsperado.value = '';
    btnAplicar.disabled = true;
    if (!String(inputValor.value).trim()) { estadoPrevia('<p class="desc-previa__vacio">Ingresá el valor para ver cuánto se descuenta.</p>', false); return; }
    espera = setTimeout(calcular, 250);
  }

  async function calcular() {
    const n = ++pedidoActual;
    previa.classList.add('is-cargando');
    try {
      const r = await fetch('/descuentos/vista-previa', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ clienteId: cliente, filtros, tipo: tipo(), valor: inputValor.value, alcance: alcance(), referencia: inputRef.value }),
      });
      const d = await r.json();
      if (n !== pedidoActual) return;
      if (!r.ok) { estadoPrevia(`<p class="desc-previa__error" role="alert">${esc(d.error || 'No se pudo calcular.')}</p>`, false); return; }
      inputEsperado.value = d.total;
      estadoPrevia(dibujarPrevia(d), d.total > 0);
    } catch (e) {
      if (n === pedidoActual) estadoPrevia('<p class="desc-previa__error" role="alert">No se pudo calcular la vista previa. Revisá la conexión.</p>', false);
    } finally {
      if (n === pedidoActual) previa.classList.remove('is-cargando');
    }
  }

  function dibujarPrevia(d) {
    const resumen = `<div class="desc-previa__resumen">
        <div><span>Debe</span><strong>${pesos(d.debe)}</strong></div>
        <div class="is-descuento"><span>Descuento ${esc(d.etiqueta)}</span><strong>− ${pesos(d.total)}</strong></div>
        <div class="is-queda"><span>Queda debiendo</span><strong>${pesos(d.queda)}</strong></div>
      </div>`;
    if (!d.lineas.length) return `<h3 class="desc-previa__titulo">Vista previa · ${esc(d.alcanceTexto)}</h3>${resumen}`;
    const filas = d.lineas.map(l => `
      <tr>
        <td><strong>${esc(l.nombre)}</strong><small>${esc(fecha(l.fecha))}${l.tipoTexto ? ' · ' + esc(l.tipoTexto) : ''}</small>
          ${l.aviso ? aviso(l.aviso) : ''}</td>
        <td class="text-end">${pesos(l.resta)}</td>
        <td class="text-end desc-previa__menos">− ${pesos(l.monto)}</td>
        <td class="text-end"><strong>${pesos(l.queda)}</strong></td>
      </tr>`).join('');
    return `<h3 class="desc-previa__titulo">Vista previa · ${esc(d.alcanceTexto)}</h3>${resumen}
      <div class="table-responsive"><table class="table table-sm desc-previa__tabla mb-0">
        <thead><tr><th>Operación</th><th class="text-end">Debe</th><th class="text-end">Descuento</th><th class="text-end">Queda</th></tr></thead>
        <tbody>${filas}</tbody>
      </table></div>`;
  }

  async function abrirAgregar() {
    form.reset();
    cambiarTipo();
    estadoPrevia('<p class="desc-previa__vacio">Ingresá el valor para ver cuánto se descuenta.</p>', false);
    abrir(modal);
    if (!opciones) {
      $('descInfoTodas').textContent = 'Cargando…';
      try {
        const r = await fetch(`/descuentos/opciones?clienteId=${encodeURIComponent(cliente)}&filtros=${encodeURIComponent(filtros)}`, { headers: { Accept: 'application/json' } });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error);
        opciones = d;
      } catch (e) {
        estadoPrevia(`<p class="desc-previa__error" role="alert">${esc((e && e.message) || 'No se pudieron cargar las operaciones.')}</p>`, false);
        return;
      }
    }
    pintarOpciones();
  }

  if (modal) {
    barra.querySelector('.js-desc-agregar').addEventListener('click', abrirAgregar);
    form.querySelectorAll('input[name=tipo]').forEach(r => r.addEventListener('change', () => { cambiarTipo(); pedirPrevia(); }));
    form.querySelectorAll('input[name=alcance]').forEach(r => r.addEventListener('change', () => { marcarAlcance(); pedirPrevia(); }));
    form.querySelectorAll('.js-desc-ref').forEach(sel => sel.addEventListener('change', () => {
      const r = form.querySelector(`input[name=alcance][value="${sel.dataset.alcance}"]`);
      if (r && !r.disabled) r.checked = true;
      marcarAlcance(); pedirPrevia();
    }));
    inputValor.addEventListener('input', pedirPrevia);
    form.addEventListener('submit', (e) => {
      if (btnAplicar.disabled || !inputEsperado.value) { e.preventDefault(); return; }
      btnAplicar.disabled = true;
      btnAplicar.textContent = 'Aplicando…';
    });
  }

  // ── Descuentos aplicados ─────────────────────────────────────
  const modalLista = $('modal-descuentos');
  const lista = $('descLista');
  const verRevertidos = $('descVerRevertidos');
  let descuentos = [];

  function tarjeta(d) {
    const ops = d.operaciones.length
      ? `<ul class="desc-item__ops">${d.operaciones.map(o => `<li><span>${esc(o.nombre)}${o.facturada ? ' <em class="desc-chip">facturada</em>' : ''}</span><strong>− ${pesos(o.monto)}</strong></li>`).join('')}</ul>`
      : '';
    const meta = [fecha(d.fecha), d.usuario && `cargado por ${esc(d.usuario)}`].filter(Boolean).join(' · ');
    const revertido = d.revertido
      ? `<p class="desc-item__revertido">Revertido el ${fecha(d.revertidoEn)}${d.revertidoPor ? ' por ' + esc(d.revertidoPor) : ''}${d.revertidoMotivo ? ' · ' + esc(d.revertidoMotivo) : ''}</p>`
      : `<div class="desc-item__acciones">
           <button type="button" class="btn btn-sm btn-outline-danger js-desc-revertir" data-id="${esc(d.id)}">Revertir</button>
         </div>
         <form class="desc-revertir" method="POST" action="/descuentos/${encodeURIComponent(d.id)}/revertir" hidden>
           <input type="hidden" name="clienteId" value="${esc(cliente)}">
           <input type="hidden" name="volver" value="${esc(volver)}">
           <label class="form-label" for="descMotivoRev${esc(d.id)}">Motivo para revertir</label>
           <input type="text" class="form-control form-control-sm" name="motivo" id="descMotivoRev${esc(d.id)}" maxlength="300" required placeholder="Ej: se cargó por error">
           <p class="form-hint">Las operaciones vuelven a deber lo descontado (${pesos(d.total)}).</p>
           <div class="desc-revertir__botones">
             <button type="button" class="btn btn-sm btn-outline-secondary js-desc-revertir-no">Cancelar</button>
             <button type="submit" class="btn btn-sm btn-danger">Confirmar reversión</button>
           </div>
         </form>`;
    return `<article class="desc-item${d.revertido ? ' is-revertido' : ''}">
        <header class="desc-item__cabecera">
          <span class="desc-item__valor">${esc(d.etiqueta)}</span>
          <div class="desc-item__datos"><strong>${esc(d.alcanceTexto)}</strong><small>${meta}</small></div>
          <span class="desc-item__total">− ${pesos(d.total)}</span>
        </header>
        ${d.motivo ? `<p class="desc-item__motivo">Motivo: ${esc(d.motivo)}</p>` : ''}
        ${ops}
        ${d.aviso && !d.revertido ? aviso(d.aviso) : ''}
        ${revertido}
      </article>`;
  }

  function pintarLista() {
    const mostrar = descuentos.filter(d => !d.revertido || (verRevertidos && verRevertidos.checked));
    $('descVerRevertidosCaja').hidden = !descuentos.some(d => d.revertido);
    lista.innerHTML = mostrar.length ? mostrar.map(tarjeta).join('') : '<p class="text-muted mb-0">No tiene descuentos vigentes.</p>';
  }

  async function abrirLista() {
    abrir(modalLista);
    lista.innerHTML = '<p class="text-muted mb-0">Cargando…</p>';
    try {
      const r = await fetch(`/descuentos/cliente/${encodeURIComponent(cliente)}`, { headers: { Accept: 'application/json' } });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      descuentos = d.descuentos || [];
      pintarLista();
    } catch (e) {
      lista.innerHTML = `<p class="desc-previa__error" role="alert">${esc((e && e.message) || 'No se pudieron cargar los descuentos.')}</p>`;
    }
  }

  if (modalLista) {
    const btnVer = barra.querySelector('.js-desc-ver');
    if (btnVer) btnVer.addEventListener('click', abrirLista);
    if (verRevertidos) verRevertidos.addEventListener('change', pintarLista);
    lista.addEventListener('click', (e) => {
      const si = e.target.closest('.js-desc-revertir');
      const no = e.target.closest('.js-desc-revertir-no');
      if (si) {
        const item = si.closest('.desc-item');
        item.querySelector('.desc-revertir').hidden = false;
        si.closest('.desc-item__acciones').hidden = true;
        item.querySelector('input[name=motivo]').focus();
      } else if (no) {
        const item = no.closest('.desc-item');
        item.querySelector('.desc-revertir').hidden = true;
        item.querySelector('.desc-item__acciones').hidden = false;
      }
    });
    lista.addEventListener('submit', (e) => {
      const f = e.target;
      const motivo = f.querySelector('input[name=motivo]');
      if (!motivo.value.trim()) { e.preventDefault(); motivo.classList.add('is-invalid'); motivo.focus(); return; }
      const b = f.querySelector('button[type=submit]');
      b.disabled = true; b.textContent = 'Revirtiendo…';
    });
  }
})();
