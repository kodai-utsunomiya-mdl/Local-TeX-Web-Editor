import { StreamLanguage } from '@codemirror/language';
import { python } from '@codemirror/legacy-modes/mode/python';
import { javascript, typescript, json } from '@codemirror/legacy-modes/mode/javascript';
import { c, cpp, java, csharp, kotlin } from '@codemirror/legacy-modes/mode/clike';
import { go } from '@codemirror/legacy-modes/mode/go';
import { rust } from '@codemirror/legacy-modes/mode/rust';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { css, sCSS, less } from '@codemirror/legacy-modes/mode/css';
import { xml, html } from '@codemirror/legacy-modes/mode/xml';
import { yaml } from '@codemirror/legacy-modes/mode/yaml';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { r } from '@codemirror/legacy-modes/mode/r';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { standardSQL } from '@codemirror/legacy-modes/mode/sql';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { cmake } from '@codemirror/legacy-modes/mode/cmake';

const modes = { python, javascript, typescript, json, c, cpp, java, csharp, kotlin, go, rust, shell, powerShell, css, sCSS, less, xml, html, yaml, toml, r, lua, standardSQL, ruby, dockerFile, cmake };
const suffixes = {
  py: 'python', pyw: 'python', pyi: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  json: 'json', ipynb: 'json', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hh: 'cpp', hpp: 'cpp', hxx: 'cpp', java: 'java', cs: 'csharp', kt: 'kotlin', kts: 'kotlin',
  go: 'go', rs: 'rust', sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', ps1: 'powerShell', psm1: 'powerShell', css: 'css', scss: 'sCSS', less: 'less',
  xml: 'xml', html: 'html', htm: 'html', yaml: 'yaml', yml: 'yaml', toml: 'toml', r: 'r', lua: 'lua', sql: 'standardSQL', rb: 'ruby', cmake: 'cmake',
};
const languages = new Map();

export function programLanguageName(path = '') {
  const name = path.replaceAll('\\', '/').split('/').pop().toLowerCase();
  if (name === 'dockerfile') return 'dockerFile';
  if (name === 'cmakelists.txt') return 'cmake';
  return suffixes[name.split('.').pop()] || '';
}

export function programLanguage(path) {
  const name = programLanguageName(path);
  if (!name) return [];
  if (!languages.has(name)) languages.set(name, StreamLanguage.define(modes[name]));
  return languages.get(name);
}
