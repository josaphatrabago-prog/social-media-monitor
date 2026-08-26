/** RFC 4180 CSV serialisation. */

const NEEDS_QUOTING = /[",\r\n]/;

function escapeCell(value) {
  if (value === null || value === undefined) return '';

  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);

  // A leading =, +, - or @ is executed as a formula by Excel and Sheets.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;

  if (!NEEDS_QUOTING.test(safe)) return safe;
  return `"${safe.replace(/"/g, '""')}"`;
}

/**
 * @param {Array<Object>} rows
 * @param {Array<{key: string, label?: string}>} columns
 */
export function toCsv(rows, columns) {
  const header = columns.map((column) => escapeCell(column.label ?? column.key));
  const lines = [header.join(',')];

  for (const row of rows) {
    lines.push(columns.map((column) => escapeCell(row[column.key])).join(','));
  }

  // \r\n is what Excel expects; a BOM keeps non-ASCII readable on Windows.
  return `\ufeff${lines.join('\r\n')}\r\n`;
}
