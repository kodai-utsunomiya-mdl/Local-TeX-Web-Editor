export function completionInfo({ label, title, detail, location }) {
  const document = globalThis.document;
  const content = document.createElement('div');
  content.className = 'tex-completion-description';
  for (const [name, text] of Object.entries({ key: label, title, authors: detail, location })) {
    if (!text) continue;
    const field = document.createElement(name === 'key' ? 'strong' : 'p');
    field.className = `tex-completion-${name}`;
    field.textContent = text;
    content.append(field);
  }
  return content;
}
