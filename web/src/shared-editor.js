import { EditorSelection, Transaction } from '@codemirror/state';

// Each view keeps its selection while sharing the document and undo history.
export function stateForOtherView(state, selection, changes) {
  const mapped = changes ? selection.map(changes) : selection;
  const ranges = mapped.ranges.map(range => EditorSelection.range(
    Math.min(state.doc.length, Math.max(0, range.anchor)),
    Math.min(state.doc.length, Math.max(0, range.head)),
  ));
  return state.update({
    selection: EditorSelection.create(ranges, Math.min(mapped.mainIndex, ranges.length - 1)),
    annotations: Transaction.addToHistory.of(false),
  }).state;
}

export function restoredTabPaths(session, files, limit = 80) {
  const available = new Set(files.map(file => typeof file === 'string' ? file : file.path));
  const paths = Array.isArray(session?.tabs) ? session.tabs : [session?.activePath];
  return [...new Set(paths.filter(path => typeof path === 'string' && available.has(path)))].slice(0, limit);
}
