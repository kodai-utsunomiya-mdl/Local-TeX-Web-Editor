const sameSources = (before, after) => Array.isArray(before) && before.length === after.length && after.every((source, index) => source === before[index]);

// Each file replaces its metadata when its text changes. Reuse the combined
// bibliography while editing TeX so PDF links can keep their citation index.
export function combineCompletionItems(previous, entries) {
  const citationSources = [], labelSources = [];
  for (const entry of entries) {
    if (entry.citations?.length) citationSources.push(entry.citations);
    if (entry.labels?.length) labelSources.push(entry.labels);
  }
  return {
    citations: sameSources(previous?.citationSources, citationSources) ? previous.citations : citationSources.flat(),
    labels: sameSources(previous?.labelSources, labelSources) ? previous.labels : labelSources.flat(),
    citationSources, labelSources,
  };
}
