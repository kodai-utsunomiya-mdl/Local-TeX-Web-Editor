const inlineMarks = { bold: 'strong', italic: 'em', strike: 'strike', inlineCode: 'code' };
const blockCommands = ['bullet', 'ordered', 'task', 'quote', 'codeBlock'];

function combinedState(values) {
  const count = values.filter(Boolean).length;
  return count === 0 ? false : count === values.length ? true : 'mixed';
}

function blockState(position) {
  let list = '', item = null, quote = false;
  for (let depth = position.depth; depth > 0; depth--) {
    const node = position.node(depth), name = node.type.name;
    if (!list && item === null && name === 'list_item') item = node;
    if (!list && (name === 'bullet_list' || name === 'ordered_list')) list = name;
    if (name === 'blockquote') quote = true;
  }
  const task = item?.attrs.checked != null;
  return {
    bullet: list === 'bullet_list' && !task,
    ordered: list === 'ordered_list' && !task,
    task, quote,
    codeBlock: position.parent.type.name === 'code_block',
  };
}

export function markdownFormattingState(state) {
  const result = Object.fromEntries([...Object.keys(inlineMarks), ...blockCommands].map(name => [name, false]));
  if (!state?.selection || !state.doc) return result;
  const { selection, doc } = state;
  if (selection.empty) {
    const marks = state.storedMarks ?? selection.$from.marks();
    for (const [command, name] of Object.entries(inlineMarks)) result[command] = marks.some(mark => mark.type.name === name);
    return { ...result, ...blockState(selection.$from) };
  }

  const marks = [], blocks = new Map();
  for (const { $from, $to } of selection.ranges) {
    doc.nodesBetween($from.pos, $to.pos, (node, position) => {
      if (node.isTextblock) blocks.set(position, blockState(doc.resolve(position + 1)));
      if (node.isInline && (node.isText || node.isLeaf) && position < $to.pos && position + node.nodeSize > $from.pos) marks.push(node.marks);
    });
  }
  for (const [command, name] of Object.entries(inlineMarks)) result[command] = combinedState(marks.map(values => values.some(mark => mark.type.name === name)));
  for (const command of blockCommands) result[command] = combinedState([...blocks.values()].map(value => value[command]));
  return result;
}
