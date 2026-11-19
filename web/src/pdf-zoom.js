// Match a PDF point before and after scaling. The preview may be nested inside
// the editor layout, so all measurements use coordinates within the window.
export function zoomPDFAt(viewer, changeScale, origin = null) {
  const container = viewer.container;
  if (!viewer.pdfDocument || !container.clientWidth || !container.clientHeight) return;
  const bounds = container.getBoundingClientRect();
  const left = bounds.left + container.clientLeft;
  const top = bounds.top + container.clientTop;
  const x = origin?.[0] ?? left + container.clientWidth / 2;
  const y = origin?.[1] ?? top + container.clientHeight / 2;
  let element = document.elementFromPoint(x, y)?.closest('.page[data-page-number]');
  if (!element || !viewer.viewer.contains(element)) {
    // In a gap or margin, use the nearest page as the reference.
    element = null;
    let distance = Infinity;
    for (const candidate of viewer.viewer.querySelectorAll('.page[data-page-number]')) {
      const rect = candidate.getBoundingClientRect();
      const next = Math.hypot(Math.max(rect.left - x, 0, x - rect.right), Math.max(rect.top - y, 0, y - rect.bottom));
      if (next < distance) { element = candidate; distance = next; }
    }
  }
  const view = element && viewer.getPageView(Number(element.dataset.pageNumber) - 1);
  const surface = element?.querySelector('.canvasWrapper') || element;
  const before = surface?.getBoundingClientRect();
  const point = viewer.currentScaleValue !== null && view && before?.width && before?.height
    ? view.viewport.convertToPdfPoint((x - before.left) * view.viewport.width / before.width, (y - before.top) * view.viewport.height / before.height)
    : null;
  changeScale();
  if (point) {
    // Page margins change when a page grows wider than the preview. Measure
    // the same PDF point after scaling so it stays under the viewing origin.
    const after = surface.getBoundingClientRect();
    const [nextX, nextY] = view.viewport.convertToViewportPoint(...point);
    const targetX = origin ? x : left + container.clientWidth / 2;
    const targetY = origin ? y : top + container.clientHeight / 2;
    container.scrollLeft += after.left + nextX * after.width / view.viewport.width - targetX;
    container.scrollTop += after.top + nextY * after.height / view.viewport.height - targetY;
  }
  viewer.update();
}
