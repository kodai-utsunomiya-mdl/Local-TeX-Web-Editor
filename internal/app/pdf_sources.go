package app

import (
	"path/filepath"
	"sort"
	"strings"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

func isMarkdownSource(path string) bool {
	extension := strings.ToLower(filepath.Ext(path))
	return extension == ".md" || extension == ".markdown"
}

// A nil set means that the recorder was unavailable. Other source types keep
// the existing project-wide change tracking; only unrelated Markdown is omitted.
func markdownSourceAffectsPDF(path string, inputs map[string]bool) bool {
	if !isMarkdownSource(path) || inputs == nil {
		return true
	}
	for input := range inputs {
		if samePath(path, input) {
			return true
		}
	}
	return false
}

func markdownInputList(inputs map[string]bool) []string {
	if inputs == nil {
		return nil
	}
	paths := make([]string, 0, len(inputs))
	for path := range inputs {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	return paths
}

func markdownInputSet(paths []string) map[string]bool {
	if paths == nil {
		return nil
	}
	inputs := make(map[string]bool, len(paths))
	for _, path := range paths {
		clean, err := cleanRelative(path)
		if err != nil || !isMarkdownSource(clean) {
			return nil
		}
		inputs[clean] = true
	}
	return inputs
}

func sourcesForPDF(root, workDir, main, pdf string, sources map[string]string) (map[string]string, map[string]bool) {
	stem := strings.TrimSuffix(pdf, filepath.Ext(pdf))
	recorded := recorderSources(root, workDir, stem+".fls", sources)
	if !recorded[main] {
		return sources, nil
	}
	// latexmk also records inputs to custom conversion rules. Include their
	// Markdown files even if TeX opened only the resulting .tex file.
	if data, err := readBytes(stem + ".fdb_latexmk"); err == nil {
		resolve := newSyncSourceResolver(root, workDir, sources, nil, platform.EncodeFileName)
		for _, line := range strings.Split(string(data), "\n") {
			for _, value := range fdbValues(line) {
				if isMarkdownSource(value) {
					if path := resolve(value); path != "" {
						recorded[path] = true
					}
				}
			}
		}
	}
	inputs := make(map[string]bool)
	for path := range recorded {
		if isMarkdownSource(path) {
			inputs[path] = true
		}
	}
	filtered := make(map[string]string, len(sources))
	for path, revision := range sources {
		if markdownSourceAffectsPDF(path, inputs) {
			filtered[path] = revision
		}
	}
	return filtered, inputs
}

// The caller holds a.mu. Markdown saved during compilation is checked against
// that compilation's recorder once the process finishes.
func (a *App) noteSavedSourceLocked(path string) {
	a.noteCompiledPDFSourceChangedLocked(path)
	if run := a.build; run != nil {
		if isMarkdownSource(path) && run.result.Status == "running" {
			if run.changedMarkdown == nil {
				run.changedMarkdown = make(map[string]bool)
			}
			run.changedMarkdown[path] = true
		} else if markdownSourceAffectsPDF(path, run.markdownInputs) {
			run.result.SourceChanged = true
		}
	}
	if a.lastPDFID != "" && markdownSourceAffectsPDF(path, a.lastPDFMarkdownInputs) {
		a.lastPDFChanged = true
	}
}
