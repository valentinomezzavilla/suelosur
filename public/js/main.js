// Auto-cerrar alertas después de 4 segundos
document.addEventListener('DOMContentLoaded', () => {
  const alerts = document.querySelectorAll('.alert')
  alerts.forEach(alert => {
    setTimeout(() => {
      const bsAlert = bootstrap.Alert.getOrCreateInstance(alert)
      bsAlert.close()
    }, 4000)
  })

  // ── Sidebar mobile (off-canvas) ──────────────────────────────
  const sidebar  = document.querySelector('.app-sidebar')
  const backdrop = document.getElementById('sidebarBackdrop')
  const toggle   = document.getElementById('sidebarToggle')
  const open  = () => { sidebar && sidebar.classList.add('is-open'); backdrop && backdrop.classList.add('is-open'); document.body.style.overflow = 'hidden' }
  const close = () => { sidebar && sidebar.classList.remove('is-open'); backdrop && backdrop.classList.remove('is-open'); document.body.style.overflow = '' }
  if (toggle) toggle.addEventListener('click', () => sidebar.classList.contains('is-open') ? close() : open())
  if (backdrop) backdrop.addEventListener('click', close)
  // Cerrar al tocar un link del menú o al pasar a desktop
  document.querySelectorAll('.app-sidebar .nav-link, .sidebar-logout').forEach(a => a.addEventListener('click', close))
  window.addEventListener('resize', () => { if (window.innerWidth >= 768) close() })

  // ── Mostrar fecha DD/MM/YYYY al lado de inputs date ──────────
  // (el navegador muestra el formato según su localización; este hint
  //  garantiza que el usuario vea DD/MM/YYYY sin depender del browser)
  function fmtDDMMYYYY(iso) {
    if (!iso) return ''
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/)
    return m ? `${m[3]}/${m[2]}/${m[1]}` : iso
  }
  document.querySelectorAll('input[type="date"]').forEach(inp => {
    // crear span hint solo una vez
    if (inp.dataset.dateHintMounted) return
    inp.dataset.dateHintMounted = '1'
    const hint = document.createElement('small')
    hint.className = 'date-hint text-muted'
    hint.style.cssText = 'display:block;margin-top:2px;font-size:0.78rem'
    hint.textContent = inp.value ? `📅 ${fmtDDMMYYYY(inp.value)}` : 'Formato: DD/MM/AAAA'
    inp.insertAdjacentElement('afterend', hint)
    inp.addEventListener('change', () => {
      hint.textContent = inp.value ? `📅 ${fmtDDMMYYYY(inp.value)}` : 'Formato: DD/MM/AAAA'
    })
  })
})
