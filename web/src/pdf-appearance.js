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
  constructor({ toolbar, panel, button, menu = panel, compactWidth = 600, label = 'PDF の操作', moveWhenNarrow = [], alwaysVisible = [] }) {
    menu ||= panel;
    this.toolbar = toolbar; this.panel = panel; this.button = button; this.menu = menu;
    this.compactWidth = compactWidth; this.label = label;
    if (!toolbar || !panel || !button) return;
    if (menu !== panel) {
      this.panelMarker = document.createComment('inline PDF controls');
      panel.before(this.panelMarker);
    }
    this.homes = moveWhenNarrow.filter(item => item.element).map(item => {
      const marker = document.createComment('toolbar control'); item.element.before(marker);
      return { ...item, marker };
    });
    this.persistent = document.createElement('div');
    this.persistent.className = 'pdf-persistent-controls';
    this.persistent.hidden = true;
    button.before(this.persistent);
    this.persistentHomes = alwaysVisible.filter(Boolean).map(element => {
      const marker = document.createComment('persistent toolbar control'); element.before(marker);
      return { element, marker };
    });
    button.popoverTargetElement = menu;
    menu.addEventListener('toggle', () => {
      const open = menu.matches(':popover-open');
      button.setAttribute('aria-expanded', String(open));
      if (open) {
        this.positionMenu();
        (menu.querySelector('button:not(:disabled), select:not(:disabled), input:not(:disabled)') || menu).focus({ preventScroll: true });
      }
    });
    // The search field is outside the toolbar popup. Let it receive focus as
    // soon as the search action opens the search bar.
    panel.addEventListener('click', event => {
      if (event.target.closest('.pdf-search-toggle, #download-pdf') && menu.matches(':popover-open')) menu.hidePopover();
    });
    toolbar.parentElement?.addEventListener('focusin', event => {
      if (event.target.closest('.pdf-search-bar') && menu.matches(':popover-open')) menu.hidePopover();
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
    this.toolbar.dataset.pdfCompact = String(compact);
    this.toolbar.dataset.pdfNarrow = String(width < 400);
    this.button.hidden = !compact && !this.panelMarker;
    if (this.panelMarker) {
      if (compact) {
        if (this.panel.parentElement !== this.menu) this.menu.append(this.panel);
      } else if (this.panel.previousSibling !== this.panelMarker) this.panelMarker.after(this.panel);
    } else if (compact) this.panel.setAttribute('popover', 'auto');
    else {
      if (this.menu.matches(':popover-open')) this.menu.hidePopover();
      this.menu.removeAttribute('popover');
      this.button.setAttribute('aria-expanded', 'false');
      this.menu.style.removeProperty('left'); this.menu.style.removeProperty('top');
    }
    for (const { element, marker, below } of [...this.homes].reverse()) {
      if (compact && width < below) this.panel.prepend(element);
      else marker.after(element);
    }
    this.persistent.hidden = !compact || !this.persistentHomes.length;
    for (const { element, marker } of this.persistentHomes) {
      if (compact) {
        if (element.parentElement !== this.persistent) this.persistent.append(element);
      } else if (element.previousSibling !== marker) marker.after(element);
    }
    if (this.menu.matches(':popover-open')) this.positionMenu();
  }

  positionMenu() {
    const anchor = this.button.getBoundingClientRect(), panel = this.menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.right - panel.width, innerWidth - panel.width - 8));
    const top = anchor.bottom + 6 + panel.height <= innerHeight - 8 ? anchor.bottom + 6 : Math.max(8, anchor.top - panel.height - 6);
    this.menu.style.left = `${left}px`; this.menu.style.top = `${top}px`;
  }
}
