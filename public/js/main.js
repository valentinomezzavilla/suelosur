// Auto-cerrar alertas después de 4 segundos
document.addEventListener('DOMContentLoaded', () => {
  const alerts = document.querySelectorAll('.alert')
  alerts.forEach(alert => {
    setTimeout(() => {
      const bsAlert = bootstrap.Alert.getOrCreateInstance(alert)
      bsAlert.close()
    }, 4000)
  })
})
