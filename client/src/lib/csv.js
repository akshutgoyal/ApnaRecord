// CSV export.
//
// Compliance work ends up in a spreadsheet, so the auditor's event log and the
// admin's identity table need to leave the page as data. Generated client-side
// from rows already on screen — no export endpoint, because an endpoint that
// dumps the whole collection is a data-egress path that has to be authorised,
// and the user is already authorised to see exactly what they are exporting.

function escapeCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  // Quote when the value could otherwise break the row: delimiter, quote, or newline.
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * @param {Array<{key: string, label: string, value?: (row) => any}>} columns
 * @param {Array<object>} rows
 */
export function toCsv(columns, rows) {
  const header = columns.map((column) => escapeCell(column.label)).join(',');
  const body = rows.map((row) =>
    columns
      .map((column) => escapeCell(column.value ? column.value(row) : row[column.key]))
      .join(',')
  );
  return [header, ...body].join('\r\n');
}

export function downloadCsv(filename, columns, rows) {
  const csv = toCsv(columns, rows);
  // The BOM is not decoration: without it Excel reads UTF-8 as the local codepage
  // and every non-ASCII character in a name comes out mangled.
  const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export function timestampedFilename(prefix) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `${prefix}-${stamp}.csv`;
}
