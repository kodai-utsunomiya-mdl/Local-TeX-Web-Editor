import { autocompletion } from '@codemirror/autocomplete';
import { ViewPlugin, tooltips } from '@codemirror/view';

function completionSpace(view) {
  const pane = view.scrollDOM.getBoundingClientRect();
  const viewport = view.dom.ownerDocument.documentElement;
  const left = Math.max(0, pane.left) + 4;
  const right = Math.max(left + 1, Math.min(viewport.clientWidth, pane.right) - 4);
  const top = Math.max(0, pane.top) + 2;
  const bottom = Math.max(top + 1, Math.min(viewport.clientHeight, pane.bottom) - 2);
  return { left, right, top, bottom };
}

const completionSize = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    this.measure = {
      read: () => {
        const space = completionSpace(view);
        return {
          width: Math.max(1, (space.right - space.left) / view.scaleX),
          height: Math.max(1, (space.bottom - space.top) / view.scaleY),
        };
      },
      write: ({ width, height }) => {
        const menuWidth = `${Math.floor(Math.min(760, width))}px`;
        const menuHeight = `${Math.floor(Math.min(440, height * .7))}px`;
        const layout = width >= 660 ? 'columns' : 'rows';
        if (menuWidth !== this.width) view.dom.style.setProperty('--completion-menu-width', this.width = menuWidth);
        if (menuHeight !== this.height) view.dom.style.setProperty('--completion-menu-height', this.height = menuHeight);
        if (view.dom.dataset.completionLayout !== layout) view.dom.dataset.completionLayout = layout;
      },
      key: this,
    };
    view.requestMeasure(this.measure);
  }
  update(update) {
    if (update.geometryChanged || update.viewportChanged) this.view.requestMeasure(this.measure);
  }
  destroy() {
    this.view.dom.style.removeProperty('--completion-menu-width');
    this.view.dom.style.removeProperty('--completion-menu-height');
    delete this.view.dom.dataset.completionLayout;
  }
});

// Both sections participate in layout. CodeMirror can then fit the entire
// menu above or below the cursor without placing details over later options.
export function completionPresentation() {
  return [
    completionSize,
    tooltips({ tooltipSpace: completionSpace }),
    autocompletion({
      tooltipClass: () => 'tex-completion-menu',
      positionInfo: () => ({
        class: 'tex-completion-info',
        style: 'position: static; inset: auto; max-width: none;',
      }),
    }),
  ];
}
