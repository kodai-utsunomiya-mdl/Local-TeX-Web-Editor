import { expect } from '@playwright/test';

async function setTheme(page, theme) {
  const button = page.getByTestId('theme-toggle');
  if (await button.getAttribute('aria-pressed') !== String(theme === 'dark')) await button.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

function inset(rect, maxWidth = 200) {
  return {
    x: Math.ceil(rect.x + 3), y: Math.ceil(rect.y + 1),
    width: Math.floor(Math.min(rect.width - 6, maxWidth)), height: Math.floor(rect.height - 2),
  };
}

async function changedPixels(page, before, after) {
  return page.evaluate(async images => {
    const pixels = await Promise.all(images.map(async image => {
      const bytes = Uint8Array.from(atob(image), character => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0); bitmap.close();
      return context.getImageData(0, 0, canvas.width, canvas.height).data;
    }));
    if (pixels[0].length !== pixels[1].length) throw new Error('The compared pictures must have the same size.');
    let changed = 0;
    for (let index = 0; index < pixels[0].length; index += 4) {
      const difference = Math.abs(pixels[0][index] - pixels[1][index]) +
        Math.abs(pixels[0][index + 1] - pixels[1][index + 1]) + Math.abs(pixels[0][index + 2] - pixels[1][index + 2]);
      if (difference >= 24) ++changed;
    }
    return changed / (pixels[0].length / 4);
  }, [before.toString('base64'), after.toString('base64')]);
}

// Run after opening the fixture's main.tex. Compare the painted pixels, because
// a selection element may exist and have a color while an opaque line covers it.
export async function checkEditorSelectionVisibility(page, testInfo) {
  const originalTheme = await page.locator('html').getAttribute('data-theme');
  const content = page.getByTestId('editor').locator('.cm-content');
  const selection = page.locator('#editor .cm-selectionBackground');
  for (const theme of ['light', 'dark']) {
    await setTheme(page, theme);
    await content.click(); await page.keyboard.press('Control+Home'); await page.keyboard.press('Shift+End');
    await expect(selection.first()).toBeVisible();
    const clip = inset(await selection.first().boundingBox());
    expect(clip.width).toBeGreaterThan(20); expect(clip.height).toBeGreaterThan(5);
    const focused = await page.screenshot({ clip });
    await page.locator('#file-filter').focus();
    await expect(content).not.toBeFocused();
    await expect(selection.first()).toBeVisible();
    const blurred = await page.screenshot({ clip });
    await content.focus(); await page.keyboard.press('ArrowLeft');
    await expect(selection).toHaveCount(0);
    const plain = await page.screenshot({ clip });
    expect(await changedPixels(page, plain, focused), `${theme}: a focused selection must be visible on the active line`).toBeGreaterThan(0.45);
    expect(await changedPixels(page, plain, blurred), `${theme}: a selection must remain visible after moving focus`).toBeGreaterThan(0.45);

    // A mouse drag uses the same selection painting as keyboard selection.
    const line = await content.locator('.cm-line').first().boundingBox();
    await page.mouse.move(line.x + 18, line.y + line.height / 2); await page.mouse.down();
    await page.mouse.move(line.x + 145, line.y + line.height / 2, { steps: 10 }); await page.mouse.up();
    await expect(selection.first()).toBeVisible();
    if (testInfo) await page.screenshot({ path: testInfo.outputPath(`editor-selection-${theme}.png`) });
    await page.keyboard.press('ArrowLeft');

    await page.keyboard.press('Control+Home'); await page.keyboard.press('Shift+ArrowDown'); await page.keyboard.press('Shift+ArrowDown');
    await expect.poll(() => selection.count()).toBeGreaterThan(1);
    await page.keyboard.press('ArrowLeft');
  }
  await setTheme(page, originalTheme || 'light');
}

// Run after a PDF with text has finished rendering. This also covers PDF.js's
// custom selection layer, whose native ::selection background is transparent.
export async function checkPDFSelectionVisibility(page, testInfo) {
  const originalTheme = await page.locator('html').getAttribute('data-theme');
  await page.getByTestId('pdf-page').fill('1'); await page.getByTestId('pdf-page').press('Enter');
  const layer = page.locator('#pdf-stage .page[data-page-number="1"] .textLayer');
  await expect(layer).toBeVisible();
  await expect.poll(() => layer.locator('span').count()).toBeGreaterThan(0);
  for (const theme of ['light', 'dark']) {
    await setTheme(page, theme);
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    const rectangle = await layer.evaluate(element => {
      const scroll = element.closest('.pdf-scroll').getBoundingClientRect();
      for (const span of element.querySelectorAll('span:not(.markedContent)')) {
        const rect = span.getBoundingClientRect();
        if ((span.textContent || '').trim().length < 8 || rect.width < 60 || rect.height < 10) continue;
        if (rect.left < scroll.left + 4 || rect.right > scroll.right - 4 || rect.top < scroll.top + 4 || rect.bottom > scroll.bottom - 4) continue;
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }
      return null;
    });
    expect(rectangle, 'The PDF needs a visible line of text for the selection test.').toBeTruthy();
    const clip = inset(rectangle);
    const plain = await page.screenshot({ clip });
    const middle = rectangle.y + rectangle.height / 2;
    await page.mouse.move(rectangle.x + 1, middle); await page.mouse.down();
    await page.mouse.move(rectangle.x + rectangle.width - 1, middle, { steps: 12 }); await page.mouse.up();
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString().trim().length || 0)).toBeGreaterThan(0);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const selected = await page.screenshot({ clip });
    expect(await changedPixels(page, plain, selected), `${theme}: selecting PDF text must change its background`).toBeGreaterThan(0.3);
    if (testInfo) await page.screenshot({ path: testInfo.outputPath(`pdf-selection-${theme}.png`) });
  }
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await setTheme(page, originalTheme || 'light');
}
