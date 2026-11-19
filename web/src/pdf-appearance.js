import { t, onLanguageChange } from './i18n.js';

const explanation = '画面上の PDF を暗い配色で表示します．図や写真の色も変わります．保存する PDF は元の配色です．';

export class PDFDarkMode {
  constructor({ container, button, darkMode = false, onChange }) {
    this.container = container;
    this.button = button;
    this.darkMode = !!darkMode;
    this.applicable = true;
    button?.addEventListener('click', () => {
      this.setDarkMode(!this.darkMode);
      onChange?.(this.darkMode);
    });
    this.unsubscribeLanguage = onLanguageChange(() => this.refreshLanguage());
    this.apply();
  }

  setDarkMode(enabled) {
    this.darkMode = !!enabled;
    this.apply();
  }

  setApplicable(applicable) {
    this.applicable = !!applicable;
    this.apply();
  }

  setReady(ready) {
    if (this.button) this.button.disabled = !ready;
  }

  apply() {
    this.container.dataset.pdfTheme = this.applicable && this.darkMode ? 'dark' : 'original';
    if (this.button) {
      this.button.hidden = !this.applicable;
      this.button.setAttribute('aria-pressed', String(this.darkMode));
    }
    this.refreshLanguage();
  }

  refreshLanguage() {
    if (!this.button) return;
    this.button.setAttribute('aria-label', t('PDF を暗く表示'));
    this.button.setAttribute('aria-description', t(explanation));
    this.button.title = `${t(this.darkMode ? 'PDF を元の配色に戻す' : 'PDF を暗く表示')}\n${t(explanation)}`;
  }
}

export class PDFToolbar {
  constructor({ toolbar, panel, button, compactWidth = 600, label = 'PDF の操作', moveWhenNarrow = [] }) {
    this.toolbar = toolbar; this.panel = panel; this.button = button;
    this.compactWidth = compactWidth; this.label = label;
    if (!toolbar || !panel || !button) return;
    this.homes = moveWhenNarrow.filter(item => item.element).map(item => {
      const marker = document.createComment('toolbar control'); item.element.before(marker);
      return { ...item, marker };
    });
    button.addEventListener('click', () => {
      if (panel.matches(':popover-open')) panel.hidePopover();
      else {
        panel.showPopover(); this.positionMenu();
        panel.querySelector('button:not(:disabled), select:not(:disabled), input:not(:disabled)')?.focus({ preventScroll: true });
      }
    });
    panel.addEventListener('toggle', () => {
      const open = panel.matches(':popover-open');
      button.setAttribute('aria-expanded', String(open));
      if (open) this.positionMenu();
    });
    // The search field is outside the toolbar popup. Let it receive focus as
    // soon as the search action opens the search bar.
    panel.addEventListener('click', event => {
      if (event.target.closest('.pdf-search-toggle, #download-pdf') && panel.matches(':popover-open')) panel.hidePopover();
    });
    toolbar.parentElement?.addEventListener('focusin', event => {
      if (event.target.closest('.pdf-search-bar') && panel.matches(':popover-open')) panel.hidePopover();
    });
    this.resizeObserver = new ResizeObserver(() => this.refresh());
    this.resizeObserver.observe(toolbar);
    this.unsubscribeLanguage = onLanguageChange(() => this.refreshLanguage());
    this.refreshLanguage(); this.refresh();
  }

  setLabel(label) { this.label = label; this.refreshLanguage(); }

  refreshLanguage() {
    if (!this.button) return;
    this.button.setAttribute('aria-label', t(this.label)); this.button.title = t(this.label);
  }

  refresh() {
    if (!this.toolbar || !this.panel || !this.button) return;
    const width = this.toolbar.clientWidth;
    if (!width) return;
    const compact = width < this.compactWidth;
    if (!compact && this.panel.matches(':popover-open')) this.panel.hidePopover();
    this.toolbar.dataset.pdfCompact = String(compact);
    // Leave enough space for readable status and document labels after the controls.
    this.toolbar.dataset.pdfDetails = String(width >= 760);
    this.button.hidden = !compact;
    if (compact) this.panel.setAttribute('popover', 'auto');
    else {
      this.panel.removeAttribute('popover');
      this.button.setAttribute('aria-expanded', 'false');
      this.panel.style.removeProperty('left'); this.panel.style.removeProperty('top');
    }
    for (const { element, marker, below } of [...this.homes].reverse()) {
      if (compact && width < below) this.panel.prepend(element);
      else marker.after(element);
    }
    if (this.panel.matches(':popover-open')) this.positionMenu();
  }

  positionMenu() {
    const anchor = this.button.getBoundingClientRect(), panel = this.panel.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.right - panel.width, innerWidth - panel.width - 8));
    const top = anchor.bottom + 6 + panel.height <= innerHeight - 8 ? anchor.bottom + 6 : Math.max(8, anchor.top - panel.height - 6);
    this.panel.style.left = `${left}px`; this.panel.style.top = `${top}px`;
  }
}
