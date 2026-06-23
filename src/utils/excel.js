'use strict'
// ─────────────────────────────────────────────────────────────────
// Reportes Excel genéricos (exceljs).
// generarExcel(res, { titulo, columnas, filas, nombreArchivo })
//   columnas: [{ header, key, width?, money?, ... }]
//   filas:    [{ key: valor, ... }]
// ─────────────────────────────────────────────────────────────────
const ExcelJS = require('exceljs')

async function generarExcel(res, { titulo = 'Reporte', columnas = [], filas = [], nombreArchivo } = {}) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Suelosur'
  wb.created = new Date()
  const ws = wb.addWorksheet(titulo.slice(0, 30) || 'Reporte')

  // Título
  if (columnas.length) {
    ws.mergeCells(1, 1, 1, columnas.length)
    const t = ws.getCell(1, 1)
    t.value = titulo
    t.font = { bold: true, size: 14, color: { argb: 'FF1C5BAD' } }
    t.alignment = { vertical: 'middle' }
    ws.getRow(1).height = 22
  }

  // Encabezados
  const headerRowIdx = 2
  ws.columns = columnas.map(c => ({ key: c.key, width: c.width || 18 }))
  const headerRow = ws.getRow(headerRowIdx)
  columnas.forEach((c, i) => {
    const cell = headerRow.getCell(i + 1)
    cell.value = c.header
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1C5BAD' } }
    cell.alignment = { vertical: 'middle', horizontal: 'center' }
  })
  headerRow.commit()

  // Datos
  filas.forEach(f => {
    const row = ws.addRow(columnas.map(c => f[c.key]))
    columnas.forEach((c, i) => {
      if (c.money) {
        const cell = row.getCell(i + 1)
        cell.numFmt = '"$"#,##0.00'
      }
    })
  })

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivo || 'reporte'}.xlsx"`)
  await wb.xlsx.write(res)
  res.end()
}

module.exports = { generarExcel }
