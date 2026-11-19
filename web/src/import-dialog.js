import { t, translateElements } from './i18n.js';

export function element(tag, attributes = {}, text = '') {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value != null) node.setAttribute(name, String(value));
  }
  if (text !== '') node.textContent = text;
  return node;
}

export function translated(tag, key, attributes = {}) {
  return element(tag, { ...attributes, 'data-i18n': key }, t(key));
}

export function labelledInput(id, key, tag = 'input', attributes = {}) {
  const group = element('div', { class: 'import-field' });
  const label = translated('label', key, { for: id, class: 'field-label' });
  const input = element(tag, { id, ...(tag === 'input' ? { type: 'text' } : {}), ...attributes });
  group.append(label, input);
  return { group, input, label };
}

export function createImportDialog(id, title) {
  const dialog = element('dialog', { id, class: 'dialog import-dialog', 'aria-labelledby': `${id}-title` });
  const heading = element('div', { class: 'dialog-heading' });
  const close = element('button', { type: 'button', class: 'icon-button', 'aria-label': t('閉じる'), 'data-i18n-aria-label': '閉じる' }, '×');
  heading.append(translated('h2', title, { id: `${id}-title` }), close);
  const body = element('div', { class: 'import-body' });
  const error = element('p', { class: 'form-error', role: 'alert', hidden: '' });
  const footer = element('div', { class: 'dialog-actions' });
  dialog.append(heading, body, error, footer);
  document.body.append(dialog);
  let busy = false;
  const closeDialog = () => { if (!busy) dialog.close(); };
  close.addEventListener('click', closeDialog);
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog();
  });
  return {
    dialog, body, footer, error,
    get busy() { return busy; },
    close: closeDialog,
    clearError() { error.hidden = true; error.textContent = ''; },
    showError(err) { error.textContent = err?.message || String(err); error.hidden = false; },
    open() { this.clearError(); translateElements(dialog); if (!dialog.open) dialog.showModal(); },
    async run(task) {
      if (busy) return;
      busy = true;
      this.clearError();
      dialog.setAttribute('aria-busy', 'true');
      const buttons = [...dialog.querySelectorAll('button')].filter(button => !button.disabled);
      for (const button of buttons) button.disabled = true;
      try { return await task(); }
      catch (err) { this.showError(err); return undefined; }
      finally {
        busy = false; dialog.removeAttribute('aria-busy');
        for (const button of buttons) if (button.isConnected) button.disabled = false;
      }
    },
    destroy() { dialog.remove(); },
  };
}
