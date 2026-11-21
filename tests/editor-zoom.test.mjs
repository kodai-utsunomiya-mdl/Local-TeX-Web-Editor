import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo, redo } from '@codemirror/commands';
import { attachEditorZoom, attachFontZoom, prepareEditorResize, prepareRichEditorResize } from '../web/src/editor-zoom.js';

function surface() {
  const frames = new Map(); let nextFrame = 0, time = 500;
  const window = {
    performance: { now: () => time },
    requestAnimationFrame: callback => { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
  };
  const element = new EventTarget();
  Object.assign(element, { ownerDocument: { defaultView: window }, clientHeight: 600 });
  return {
    element, frames,
    flush() { time += 16; const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(); },
    send(type, values = {}) { const event = Object.assign(new Event(type, { cancelable: true }), values); element.dispatchEvent(event); return event; },
  };
}
function zoom(surface, options = {}) {
  let size = 14;
  const calls = [];
  const stop = attachFontZoom(surface.element, { getSize: () => size,
    onSize: (value, origin) => { size = Math.round(value * 10) / 10; calls.push({ value, origin }); }, ...options });
  return { calls, stop, get size() { return size; }, set size(value) { size = value; } };
}
const points = distance => [{ clientX: 200 - distance, clientY: 250 }, { clientX: 200 + distance, clientY: 250 }];

test('Ctrl と Cmd の wheel を同じ文字サイズへ反映し，通常のスクロールには介入しない', () => {
  const events = surface(), editor = zoom(events);
  assert.equal(events.send('wheel', { deltaY: -100 }).defaultPrevented, false);
  events.flush(); assert.equal(editor.calls.length, 0);
  assert.equal(events.send('wheel', { ctrlKey: true, deltaY: -100, deltaMode: 0, clientX: 180, clientY: 220 }).defaultPrevented, true);
  events.send('wheel', { metaKey: true, deltaY: -50, deltaMode: 0, clientX: 190, clientY: 230 });
  assert.equal(events.frames.size, 1); events.flush();
  assert.equal(editor.calls.length, 1);
  assert.ok(Math.abs(editor.calls[0].value - 14 * Math.exp(.3)) < 1e-10);
  assert.deepEqual(editor.calls[0].origin, [190, 230]);
  // A second pane or the settings form can change the shared preference.
  editor.size = 24;
  events.send('wheel', { ctrlKey: true, deltaY: 1, deltaMode: 1 }); events.flush();
  assert.ok(Math.abs(editor.calls.at(-1).value - 24 * Math.exp(-.032)) < 1e-10);
  events.send('wheel', { ctrlKey: true, deltaY: 10, deltaMode: 2 }); events.flush(); assert.equal(editor.size, 8);
  events.send('wheel', { ctrlKey: true, deltaY: -10, deltaMode: 2 }); events.flush(); assert.equal(editor.size, 40);
  editor.stop();
});

test('IME 中の wheel とピンチではブラウザの拡大を止め，保留中の文字サイズも適用しない', () => {
  const events = surface(); let composing = false, active = true;
  const editor = zoom(events, { isComposing: () => composing, isActive: () => active });
  events.send('wheel', { ctrlKey: true, deltaY: -100 }); composing = true; events.flush();
  assert.equal(editor.calls.length, 0);
  for (const [type, values] of [
    ['wheel', { metaKey: true, deltaY: -100 }],
    ['touchstart', { touches: points(20) }], ['touchmove', { touches: points(40) }],
    ['gesturestart', {}], ['gesturechange', { scale: 2 }],
  ]) assert.equal(events.send(type, values).defaultPrevented, true, type);
  events.flush(); assert.equal(editor.calls.length, 0);
  composing = false;
  events.send('wheel', { ctrlKey: true, deltaY: -1, deltaMode: 0 }); events.flush();
  assert.ok(Math.abs(editor.calls[0].value - 14 * Math.exp(.002)) < 1e-10);
  active = false;
  assert.equal(events.send('wheel', { ctrlKey: true, deltaY: -100 }).defaultPrevented, false);
  events.flush(); assert.equal(editor.calls.length, 1);
  editor.stop();
});

test('CodeMirror が IME を開始した直後から，入力終了まで両方のペインの拡大を待つ', () => {
  const source = surface(), rich = surface(); let size = 14;
  const view = { scrollDOM: source.element, inputState: { composing: -1 }, state: EditorState.create({ doc: '日本語の本文' }) };
  for (const property of ['composing', 'compositionStarted']) {
    Object.defineProperty(view, property, Object.getOwnPropertyDescriptor(EditorView.prototype, property));
  }
  const state = view.state, calls = [];
  const options = { getSize: () => size, onSize: value => { size = value; calls.push(value); } };
  const stopSource = attachEditorZoom(view, options);
  const stopRich = attachFontZoom(rich.element, { ...options, isComposing: () => view.compositionStarted });
  // CodeMirror uses 0 after compositionstart and a positive value once the
  // composition has changed the document. Its composing getter covers only
  // the latter; compositionStarted covers the full input session.
  for (const phase of [0, 1]) {
    view.inputState.composing = phase;
    assert.equal(view.composing, phase > 0); assert.equal(view.compositionStarted, true);
    for (const events of [source, rich]) {
      assert.equal(events.send('wheel', { ctrlKey: true, deltaY: -100, deltaMode: 0 }).defaultPrevented, true);
      events.flush();
    }
    assert.equal(size, 14); assert.equal(calls.length, 0);
  }
  view.inputState.composing = -1;
  assert.equal(view.compositionStarted, false);
  for (const events of [source, rich]) {
    const before = size;
    events.send('wheel', { ctrlKey: true, deltaY: -10, deltaMode: 0 }); events.flush();
    assert.ok(size > before);
  }
  assert.equal(calls.length, 2); assert.equal(view.state, state);
  stopSource(); stopRich();
});

test('ソースのピンチで最初の選択範囲へ戻し，本文と Undo と Redo をそのまま使う', () => {
  const events = surface(); let size = 14;
  const view = { scrollDOM: events.element, composing: false,
    state: EditorState.create({ doc: 'alpha\nbeta', extensions: [history()] }),
    dispatch(transaction) { this.state = transaction.state || this.state.update(transaction).state; } };
  view.dispatch({ changes: { from: 5, insert: ' added' }, selection: { anchor: 1, head: 4 }, userEvent: 'input.type' });
  const text = view.state.doc.toString(), selection = view.state.selection;
  const stop = attachEditorZoom(view, { getSize: () => size, onSize: value => { size = value; } });
  events.send('touchstart', { touches: points(20).slice(0, 1) });
  view.dispatch({ selection: { anchor: 0 } });
  events.send('touchstart', { touches: points(20) });
  assert.ok(view.state.selection.eq(selection));
  events.send('touchmove', { touches: points(30) }); events.flush();
  events.send('touchend', { touches: [] });
  assert.equal(size, 21); assert.equal(view.state.doc.toString(), text); assert.ok(view.state.selection.eq(selection));
  assert.equal(undo({ state: view.state, dispatch: transaction => view.dispatch(transaction) }), true);
  assert.equal(view.state.doc.toString(), 'alpha\nbeta');
  assert.equal(redo({ state: view.state, dispatch: transaction => view.dispatch(transaction) }), true);
  assert.equal(view.state.doc.toString(), text);
  stop();
});

test('Safari の scale を使い，タッチと重なるイベントや破棄後の更新を適用しない', () => {
  const events = surface(), editor = zoom(events);
  events.send('gesturestart');
  events.send('gesturechange', { scale: 1.5, clientX: 180, clientY: 250 }); events.flush();
  assert.equal(editor.size, 21); assert.deepEqual(editor.calls[0].origin, [180, 250]);
  events.send('wheel', { ctrlKey: true, deltaY: -100 }); events.flush(); assert.equal(editor.calls.length, 1);
  events.send('gesturechange', { scale: NaN }); events.flush(); assert.equal(editor.calls.length, 1);
  events.send('gestureend');
  events.send('touchstart', { touches: points(20) });
  events.send('gesturestart'); events.send('gesturechange', { scale: 3 });
  events.send('touchmove', { touches: points(10) }); events.flush();
  assert.equal(editor.size, 10.5);
  events.send('touchend', { touches: [] }); events.send('gestureend');
  events.send('wheel', { ctrlKey: true, deltaY: -100 });
  editor.stop(); events.flush(); assert.equal(editor.calls.length, 2);
  assert.equal(events.send('wheel', { ctrlKey: true, deltaY: -100 }).defaultPrevented, false);
});

test('どちらのエディタでも操作位置の本文へスクロールを合わせ，差し替えた文書には適用しない', async () => {
  for (const rich of [false, true]) {
    const bounds = { left: 10, right: 610, top: 20, bottom: 620, width: 600, height: 600 };
    const scroll = { clientHeight: 600, scrollTop: 120, scrollLeft: 10, getBoundingClientRect: () => bounds };
    const layout = { top: 300, left: 100 };
    let measurement, requested;
    const view = { dom: { isConnected: true, getBoundingClientRect: () => bounds }, scrollDOM: scroll, state: { doc: {} },
      posAtCoords: point => { requested = point; return rich ? { pos: 25 } : 25; },
      coordsAtPos: position => { assert.equal(position, 25); return { top: layout.top - scroll.scrollTop, left: layout.left - scroll.scrollLeft }; },
      requestMeasure: value => { measurement = value; } };
    const prepare = () => rich ? prepareRichEditorResize(view, scroll, [150, 220]) : prepareEditorResize(view, [150, 220]);
    const run = async apply => { apply(); if (measurement) { const value = measurement.read(); measurement.write(value); measurement = null; } await Promise.resolve(); };
    const restore = prepare();
    assert.deepEqual(requested, rich ? { left: 150, top: 220 } : { x: 150, y: 220 });
    layout.top += 145; layout.left += 15; await run(restore);
    assert.equal(scroll.scrollTop, 265); assert.equal(scroll.scrollLeft, 25);
    const old = prepare(); view.state.doc = {}; layout.top += 100; await run(old);
    assert.equal(scroll.scrollTop, 265);
  }
});

test('CodeMirror 自身が行の高さを補正した後に，折り返しを含む本文の座標を合わせる', async t => {
  const originalWindow = globalThis.Window;
  globalThis.Window ??= class Window {};
  t.after(() => { if (originalWindow === undefined) delete globalThis.Window; else globalThis.Window = originalWindow; });
  const noop = () => {};
  for (const [lineDelta, characterDelta] of [[349.65625, 349.65625], [349.65625, 393.65625], [-220.25, -264.25]]) {
    let anchorHeight = 900, characterHeight = 960, changed = true;
    const bounds = { left: 0, right: 500, top: 0, bottom: 600, width: 500, height: 600 };
    const scroll = { scrollTop: 900, scrollLeft: 0, scrollHeight: 20000, clientHeight: 600, getBoundingClientRect: () => bounds };
    // Use CodeMirror's actual measurement loop so its scroll adjustment runs
    // after our request's write callback, as it does with the browser layout.
    const view = {
      state: EditorState.create({ doc: 'text' }), destroyed: false, measureScheduled: -1, measureRequests: [], updateState: 0,
      win: { requestAnimationFrame: () => 1, cancelAnimationFrame: noop }, observer: { forceFlush: noop }, scrollDOM: scroll,
      dom: { isConnected: true }, posAtCoords: () => 0, coordsAtPos: () => ({ top: characterHeight - scroll.scrollTop, left: 0 }),
      inputState: { update: noop }, updatePlugins: noop, updateAttrs: noop, docView: { update: () => false }, hasFocus: true,
      requestMeasure(request) { this.measureRequests.push(request); },
      viewState: {
        scrollParent: scroll, scrollOffset: 900, scrollAnchorPos: 0, scrollAnchorHeight: 900, scaleY: 1,
        scrollTarget: null, editorHeight: 600, heightMap: { height: 20000 }, getScrollOffset: () => scroll.scrollTop,
        scrollAnchorAt: () => ({ from: 0, top: anchorHeight }), lineBlockAt: () => ({ from: 0, top: anchorHeight }),
        measure: () => { if (changed) { changed = false; return 2; } return 0; },
      },
    };
    const state = view.state, before = view.coordsAtPos(0).top;
    const restore = prepareEditorResize(view, [100, 60]);
    anchorHeight += lineDelta; characterHeight += characterDelta; restore();
    EditorView.prototype.measure.call(view);
    await Promise.resolve();
    assert.equal(view.coordsAtPos(0).top, before);
    assert.equal(scroll.scrollTop, 900 + characterDelta);
    assert.equal(view.state, state);
  }
});

test('measure 後に文書や表示状態が変わった場合と，次のサイズ変更が始まった場合は古い補正を使わない', async () => {
  const bounds = { left: 0, right: 500, top: 0, bottom: 600, width: 500, height: 600 };
  for (const change of ['document', 'hidden', 'disconnected', 'resize']) {
    let height = 960, measurement;
    const scroll = { scrollTop: 900, scrollLeft: 0, clientHeight: 600, getBoundingClientRect: () => bounds };
    const view = { dom: { isConnected: true }, scrollDOM: scroll, state: { doc: {} }, posAtCoords: () => 0,
      coordsAtPos: () => ({ top: height - scroll.scrollTop, left: 0 }), requestMeasure: request => { measurement = request; } };
    const restore = prepareEditorResize(view); height += 300; restore();
    measurement.write(measurement.read());
    if (change === 'document') view.state.doc = {};
    if (change === 'hidden') scroll.clientHeight = 0;
    if (change === 'disconnected') view.dom.isConnected = false;
    if (change === 'resize') prepareEditorResize(view);
    await Promise.resolve();
    assert.equal(scroll.scrollTop, 900, change);
  }
});
