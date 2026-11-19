function linesOf(text) { return text.match(/[^\n]*\n|[^\n]+$/g) || []; }

function singleHunk(previous, current) {
  let start = 0;
  while (start < previous.length && start < current.length && previous[start] === current[start]) start++;
  start = start > 0 ? current.lastIndexOf('\n', start - 1) + 1 : 0;
  let oldEnd = previous.length, newEnd = current.length;
  while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === current[newEnd - 1]) { oldEnd--; newEnd--; }
  const oldBreak = previous.indexOf('\n', oldEnd), newBreak = current.indexOf('\n', newEnd);
  oldEnd = oldBreak < 0 ? previous.length : oldBreak + 1;
  newEnd = newBreak < 0 ? current.length : newBreak + 1;
  let line = 1;
  for (let at = 0; at < start; at++) if (current.charCodeAt(at) === 10) line++;
  return [{ from: start, to: newEnd, before: previous.slice(start, oldEnd), current: current.slice(start, newEnd), oldLine: line, line }];
}

// Limit the line comparison to 250,000 cells. Large rewrites remain available
// as one selectable change, without allocating a matrix for a long manuscript.
export function historyHunks(previous, current) {
  if (previous === current) return [];
  let breaks = 0;
  for (const text of [previous, current]) for (let at = 0; at < text.length; at++) if (text.charCodeAt(at) === 10 && ++breaks > 20000) return singleHunk(previous, current);
  const oldLines = linesOf(previous), newLines = linesOf(current);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let oldEnd = oldLines.length, newEnd = newLines.length;
  while (oldEnd > prefix && newEnd > prefix && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd--; newEnd--; }
  const n = oldEnd - prefix, m = newEnd - prefix;
  if ((n + 1) * (m + 1) > 250000) return singleHunk(previous, current);
  const width = m + 1, table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    table[i * width + j] = oldLines[prefix + i] === newLines[prefix + j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  }
  const hunks = [];
  let i = 0, j = 0, offset = newLines.slice(0, prefix).join('').length, hunk = null;
  const finish = () => { if (hunk) { hunks.push(hunk); hunk = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && oldLines[prefix + i] === newLines[prefix + j]) {
      finish(); offset += newLines[prefix + j].length; i++; j++; continue;
    }
    if (!hunk) hunk = { from: offset, to: offset, before: '', current: '', oldLine: prefix + i + 1, line: prefix + j + 1 };
    if (i < n && (j >= m || table[(i + 1) * width + j] >= table[i * width + j + 1])) hunk.before += oldLines[prefix + i++];
    else { const line = newLines[prefix + j++]; hunk.current += line; offset += line.length; hunk.to = offset; }
  }
  finish();
  return hunks;
}

export function restoreHistoryHunks(current, hunks, selected) {
  let position = 0, restored = '';
  for (let index = 0; index < hunks.length; index++) {
    if (!selected.has(index)) continue;
    const hunk = hunks[index];
    if (hunk.from < position || current.slice(hunk.from, hunk.to) !== hunk.current) throw new Error('The current document has changed.');
    restored += current.slice(position, hunk.from) + hunk.before; position = hunk.to;
  }
  return restored + current.slice(position);
}
