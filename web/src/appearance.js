const palettes = {
  default: {
    light: { background: '#f4f6f8', surface: '#ffffff', text: '#253342', secondary: '#526273', muted: '#627283', subtle: '#f6f8fa', hover: '#e9eef2', border: '#dce3e9', 'border-strong': '#bbc7d1', 'input-surface': '#ffffff', 'preview-surface': '#e9edf1', gutter: '#8998a6', 'code-surface': '#f3f6f8' },
    dark: { background: '#131c25', surface: '#1b2632', text: '#d9e3ec', secondary: '#a7bacb', muted: '#8fa2b4', subtle: '#17222d', hover: '#283848', border: '#344657', 'border-strong': '#50667b', 'input-surface': '#141f29', 'preview-surface': '#101922', gutter: '#7a91a5', 'code-surface': '#141f29' },
  },
  gray: {
    light: { background: '#f2f3f5', surface: '#ffffff', text: '#292b30', secondary: '#575b63', muted: '#6d717a', subtle: '#f6f6f7', hover: '#e8eaee', border: '#dddfe4', 'border-strong': '#b9bdc6', 'input-surface': '#ffffff', 'preview-surface': '#e6e7eb', gutter: '#858995', 'code-surface': '#f3f3f5' },
    dark: { background: '#18191c', surface: '#212226', text: '#e5e6e9', secondary: '#b8bbc2', muted: '#a0a4ae', subtle: '#1b1c20', hover: '#303237', border: '#41434b', 'border-strong': '#61656f', 'input-surface': '#191a1e', 'preview-surface': '#141518', gutter: '#858b99', 'code-surface': '#1a1b1f' },
  },
  warm: {
    light: { background: '#f4eee4', surface: '#fffaf2', text: '#3e352b', secondary: '#695d4d', muted: '#786b5b', subtle: '#f6efe3', hover: '#eee3d1', border: '#ded2bf', 'border-strong': '#b8a88f', 'input-surface': '#fffdf8', 'preview-surface': '#e9dfcf', gutter: '#8b7961', 'code-surface': '#f3eadb' },
    dark: { background: '#201d19', surface: '#29241f', text: '#ede3d6', secondary: '#c7b8a2', muted: '#b3a18c', subtle: '#231f1b', hover: '#3d342b', border: '#4c4034', 'border-strong': '#75604c', 'input-surface': '#201c18', 'preview-surface': '#1b1815', gutter: '#a38b70', 'code-surface': '#221d18' },
  },
};

const accents = {
  teal: {
    light: { accent: '#0d766e', 'accent-button': '#0d766e', 'accent-dark': '#095a54', 'accent-soft': '#e8f3f0', selection: '#bce0d8' },
    dark: { accent: '#59c9b6', 'accent-button': '#12796e', 'accent-dark': '#0f6a61', 'accent-soft': '#173f39', selection: '#255b52' },
  },
  blue: {
    light: { accent: '#2463b7', 'accent-button': '#2463b7', 'accent-dark': '#1c4f94', 'accent-soft': '#eaf2ff', selection: '#bdd7fa' },
    dark: { accent: '#83b5ff', 'accent-button': '#2c62b1', 'accent-dark': '#245394', 'accent-soft': '#1f3558', selection: '#2e5080' },
  },
  purple: {
    light: { accent: '#7651b5', 'accent-button': '#7651b5', 'accent-dark': '#603e99', 'accent-soft': '#f2edfb', selection: '#d8c8ee' },
    dark: { accent: '#bb9cf0', 'accent-button': '#7451ae', 'accent-dark': '#634393', 'accent-soft': '#342644', selection: '#4c356b' },
  },
  orange: {
    light: { accent: '#995313', 'accent-button': '#995313', 'accent-dark': '#7e420a', 'accent-soft': '#fff1de', selection: '#f3d4a8' },
    dark: { accent: '#efb06e', 'accent-button': '#945112', 'accent-dark': '#7e430d', 'accent-soft': '#472e1d', selection: '#6a4225' },
  },
  gray: {
    light: { accent: '#5c626b', 'accent-button': '#5c626b', 'accent-dark': '#454b54', 'accent-soft': '#edeef1', selection: '#cdd1d8' },
    dark: { accent: '#c0c5ce', 'accent-button': '#59616d', 'accent-dark': '#4a515c', 'accent-soft': '#303741', selection: '#464f5c' },
  },
};

const fallbackFonts = 'Consolas, Menlo, "DejaVu Sans Mono", monospace';
const fonts = {
  default: `"Cascadia Code", ${fallbackFonts}`,
  cascadia: `"Cascadia Code", ${fallbackFonts}`,
  consolas: 'Consolas, "Cascadia Code", Menlo, "DejaVu Sans Mono", monospace',
  menlo: 'Menlo, "Cascadia Code", Consolas, "DejaVu Sans Mono", monospace',
  monospace: 'ui-monospace, monospace',
};

const has = (object, key) => Object.hasOwn(object, key);

export function normalizeAppearance(value, legacyTheme = null) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    mode: ['system', 'light', 'dark'].includes(source.mode) ? source.mode : ['light', 'dark'].includes(legacyTheme) ? legacyTheme : 'system',
    palette: has(palettes, source.palette) ? source.palette : 'default',
    accent: has(accents, source.accent) ? source.accent : 'teal',
    editorFont: has(fonts, source.editorFont) ? source.editorFont : 'default',
  };
}

export function resolveAppearance(value, systemDark = false) {
  const appearance = normalizeAppearance(value);
  const theme = appearance.mode === 'system' ? systemDark ? 'dark' : 'light' : appearance.mode;
  const colors = { ...palettes[appearance.palette][theme], ...accents[appearance.accent][theme] };
  colors['line-highlight'] = colors.accent + (theme === 'dark' ? '14' : '0d');
  return { ...appearance, theme, colors, fontFamily: fonts[appearance.editorFont] };
}
