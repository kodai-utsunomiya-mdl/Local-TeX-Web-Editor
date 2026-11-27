// Set the theme before stylesheets and the editor bundle load.
(() => {
  let mode = 'dark';
  try {
    const saved = JSON.parse(localStorage.getItem('local-tex-editor-appearance') || 'null');
    const legacy = localStorage.getItem('local-tex-editor-theme');
    mode = ['light', 'dark', 'system'].includes(saved?.mode) ? saved.mode : ['light', 'dark'].includes(legacy) ? legacy : 'dark';
  } catch { /* Use the initial theme when browser storage is unavailable. */ }
  const theme = mode === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' : mode;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
})();
