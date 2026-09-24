// Auto-cerrar alertas después de 4 segundos
document.addEventListener('DOMContentLoaded', () => {
  const alerts = document.querySelectorAll('.alert')
  alerts.forEach(alert => {
    setTimeout(() => {
      const bsAlert = bootstrap.Alert.getOrCreateInstance(alert)
      bsAlert.close()
    }, 4000)
  })

  // ── Sidebar: off-canvas en mobile, colapsable en desktop ─────
  const sidebar  = document.querySelector('.app-sidebar')
  const backdrop = document.getElementById('sidebarBackdrop')
  const toggle   = document.getElementById('sidebarToggle')
  const root     = document.documentElement
  const isDesktop = () => window.innerWidth >= 768
  const syncAria = () => {
    if (!toggle || !sidebar) return
    const visible = isDesktop() ? !root.classList.contains('sidebar-collapsed') : sidebar.classList.contains('is-open')
    toggle.setAttribute('aria-expanded', String(visible))
  }
  const open  = () => { sidebar && sidebar.classList.add('is-open'); backdrop && backdrop.classList.add('is-open'); document.body.style.overflow = 'hidden'; syncAria() }
  const close = () => { sidebar && sidebar.classList.remove('is-open'); backdrop && backdrop.classList.remove('is-open'); document.body.style.overflow = ''; syncAria() }
  const toggleDesktop = () => {
    const collapsed = root.classList.toggle('sidebar-collapsed')
    try { localStorage.setItem('sidebarCollapsed', collapsed ? '1' : '0') } catch (_) {}
    syncAria()
  }
  if (toggle) toggle.addEventListener('click', () => {
    if (isDesktop()) toggleDesktop()
    else sidebar.classList.contains('is-open') ? close() : open()
  })
  if (backdrop) backdrop.addEventListener('click', close)
  // Cerrar al tocar un link del menú o al pasar a desktop
  document.querySelectorAll('.app-sidebar .nav-link, .sidebar-logout').forEach(a => a.addEventListener('click', close))
  window.addEventListener('resize', () => { if (isDesktop()) close(); else syncAria() })
  syncAria()

  // ── Toggle ver/ocultar contraseña en inputs type=password ───
  const svg = (body) => `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
  const IC_VER    = svg('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>')
  const IC_OCULTAR = svg('<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>')
  document.querySelectorAll('.pwd-toggle-btn').forEach(btn => {
    btn.innerHTML = IC_VER
    btn.addEventListener('click', () => {
      const wrap = btn.closest('.pwd-input-wrap')
      const inp = wrap?.querySelector('input')
      if (!inp) return
      const isPwd = inp.type === 'password'
      inp.type = isPwd ? 'text' : 'password'
      btn.innerHTML = isPwd ? IC_OCULTAR : IC_VER
      btn.setAttribute('aria-label', isPwd ? 'Ocultar contraseña' : 'Mostrar contraseña')
    })
  })

})
