import { getLanguage, onLanguageChange } from './i18n.js';
import { extractLogIssues } from './log-issues-data.js';

const labels = {
  all: ['すべて', 'All'], error: ['エラー', 'Errors'], reference: ['相互参照', 'References'], citation: ['文献', 'Citations'], box: ['本文のはみ出しなど', 'Overfull / underfull boxes'], warning: ['その他の警告', 'Other warnings'],
  empty: ['該当するエラーや警告はありません．', 'No matching errors or warnings.'],
  running: ['コンパイル中の結果です．', 'The compilation is still running.'],
  finished: ['最後の TeX の実行で残った項目を表示します．', 'Showing issues from the final TeX pass.'],
  title: ['エラーと警告', 'Errors and warnings'], log: ['ログの行', 'Log line'],
};
const label = key => labels[key]?.[getLanguage() === 'ja' ? 0 : 1] || key;

export function createLogIssues({ container, onOpen }) {
  const filters = document.createElement('div'); filters.className = 'log-issue-filters'; filters.setAttribute('role', 'group');
  const status = document.createElement('p'); status.className = 'log-issue-status';
  const list = document.createElement('div'); list.className = 'log-issue-list'; list.dataset.testid = 'log-issue-list';
  container.replaceChildren(filters, status, list); container.classList.add('log-issues');
  let selected = 'all', issues = [], running = false, previousKey = '';
  const matching = kind => kind === 'all' ? issues : issues.filter(item => kind === 'error' ? item.severity === 'error' : item.category === kind);
  function render() {
    container.hidden = false;
    filters.replaceChildren(); list.replaceChildren(); filters.setAttribute('aria-label', label('title'));
    for (const kind of ['all', 'error', 'reference', 'citation', 'box', 'warning']) {
      const count = matching(kind).length;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'button button-small';
      button.textContent = `${label(kind)} (${count})`; button.dataset.issueFilter = kind; button.setAttribute('aria-pressed', String(selected === kind));
      button.addEventListener('click', () => { selected = kind; render(); }); filters.append(button);
    }
    status.textContent = label(running ? 'running' : 'finished');
    const displayed = matching(selected);
    if (!displayed.length) { const empty = document.createElement('p'); empty.className = 'field-help'; empty.textContent = label('empty'); list.append(empty); }
    for (const item of displayed) {
      const row = document.createElement(item.path && item.line ? 'button' : 'div'); row.className = 'log-issue';
      if (row.tagName === 'BUTTON') {
        row.type = 'button'; row.classList.add('log-location'); row.dataset.path = item.path; row.dataset.line = String(item.line);
        row.addEventListener('click', () => onOpen(item.path, item.line));
      }
      row.dataset.category = item.category; row.dataset.severity = item.severity;
      const location = document.createElement('strong'); location.textContent = item.path ? `${item.path}${item.line ? `:${item.line}` : ''}` : `${label('log')} ${item.logLine}`;
      const message = document.createElement('span'); message.textContent = item.message; row.append(location, message); list.append(row);
    }
  }
  const unsubscribe = onLanguageChange(render);
  return {
    update(log, files, projectRoot, options = {}) {
      const key = `${options.running}:${options.main}:${projectRoot}:${log}`;
      if (key === previousKey) return;
      previousKey = key; running = !!options.running;
      issues = extractLogIssues(log, files, projectRoot, options); render();
    },
    reset() { previousKey = ''; issues = []; running = false; render(); },
    destroy() { unsubscribe(); container.replaceChildren(); },
  };
}
