import { extractLogLocations } from './tex-tools.js';

function category(message, error = false) {
  if (/citation|bibliograph|bibtex|biber|database file|Repeated entry|crossref/i.test(message)) return 'citation';
  if (/reference|label.+(?:undefined|multiply)|multiply.defined/i.test(message)) return 'reference';
  if (/(?:Over|Under)full\s+\\[hv]box/i.test(message)) return 'box';
  return error ? 'error' : 'warning';
}

function normal(path) { return path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, ''); }

export function extractLogIssues(log, files = [], projectRoot = '', { main = '', limit = 500 } = {}) {
  const rows = String(log || '').replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/);
  const known = files.map(file => typeof file === 'string' ? file : file.path).filter(Boolean);
  const windows = /^[A-Za-z]:[\\/]|^[\\/]{2}/.test(projectRoot);
  const comparable = value => windows ? normal(value).toLowerCase() : normal(value);
  const root = comparable(projectRoot);
  const keys = new Map(known.map(path => [comparable(path), path]));
  const resolve = candidate => {
    let path = comparable(candidate.replace(/^"|"$/g, ''));
    if (root && path.startsWith(`${root}/`)) path = path.slice(root.length + 1);
    return keys.get(path) || null;
  };
  const engine = /^This is (?:pdfTeX|XeTeX|LuaHBTeX|LuaTeX|e-?pTeX|e-?upTeX|pTeX|upTeX)/;
  let lastTeX = 0, lastBib = 0;
  for (let i = 0; i < rows.length; i++) {
    if (engine.test(rows[i])) lastTeX = i;
    if (/^This is (?:BibTeX|upBibTeX)|^INFO - This is Biber/.test(rows[i])) lastBib = i;
  }
  const stack = [], result = [], seen = new Set();
  const currentFile = () => [...stack].reverse().find(Boolean) || (known.includes(main) ? main : '');
  const add = (row, message, { path = '', line = 0, severity = 'warning', bib = false } = {}) => {
    if (row < (bib ? lastBib : lastTeX)) return;
    message = message.replace(/\s+/g, ' ').trim().slice(0, 1200);
    const type = category(message, severity === 'error');
    const key = `${type}:${path}:${line}:${message}`;
    if (!message || seen.has(key) || result.length >= limit) return;
    seen.add(key); result.push({ category: type, severity, path, line, message, logLine: row + 1 });
  };
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (engine.test(row)) stack.length = 0;
    const locations = extractLogLocations(row, known, projectRoot);
    if (locations.length) {
      const bib = /---line\s+\d+\s+of file/.test(row);
      for (const location of locations) {
        const severity = /warning|(?:Over|Under)full\s+\\[hv]box/i.test(location.message) ? 'warning' : 'error';
        add(i, location.message, { ...location, severity, bib });
      }
    } else if (/^!\s|^(?:LaTeX|Package\s+\S+|Class\s+\S+)\s+(?:Font\s+)?(?:Warning|Error):|^(?:Over|Under)full\s+\\[hv]box|^.*(?:WARN|ERROR)\s+-\s|^I couldn't open (?:database|style) file/.test(row)) {
      let message = row.trim(), end = i;
      if (/Warning:/.test(row) && !/(?:[.!]|\d)\s*$/.test(row)) {
        while (end + 1 < Math.min(rows.length, i + 6) && /^\s+\S|^\([^)]*\)\s/.test(rows[end + 1])) {
          message += ` ${rows[++end].replace(/^\([^)]*\)\s*/, '').trim()}`;
          if (/[.!]\s*$/.test(rows[end])) break;
        }
      }
      let line = Number(/(?:input\s+line|at\s+lines?|on\s+line)\s+(\d+)/i.exec(message)?.[1] || 0);
      const severity = /^!\s|\bError:|\bERROR\s+-|^I couldn't/.test(message) ? 'error' : 'warning';
      if (!line && severity === 'error') {
        for (let next = i + 1; next < Math.min(rows.length, i + 10); next++) {
          const match = /^l\.(\d+)\s/.exec(rows[next]);
          if (match) { line = Number(match[1]); break; }
          if (/^!\s|^This is /.test(rows[next])) break;
        }
      }
      add(i, message, { path: currentFile(), line, severity, bib: /(?:WARN|ERROR)\s+-|^I couldn't/.test(row) });
    }
    // TeX marks opened input files with parentheses. Other balanced pairs
    // occupy a stack entry too, so closing a font or package does not close a
    // project file by mistake.
    for (let at = 0; at < row.length; at++) {
      if (row[at] === '(') {
        const match = /^(?:"([^"\r\n]+\.(?:tex|bib|sty|cls|ltx))"|([^()\r\n]*?\.(?:tex|bib|sty|cls|ltx)))(?=\s|[)]|$)/i.exec(row.slice(at + 1));
        stack.push(match ? resolve(match[1] || match[2]) : null);
        if (match) at += match[0].length;
      } else if (row[at] === ')' && stack.length) stack.pop();
    }
  }
  return result;
}
