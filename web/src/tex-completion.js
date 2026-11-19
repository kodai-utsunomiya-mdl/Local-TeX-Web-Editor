import { snippet } from '@codemirror/autocomplete';
import { getLanguage } from './i18n.js';
import { maskNonCode, texCompletionSource } from './tex-tools.js';

// CodeMirror removes a backslash before a brace. Add one for TeX's literal
// delimiters and for text that would otherwise introduce a snippet field.
const literal = value => String(value).replace(/([\\#$])([{}])/g, (_, prefix, brace) => prefix + '\\' + brace);
const field = (number, value = '') => '#{' + number + (value ? ':' + value : '') + '}';
const group = value => literal('{') + value + literal('}');
const finish = field(0);
const languageText = value => Array.isArray(value) ? value[getLanguage() === 'ja' ? 0 : 1] : value;
const command = name => literal('\\' + name);
const commands = [];
const environments = [];

function addCommand(name, template, description, groups = 0, boost = 0, packageName = '') {
  commands.push({ name, template: template + finish, description, groups, boost, packageName });
}
function addArguments(name, defaults, description, packageName = '') {
  addCommand(name, command(name) + defaults.map((value, index) => group(field(index + 1, value))).join(''), description, defaults.length, 0, packageName);
}
function addEnvironment(name, body = '\t' + field(1), description = ['環境', 'Environment'], opening = '', packageName = '') {
  environments.push({ name, body, opening, description, packageName });
}

addArguments('begin', [''], ['環境の開始', 'Begin an environment']);
commands.at(-1).boost = 20;
addArguments('end', [''], ['環境の終了', 'End an environment']);
for (const [name, value, ja, en] of [
  ['documentclass', 'article', '文書クラス', 'Document class'], ['usepackage', '', 'パッケージ', 'Package'],
  ['input', '', '別の原稿を読み込む', 'Read another source file'], ['include', '', '章を読み込む', 'Include a chapter'],
  ['includeonly', '', '読み込む章を指定', 'Choose included chapters'], ['title', '', '題名', 'Title'], ['author', '', '著者', 'Author'], ['date', '', '日付', 'Date'],
  ['bibliography', '', '文献データベース', 'Bibliography database'], ['bibliographystyle', 'plain', '文献の書式', 'Bibliography style'],
  ['addbibresource', '', '文献データベース', 'Bibliography resource'], ['url', '', 'URL', 'URL'],
  ['label', '', 'ラベル', 'Label'], ['footnote', '', '脚注', 'Footnote'], ['footnotetext', '', '脚注の本文', 'Footnote text'], ['marginpar', '', '欄外の注記', 'Margin note'],
  ['caption', '', '図表の説明', 'Caption'], ['caption*', '', '番号を付けない説明', 'Unnumbered caption'],
]) addArguments(name, [value], [ja, en]);
for (const name of ['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph']) {
  addArguments(name, [''], ['見出し', 'Heading']);
  addArguments(name + '*', [''], ['番号を付けない見出し', 'Unnumbered heading']);
}
for (const name of ['textbf', 'textit', 'textmd', 'textup', 'textsl', 'textsc', 'textrm', 'textsf', 'texttt', 'textnormal', 'emph', 'underline']) addArguments(name, [''], ['文字の装飾', 'Text formatting']);
for (const name of ['ref', 'eqref', 'pageref', 'autoref', 'nameref', 'cref', 'Cref', 'cpageref', 'Cpageref', 'vref', 'vpageref']) addArguments(name, [''], ['ラベルを参照', 'Reference a label']);
for (const name of ['cite', 'citep', 'citet', 'citeauthor', 'citeyear', 'parencite', 'textcite', 'autocite', 'footcite', 'fullcite', 'nocite']) addArguments(name, [''], ['文献を引用', 'Cite a bibliography entry']);
addArguments('href', ['', ''], ['リンク先と表示する文字', 'Link destination and text'], 'hyperref');
addCommand('includegraphics', command('includegraphics') + '[width=' + field(1, '\\linewidth') + ']' + group(field(2)), ['画像を挿入', 'Insert an image'], 2, 0, 'graphicx');
addCommand('graphicspath', command('graphicspath') + group(group(field(1, 'figures/'))), ['画像のフォルダー', 'Image folders'], 1, 0, 'graphicx');
addCommand('item', command('item') + ' ' + field(1), ['リストの項目', 'List item']);
for (const name of ['maketitle', 'tableofcontents', 'listoffigures', 'listoftables', 'appendix', 'newpage', 'clearpage', 'pagebreak', 'linebreak', 'noindent', 'centering', 'raggedright', 'raggedleft', 'hfill', 'vfill', 'smallskip', 'medskip', 'bigskip', 'today', 'printbibliography', 'hline', 'toprule', 'midrule', 'bottomrule']) addCommand(name, command(name), ['文書の体裁', 'Document formatting']);
for (const name of ['newcommand', 'renewcommand', 'providecommand']) addCommand(name, command(name) + group(command('') + field(1, 'name')) + '[' + field(2, '1') + ']' + group(field(3)), ['コマンドを定義', 'Define a command'], 3);
addArguments('newenvironment', ['name', '', ''], ['環境を定義', 'Define an environment']);
addArguments('newtheorem', ['theorem', 'Theorem'], ['定理の環境を定義', 'Define a theorem environment']);
addCommand('DeclareMathOperator', command('DeclareMathOperator') + group(command('') + field(1, 'name')) + group(field(2)), ['数式の演算子を定義', 'Define a math operator'], 2, 0, 'amsmath');
addArguments('setlength', ['\\parindent', '0pt'], ['長さを設定', 'Set a length']);
addArguments('hspace', ['1em'], ['横の空き', 'Horizontal space']);
addArguments('vspace', ['1em'], ['縦の空き', 'Vertical space']);

for (const name of ['frac', 'dfrac', 'tfrac', 'cfrac', 'binom', 'dbinom', 'tbinom']) addArguments(name, ['', ''], [name.includes('frac') ? '分子と分母' : '二項係数', name.includes('frac') ? 'Numerator and denominator' : 'Binomial coefficient'], name === 'frac' ? '' : 'amsmath');
addArguments('sqrt', [''], ['平方根', 'Square root']);
addCommand('sqrt[n]', command('sqrt') + '[' + field(1, 'n') + ']' + group(field(2)), ['根の次数を指定', 'Root with an index'], 2);
for (const name of ['sum', 'prod', 'coprod', 'bigcup', 'bigcap', 'bigwedge', 'bigvee']) addCommand(name, command(name) + '_' + group(field(1, 'i=1')) + '^' + group(field(2, 'n')) + ' ' + field(3), ['範囲を指定する演算子', 'Operator with limits']);
for (const name of ['int', 'iint', 'iiint', 'oint']) addCommand(name, command(name) + '_' + group(field(1, 'a')) + '^' + group(field(2, 'b')) + ' ' + field(3), ['積分の範囲と式', 'Integration limits and expression'], 0, 0, name === 'int' || name === 'oint' ? '' : 'amsmath');
for (const name of ['lim', 'limsup', 'liminf', 'sup', 'inf', 'max', 'min']) addCommand(name, command(name) + '_' + group(field(1)) + ' ' + field(2), ['条件と式', 'Condition and expression']);
for (const name of ['mathrm', 'mathbf', 'mathit', 'mathsf', 'mathtt', 'mathnormal', 'mathcal', 'mathbb', 'mathfrak', 'mathscr', 'boldsymbol', 'bm', 'operatorname', 'text', 'overline', 'hat', 'widehat', 'bar', 'tilde', 'widetilde', 'vec', 'dot', 'ddot']) addArguments(name, [''], ['数式の文字と装飾', 'Math text and formatting'], /^(mathbb|mathfrak)$/.test(name) ? 'amsfonts' : name === 'mathscr' ? 'mathrsfs' : name === 'bm' ? 'bm' : /^(text|operatorname|boldsymbol)$/.test(name) ? 'amsmath' : '');
for (const name of ['overset', 'underset', 'stackrel']) addArguments(name, ['', ''], ['上下に付ける式', 'Expression above or below']);
addCommand('overbrace', command('overbrace') + group(field(1)) + '^' + group(field(2)), ['上の波括弧', 'Brace above'], 1);
addCommand('underbrace', command('underbrace') + group(field(1)) + '_' + group(field(2)), ['下の波括弧', 'Brace below'], 1);
for (const [name, left, right] of [['left', '(', ')'], ['left[', '[', ']'], ['left\\{', '\\{', '\\}'], ['left\\lvert', '\\lvert', '\\rvert'], ['left\\lVert', '\\lVert', '\\rVert']]) addCommand(name, command('left') + literal(left) + field(1) + command('right') + literal(right), ['大きさが変わる括弧', 'Automatically sized delimiters']);
for (const name of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta', 'vartheta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'pi', 'varpi', 'rho', 'varrho', 'sigma', 'varsigma', 'tau', 'upsilon', 'phi', 'varphi', 'chi', 'psi', 'omega', 'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Upsilon', 'Phi', 'Psi', 'Omega']) addCommand(name, command(name), ['ギリシャ文字', 'Greek letter']);
for (const name of ['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'exp', 'log', 'ln', 'det', 'dim', 'gcd', 'deg', 'arg', 'Pr', 'forall', 'exists', 'nexists', 'in', 'notin', 'ni', 'subset', 'supset', 'subseteq', 'supseteq', 'subsetneq', 'supsetneq', 'emptyset', 'varnothing', 'cup', 'cap', 'setminus', 'times', 'cdot', 'pm', 'mp', 'div', 'le', 'ge', 'leq', 'geq', 'neq', 'equiv', 'sim', 'simeq', 'cong', 'propto', 'll', 'gg', 'prec', 'succ', 'preceq', 'succeq', 'to', 'mapsto', 'rightarrow', 'leftarrow', 'leftrightarrow', 'Rightarrow', 'Leftarrow', 'Leftrightarrow', 'implies', 'iff', 'hookrightarrow', 'uparrow', 'downarrow', 'infty', 'partial', 'nabla', 'ell', 'hbar', 'Re', 'Im', 'ldots', 'cdots', 'vdots', 'ddots', 'langle', 'rangle', 'lvert', 'rvert', 'lVert', 'rVert', 'right', 'displaystyle', 'textstyle', 'scriptstyle']) addCommand(name, command(name), ['数式の記号と演算子', 'Math symbol or operator']);

for (const name of ['document', 'abstract', 'center', 'flushleft', 'flushright', 'quote', 'quotation', 'verse', 'verbatim', 'verbatim*']) addEnvironment(name);
for (const name of ['itemize', 'enumerate']) addEnvironment(name, '\t' + command('item') + ' ' + field(1), ['項目を並べる', 'List with an item']);
addEnvironment('description', '\t' + command('item') + '[' + field(1) + '] ' + field(2), ['見出しのあるリスト', 'List with item labels']);
for (const name of ['equation', 'equation*', 'displaymath', 'math']) addEnvironment(name, '\t' + field(1), ['数式', 'Equation'], '', name.endsWith('*') ? 'amsmath' : '');
const alignedBody = start => '\t' + field(start) + ' &= ' + field(start + 1) + ' ' + literal('\\\\') + '\n\t' + field(start + 2) + ' &= ' + field(start + 3);
for (const name of ['align', 'align*', 'aligned', 'split', 'flalign', 'flalign*']) addEnvironment(name, alignedBody(1), ['複数行の式を揃える', 'Align equations'], '', 'amsmath');
for (const name of ['alignat', 'alignat*', 'alignedat']) addEnvironment(name, alignedBody(2), ['複数の列で式を揃える', 'Align equation columns'], group(field(1, '2')), 'amsmath');
for (const name of ['gather', 'gather*', 'gathered', 'multline', 'multline*']) addEnvironment(name, '\t' + field(1) + ' ' + literal('\\\\') + '\n\t' + field(2), ['複数行の数式', 'Multiline equations'], '', 'amsmath');
const matrixBody = start => '\t' + field(start, 'a') + ' & ' + field(start + 1, 'b') + ' ' + literal('\\\\') + '\n\t' + field(start + 2, 'c') + ' & ' + field(start + 3, 'd');
for (const name of ['matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix']) addEnvironment(name, matrixBody(1), ['2 行 2 列の行列', 'Two by two matrix'], '', 'amsmath');
addEnvironment('array', matrixBody(2), ['数式を列に並べる', 'Math array'], group(field(1, 'cc')));
addEnvironment('cases', '\t' + field(1) + ' & ' + command('text') + group(field(2)) + ' ' + literal('\\\\') + '\n\t' + field(3) + ' & ' + command('text') + group(field(4)), ['場合分け', 'Cases'], '', 'amsmath');
for (const name of ['figure', 'figure*']) addEnvironment(name,
  '\t' + command('centering') + '\n\t' + command('includegraphics') + '[width=' + field(2, '\\linewidth') + ']' + group(field(3)) + '\n\t' + command('caption') + group(field(4)) + '\n\t' + command('label') + group(field(5, 'fig:')),
  ['画像，説明，ラベル', 'Image, caption, and label'], '[' + field(1, 'htbp') + ']', 'graphicx');
const tableBody = start => '\t' + field(start) + ' & ' + field(start + 1) + ' ' + literal('\\\\') + '\n\t' + command('hline') + '\n\t' + field(start + 2) + ' & ' + field(start + 3) + ' ' + literal('\\\\');
addEnvironment('tabular', tableBody(2), ['2 列の表', 'Two-column table'], group(field(1, 'll')));
addEnvironment('tabular*', tableBody(3), ['幅を指定する表', 'Table with a specified width'], group(field(1, '\\linewidth')) + group(field(2, 'll')));
addEnvironment('tabularx', tableBody(3), ['幅に合わせる表', 'Table fitted to a width'], group(field(1, '\\linewidth')) + group(field(2, 'Xr')), 'tabularx');
addEnvironment('longtable', tableBody(2), ['複数ページの表', 'Table across pages'], group(field(1, 'll')), 'longtable');
for (const name of ['table', 'table*']) addEnvironment(name,
  '\t' + command('centering') + '\n\t' + command('caption') + group(field(2)) + '\n\t' + command('label') + group(field(3, 'tab:')) + '\n\t' + command('begin') + literal('{tabular}') + group(field(4, 'll')) + '\n' + tableBody(5).replace(/^\t/gm, '\t\t') + '\n\t' + command('end') + literal('{tabular}'),
  ['表，説明，ラベル', 'Table, caption, and label'], '[' + field(1, 'htbp') + ']');
for (const [name, prefix] of [['theorem', 'thm:'], ['lemma', 'lem:'], ['proposition', 'prop:'], ['corollary', 'cor:'], ['definition', 'def:'], ['remark', 'rem:'], ['example', 'ex:']]) addEnvironment(name, '\t' + command('label') + group(field(1, prefix)) + '\n\t' + field(2), ['定理などの本文 (前文で環境を定義)', 'Theorem text (define the environment in the preamble)']);
addEnvironment('proof', '\t' + field(1), ['証明', 'Proof'], '', 'amsthm');
addEnvironment('minipage', '\t' + field(3), ['幅を指定する文章', 'Text with a specified width'], '[' + field(1, 't') + ']' + group(field(2, '0.5\\linewidth')));
addEnvironment('lstlisting', '\t' + field(2), ['ソースコード', 'Source code'], '[language=' + field(1, 'Python') + ']', 'listings');
addEnvironment('minted', '\t' + field(2), ['ソースコード', 'Source code'], group(field(1, 'python')), 'minted');
addEnvironment('tikzpicture', '\t' + field(1), ['TikZ の図', 'TikZ drawing'], '', 'tikz');

function escaped(text, at) { let count = 0; while (at > 0 && text[--at] === '\\') count++; return count % 2 === 1; }
function packageInfo(entry) {
  return entry.packageName ? languageText(['必要なパッケージ: ', 'Package: ']) + entry.packageName : undefined;
}
function completeCommand(entry, view, completion, from, to) {
  const text = view.state.doc.toString();
  let end = to + (/^[A-Za-z@]*\*?/.exec(text.slice(to))?.[0].length || 0);
  let template = entry.template;
  const suffix = text.slice(end, view.state.doc.lineAt(end).to);
  if (entry.groups && /^[\t ]*[\[{]/.test(suffix)) {
    let offset = 0, count = 0;
    while (count < entry.groups) {
      const empty = /^[\t ]*(?:\{[\t ]*\}|\[[\t ]*\])/.exec(suffix.slice(offset));
      if (!empty) break;
      offset += empty[0].length; count++;
    }
    const name = /^[A-Za-z@]+\*?/.exec(entry.name)?.[0] || entry.name;
    if (/^[\t ]*[\[{]/.test(suffix.slice(offset))) template = command(name) + finish;
    else if (count) end += offset;
    else template = command(name) + finish;
  }
  snippet(template)(view, completion, from, end);
}

function openEnvironments(code) {
  const stack = [], pattern = /\\(begin|end)\s*\{([^{}\s]+)\}/g;
  for (let match; (match = pattern.exec(code));) {
    if (escaped(code, match.index)) continue;
    if (match[1] === 'begin') stack.push(match[2]);
    else { const index = stack.lastIndexOf(match[2]); if (index >= 0) stack.splice(index); }
  }
  return stack;
}
function environmentEntries(code) {
  const result = [...environments], names = new Set(result.map(entry => entry.name));
  const definitions = /\\(?:newenvironment|renewenvironment|NewDocumentEnvironment|RenewDocumentEnvironment|newtheorem)\*?\s*\{([^{}\s]+)\}/g;
  for (let match; (match = definitions.exec(code));) {
    if (escaped(code, match.index) || names.has(match[1])) continue;
    names.add(match[1]); result.push({ name: match[1], body: '\t' + field(1), opening: '', description: ['この文書で定義した環境', 'Environment defined in this document'] });
  }
  return result;
}
function closingEnvironment(text, from, name) {
  if (/^(verbatim\*?|Verbatim|lstlisting|minted|comment)$/.test(name)) {
    const closing = '\\end{' + name + '}', at = text.indexOf(closing, from);
    return at < 0 ? null : { from: at, to: at + closing.length };
  }
  const code = maskNonCode(text), pattern = /\\(begin|end)\s*\{([^{}\s]+)\}/g;
  pattern.lastIndex = from;
  let depth = 0;
  for (let match; (match = pattern.exec(code));) {
    if (match[2] !== name || escaped(code, match.index)) continue;
    if (match[1] === 'begin') depth++;
    else if (depth) depth--;
    else return { from: match.index, to: pattern.lastIndex };
  }
  return null;
}
function completeEnvironment(entry, closing, view, completion, from, to) {
  const text = view.state.doc.toString();
  let end = to + (/^[\w*:@.+-]*/.exec(text.slice(to))?.[0].length || 0);
  const currentName = text.slice(from, end);
  if (text[end] === '}') end++;
  let template = literal(entry.name + '}') + finish;
  if (!closing) {
    const existing = closingEnvironment(text, end, entry.name) || (currentName !== entry.name ? closingEnvironment(text, end, currentName) : null);
    const empty = existing && !text.slice(end, existing.from).trim();
    const lineEnd = view.state.doc.lineAt(end).to;
    if ((!existing || empty) && (empty || !text.slice(end, lineEnd).trim())) {
      if (empty) end = existing.to;
      template = literal(entry.name + '}') + entry.opening + '\n' + entry.body + '\n' + command('end') + literal('{' + entry.name + '}') + finish;
    }
  }
  snippet(template)(view, completion, from, end);
}

/** Combine command/environment snippets with project citation and label keys. */
export function createTeXCompletionSource(getItems = () => ({})) {
  const references = texCompletionSource(getItems);
  return context => {
    const environment = context.matchBefore(/\\(?:begin|end)\s*\{[\w*:@.+-]*$/);
    const word = environment ? null : context.matchBefore(/\\[A-Za-z@]*\*?$/);
    const reference = environment || word ? null : references(context);
    if (!environment && !word && !reference) return null;
    const before = context.state.doc.sliceString(0, context.pos);
    let activeLiteral = '';
    const code = maskNonCode(before, { onLiteral: value => { if (!value.closed) activeLiteral = value.name; } });
    let last = before.length - 1;
    while (last >= 0 && /\s/.test(before[last])) last--;
    const inCode = last >= 0 && code[last] === before[last];
    if (environment) {
      if (escaped(before, environment.from)) return null;
      const match = /^\\(begin|end)\s*\{([\w*:@.+-]*)$/.exec(environment.text);
      const closing = match[1] === 'end';
      if (!inCode && !(closing && activeLiteral)) return null;
      const stack = activeLiteral ? [activeLiteral] : openEnvironments(code);
      let entries = environmentEntries(code);
      for (const name of stack) if (!entries.some(entry => entry.name === name)) entries.push({ name, body: '\t' + field(1), opening: '' });
      if (activeLiteral) entries = entries.filter(entry => entry.name === activeLiteral);
      return {
        from: context.pos - match[2].length,
        options: entries.map(entry => ({ label: entry.name, type: 'keyword',
          detail: closing && stack.includes(entry.name) ? languageText(['開いている環境', 'Open environment']) : languageText(entry.description),
          info: packageInfo(entry), boost: closing && stack.includes(entry.name) ? Math.min(99, 90 + stack.lastIndexOf(entry.name)) : 0,
          apply: (view, completion, from, to) => completeEnvironment(entry, closing, view, completion, from, to),
        })), validFor: /^[\w*:@.+-]*$/,
      };
    }
    if (!inCode) return null;
    if (reference) return reference;
    if (escaped(before, word.from)) return null;
    return {
      from: word.from,
      options: commands.map(entry => ({ label: '\\' + entry.name, type: 'keyword', detail: languageText(entry.description), info: packageInfo(entry), boost: entry.boost,
        apply: (view, completion, from, to) => completeCommand(entry, view, completion, from, to),
      })), validFor: /^\\[A-Za-z@]*\*?$/,
    };
  };
}
