// Store positions at deliberate jumps. A document's text belongs to its editor
// and file history; navigation only needs the small view state supplied by it.
const copy = value => value == null ? null : structuredClone(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export class NavigationHistory {
  constructor({ capture, restore, onChange = () => {}, limit = 100 }) {
    this.capture = capture;
    this.restore = restore;
    this.onChange = onChange;
    this.limit = Math.min(200, Math.max(1, Number(limit) || 100));
    this.previous = [];
    this.next = [];
    this.restoring = false;
    this.depth = 0;
    this.generation = 0;
    this.origin = null;
  }

  get busy() { return this.restoring || this.depth > 0; }
  get canBack() { return !this.busy && this.previous.length > 0; }
  get canForward() { return !this.busy && this.next.length > 0; }
  changed() { this.onChange({ canBack: this.canBack, canForward: this.canForward, busy: this.busy }); }

  clear() {
    this.generation++;
    this.previous.length = this.next.length = 0;
    this.origin = null;
    this.changed();
  }

  mapEntries(mapper) {
    this.previous = this.previous.map(entry => mapper(copy(entry))).filter(Boolean);
    this.next = this.next.map(entry => mapper(copy(entry))).filter(Boolean);
    if (this.origin) this.origin = mapper(copy(this.origin));
    this.changed();
  }

  async navigate(action) {
    if (this.restoring) return action();
    const generation = this.generation;
    if (this.depth++ === 0) this.origin = copy(this.capture());
    this.changed();
    try {
      return await action();
    } finally {
      if (--this.depth === 0) {
        const before = this.origin;
        this.origin = null;
        const after = copy(this.capture());
        if (generation === this.generation && before && after && !equal(before, after)) {
          if (!equal(this.previous.at(-1), before)) this.previous.push(before);
          if (this.previous.length > this.limit) this.previous.splice(0, this.previous.length - this.limit);
          this.next.length = 0;
        }
        this.changed();
      }
    }
  }

  back() { return this.travel(this.previous, this.next); }
  forward() { return this.travel(this.next, this.previous); }

  async travel(from, to) {
    if (this.busy || !from.length) return false;
    const generation = this.generation;
    const current = copy(this.capture());
    const destination = from.at(-1);
    this.restoring = true;
    this.changed();
    try {
      const restored = await this.restore(copy(destination));
      if (restored === false || generation !== this.generation) return false;
      from.pop();
      if (current && !equal(current, destination)) to.push(current);
      if (to.length > this.limit) to.splice(0, to.length - this.limit);
      return true;
    } finally {
      this.restoring = false;
      this.changed();
    }
  }
}

export const afterNavigationFrame = () => new Promise(resolve => {
  if (typeof requestAnimationFrame !== 'function') { resolve(); return; }
  requestAnimationFrame(() => requestAnimationFrame(resolve));
});

// Link destinations can resolve asynchronously through the PDF document. Keep
// the previous position until that resolution and the resulting layout finish.
export function connectPDFNavigation(linkService, navigate, settle = afterNavigationFrame) {
  for (const name of ['goToDestination', 'goToPage', 'setHash', 'executeNamedAction']) {
    const original = linkService[name].bind(linkService);
    linkService[name] = (...args) => {
      const action = async () => {
        const result = await original(...args);
        await settle();
        return result;
      };
      return navigate ? navigate(action) : action();
    };
  }
}
