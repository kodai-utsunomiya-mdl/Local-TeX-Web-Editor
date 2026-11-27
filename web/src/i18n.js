import { english } from './locales/en.js';
import { importsEnglish } from './locales/imports-en.js';
import { writingEnglish } from './locales/writing-en.js';
import { markdownEditingEnglish } from './locales/markdown-editing-en.js';
import { markdownRichEnglish } from './locales/markdown-rich-en.js';
import { projectHomeEnglish } from './locales/project-home-en.js';
import { pdfAppearanceEnglish } from './locales/pdf-appearance-en.js';
import { outlineEnglish } from './locales/outline-en.js';
import { documentToolsEnglish } from './locales/document-tools-en.js';
import { fileSortingEnglish } from './locales/file-sorting-en.js';
import { fileTreeDragEnglish } from './locales/file-tree-drag-en.js';
import { fileTemplateEnglish } from './locales/file-template-en.js';
import { editorContextMenuEnglish } from './locales/editor-context-menu-en.js';
import { compiledPDFsEnglish } from './locales/compiled-pdfs-en.js';
import { projectSyncEnglish } from './locales/project-sync-en.js';
import { texSetupEnglish } from './locales/tex-setup-en.js';
import { texManagementEnglish } from './locales/tex-management-en.js';
import { settingsResetEnglish } from './locales/settings-reset-en.js';
import { startupEnglish } from './locales/startup-en.js';
import { applicationUpdatesEnglish } from './locales/application-updates-en.js';
import { projectZIPEnglish } from './locales/project-zip-en.js';
import { shortcutModifier } from './platform-keys.js';

Object.assign(english, importsEnglish, writingEnglish, markdownEditingEnglish, markdownRichEnglish, projectHomeEnglish, pdfAppearanceEnglish, outlineEnglish, documentToolsEnglish, fileSortingEnglish, fileTreeDragEnglish, editorContextMenuEnglish, compiledPDFsEnglish);

Object.assign(english, fileTemplateEnglish);
Object.assign(english, projectSyncEnglish);
Object.assign(english, texSetupEnglish);
Object.assign(english, texManagementEnglish);
Object.assign(english, settingsResetEnglish);
Object.assign(english, startupEnglish);
Object.assign(english, applicationUpdatesEnglish);
Object.assign(english, projectZIPEnglish);

let language = 'en';
const listeners = new Set();
export const getLanguage = () => language;

// Japanese source messages are the catalog keys, so untranslated additions are
// readable. Values are inserted after lookup and never used as translation keys.
export function t(key, values = {}) {
  const template = language === 'en' ? english[key] ?? key : key;
  const replacements = { modifier: shortcutModifier, ...values };
  return template.replace(/\{([A-Za-z][\w]*)\}/g, (match, name) =>
    Object.hasOwn(replacements, name) ? String(replacements[name]) : match);
}

export function translateElements(root = globalThis.document) {
  if (!root) return;
  for (const node of root.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const attribute of ['title', 'placeholder', 'aria-label', 'aria-description']) {
    for (const node of root.querySelectorAll(`[data-i18n-${attribute}]`)) {
      node.setAttribute(attribute, t(node.getAttribute(`data-i18n-${attribute}`)));
    }
  }
}

export function setLanguage(value) {
  language = value === 'ja' ? 'ja' : 'en';
  if (globalThis.document) {
    document.documentElement.lang = language;
    translateElements(document);
  }
  for (const listener of listeners) listener(language);
  return language;
}

export function onLanguageChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
