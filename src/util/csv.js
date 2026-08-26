/** RFC 4180 CSV serialisation. */

const NEEDS_QUOTING = /[",\r\n]/;

/** True for values Excel should keep as numbers, e.g. "-0.647". */
function isNumericValue(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value));
}

function escapeCell(value) {
  if (value === null || value === undefined) return '';

  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);

  // A leading =, +, - or @ makes Excel and Sheets evaluate the cell as a
  // formula, so those values are prefixed with an apostrophe to neutralise it.
  // Plain numbers are exempt: apostrophe-quoting "-0.647" would store the
  // sentiment score as text and break every average and chart built on it.
  const needsFormulaGuard = /^[=+\-@]/.test(text) && !isNumericValue(text);
  const safe = needsFormulaGuard ? `'${text}` : text;

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
