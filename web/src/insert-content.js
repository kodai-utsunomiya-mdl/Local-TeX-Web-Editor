// These functions create source text without reading files or changing the UI.
export function relativeAssetPath(documentPath, assetPath) {
  const source = String(documentPath).replaceAll('\\', '/').split('/').slice(0, -1);
  const target = String(assetPath).replaceAll('\\', '/').split('/');
  while (source.length && target.length && source[0] === target[0]) { source.shift(); target.shift(); }
  return [...source.map(() => '..'), ...target].join('/');
}

export function escapeTeXText(value) {
  const replacements = { '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '%': '\\%', '&': '\\&', '#': '\\#', '$': '\\$', '_': '\\_', '^': '\\textasciicircum{}', '~': '\\textasciitilde{}' };
  return String(value).replace(/[\\{}%&#$_^~]/g, character => replacements[character]);
}

export function assetInsertion({ documentPath, assetPath, caption = '', label = '', width = '0.8' }) {
  const relative = relativeAssetPath(documentPath, assetPath);
  if (/\.(md|markdown)$/i.test(documentPath)) {
    const alt = String(caption).replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]').replace(/\r?\n/g, ' ');
    const url = relative.split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
    return `${/\.pdf$/i.test(assetPath) ? '' : '!'}[${alt || (/\.pdf$/i.test(assetPath) ? relative : '')}](${url})\n`;
  }
  if (/[{}%\r\n]/.test(relative)) throw new Error('The image path contains characters that TeX cannot read here.');
  const fraction = Number(width);
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) throw new Error('Choose a width greater than 0 and at most 1.');
  if (label && !/^[A-Za-z][A-Za-z0-9:._/-]*$/.test(label)) throw new Error('Use letters, numbers, colon, hyphen, slash, period, or underscore in the label.');
  return `\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=${fraction}\\linewidth]{\\detokenize{${relative}}}\n${caption ? `  \\caption{${escapeTeXText(caption).replace(/\r?\n/g, ' ')}}\n` : ''}${label ? `  \\label{${label}}\n` : ''}\\end{figure}\n`;
}

export function suggestedAssetName(name, type = '') {
  const original = String(name || '').split(/[\\/]/).pop();
  let clean = original.replace(/[^\p{L}\p{N} ._-]/gu, '_').replace(/^[ .]+|[ .]+$/g, '');
  if (!/\.(png|jpe?g|pdf)$/i.test(clean)) {
    const extension = type === 'image/jpeg' ? '.jpg' : type === 'application/pdf' ? '.pdf' : '.png';
    clean = `${clean || 'image'}${extension}`;
  }
  const extension = clean.match(/\.[^.]+$/)?.[0] || '.png';
  return clean.slice(0, -extension.length).slice(0, 150) + extension;
}

function detectDelimiter(text) {
  let quoted = false, tabs = 0, commas = 0;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (character === '"') {
      if (quoted && text[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (!quoted) {
      if (character === '\n') break;
      if (character === '\t') tabs++;
      if (character === ',') commas++;
    }
  }
  return tabs > 0 ? '\t' : commas > 0 ? ',' : '\t';
}

export function parseTable(text, delimiter = 'auto') {
  text = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (text.length > 1_000_000) throw new Error('table-too-large');
  const separator = delimiter === 'tab' ? '\t' : delimiter === 'comma' ? ',' : detectDelimiter(text);
  const rows = [];
  let row = [], cell = '', quoted = false, afterQuote = false, atStart = true;
  const pushCell = () => {
    row.push(cell); cell = ''; atStart = true; afterQuote = false;
    if (row.length > 50) throw new Error('table-too-large');
  };
  const pushRow = () => {
    pushCell(); rows.push(row); row = [];
    if (rows.length > 500) throw new Error('table-too-large');
  };
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') { cell += '"'; index++; }
        else { quoted = false; afterQuote = true; }
      } else cell += character;
    } else if (atStart && character === '"') {
      quoted = true; atStart = false;
    } else if (character === separator) pushCell();
    else if (character === '\n') pushRow();
    else if (afterQuote) {
      if (character !== ' ') throw new Error('table-quotes');
    } else { cell += character; atStart = false; }
  }
  if (quoted) throw new Error('table-quotes');
  if (cell || row.length || (text.length && !text.endsWith('\n'))) pushRow();
  if (!rows.length || rows.every(row => row.every(cell => cell === ''))) return [];
  const columns = Math.max(...rows.map(row => row.length));
  if (rows.length * columns > 10_000) throw new Error('table-too-large');
  return rows.map(row => [...row, ...Array(columns - row.length).fill('')]);
}

function markdownCell(text) {
  return String(text).replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('`', '\\`').replaceAll('*', '\\*').replaceAll('_', '\\_').replaceAll('[', '\\[').replaceAll(']', '\\]').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/\n/g, ' ');
}

function texCell(text) {
  const lines = String(text).split('\n').map(escapeTeXText);
  return lines.length > 1 ? `\\shortstack[l]{${lines.join('\\\\')}}` : lines[0];
}

export function tableInsertion(rows, { format = 'markdown', header = true, align = 'l' } = {}) {
  if (!rows.length) return '';
  const columns = rows[0].length;
  if (format === 'markdown') {
    const line = row => `| ${row.map(markdownCell).join(' | ')} |`;
    return [line(header ? rows[0] : Array(columns).fill('')), `| ${Array(columns).fill('---').join(' | ')} |`, ...(header ? rows.slice(1) : rows).map(line)].join('\n') + '\n';
  }
  const lines = [`\\begin{tabular}{${Array(columns).fill(['l', 'c', 'r'].includes(align) ? align : 'l').join('')}}`];
  if (header) lines.push('\\hline');
  rows.forEach((row, index) => {
    lines.push(`  ${row.map(texCell).join(' & ')} \\\\`);
    if (header && index === 0) lines.push('\\hline');
  });
  if (header) lines.push('\\hline');
  lines.push('\\end{tabular}');
  return lines.join('\n') + '\n';
}

export function tableToTSV(rows) {
  return rows.map(row => row.map(cell => {
    const value = String(cell);
    return /["\t\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  }).join('\t')).join('\n') + (rows.length ? '\n' : '');
}
