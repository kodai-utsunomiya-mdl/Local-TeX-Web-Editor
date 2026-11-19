export async function showPDFControls(page, kind = 'pdf') {
  const more = page.getByTestId(`${kind}-more`);
  if (await more.isVisible() && await more.getAttribute('aria-expanded') !== 'true') await more.click();
}
