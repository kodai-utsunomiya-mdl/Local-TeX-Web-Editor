import texmath from 'markdown-it-texmath';

// Both Markdown views accept equations next to numbers, including equations
// inserted through the toolbar. Literal dollar signs use Markdown's \$ escape.
export function markdownMath(parser, options) {
  parser.use(texmath, { ...options, delimiters: ['gitlab', 'brackets'] });
  for (const rule of texmath.rules.dollars.inline) {
    const acceptsNumbers = {
      ...rule,
      rex: new RegExp(rule.rex.source, rule.rex.flags),
      pre: (source, _outerSpace, start) => source[start - 1] !== '\\',
      post: () => true,
    };
    parser.inline.ruler.before('escape', rule.name, texmath.inline(acceptsNumbers));
  }
  for (const rule of texmath.rules.dollars.block) {
    parser.block.ruler.before('fence', rule.name, texmath.block({
      ...rule, rex: new RegExp(rule.rex.source, rule.rex.flags),
    }));
  }
  // Inline and block renderers are supplied by texmath's other delimiter sets.
  parser.renderer.rules.math_inline_double = (tokens, index) =>
    options.engine.renderToString(tokens[index].content, { ...options.katexOptions, displayMode: true });
}
