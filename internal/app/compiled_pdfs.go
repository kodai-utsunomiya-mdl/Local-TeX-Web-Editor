package app

import (
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

type CompiledPDF struct {
	BuildID        string    `json:"buildId"`
	Main           string    `json:"main"`
	Name           string    `json:"name"`
	Size           int64     `json:"size"`
	ModifiedAt     time.Time `json:"modifiedAt"`
	SourceChanged  bool      `json:"sourceChanged"`
	SyncTeXReady   bool      `json:"synctexReady"`
	MarkdownInputs []string  `json:"markdownInputs"`
}

func compiledPDFKey(main string) string {
	key := filepath.ToSlash(filepath.Clean(main))
	if runtime.GOOS == "windows" {
		key = strings.ToLower(key)
	}
	return key
}

func compiledPDFName(name string) string {
	if strings.ContainsAny(name, "/\\\x00\r\n") || !strings.EqualFold(filepath.Ext(name), ".pdf") {
		return ""
	}
	return name
}

// The caller holds a.mu. The PDF is the completed copy used by the viewer.
func (a *App) recordCompiledPDFLocked(main, name, id, pdf string, changed bool, inputs map[string]bool) {
	info, err := os.Stat(pdf)
	if err != nil || !info.Mode().IsRegular() {
		return
	}
	if a.compiledPDFs == nil {
		a.compiledPDFs = make(map[string]CompiledPDF)
	}
	a.compiledPDFs[compiledPDFKey(main)] = CompiledPDF{
		BuildID: id, Main: main, Name: compiledPDFName(name), Size: info.Size(), ModifiedAt: info.ModTime().UTC(),
		SourceChanged: changed, SyncTeXReady: a.synctexVersions[id] != nil, MarkdownInputs: markdownInputList(inputs),
	}
}

func (a *App) compiledPDFSnapshotLocked() []CompiledPDF {
	result := make([]CompiledPDF, 0, len(a.compiledPDFs))
	for _, value := range a.compiledPDFs {
		value.SyncTeXReady = a.synctexVersions[value.BuildID] != nil
		if value.BuildID == a.lastPDFID {
			value.SourceChanged = value.SourceChanged || a.lastPDFChanged
		}
		if value.MarkdownInputs != nil {
			value.MarkdownInputs = append([]string{}, value.MarkdownInputs...)
		}
		result = append(result, value)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Main < result[j].Main })
	return result
}

// Keep each document's current result, and the preceding result while the
// browser finishes requests for the PDF that was visible before compilation.
func (a *App) trimPDFVersionsLocked() {
	if len(a.pdfOrder) > 2 {
		a.pdfOrder = append([]string{}, a.pdfOrder[len(a.pdfOrder)-2:]...)
	}
	keep := make(map[string]bool, len(a.compiledPDFs)+len(a.pdfOrder))
	for _, value := range a.compiledPDFs {
		keep[value.BuildID] = true
	}
	for _, id := range a.pdfOrder {
		keep[id] = true
	}
	for id := range a.pdfVersions {
		if !keep[id] {
			delete(a.pdfVersions, id)
			delete(a.synctexVersions, id)
		}
	}
}

func (a *App) noteCompiledPDFSourceChangedLocked(path string) {
	for key, value := range a.compiledPDFs {
		if !value.SourceChanged && markdownSourceAffectsPDF(path, markdownInputSet(value.MarkdownInputs)) {
			value.SourceChanged = true
			a.compiledPDFs[key] = value
		}
	}
}

func (a *App) noteCompiledPDFSettingsChangedLocked() {
	for key, value := range a.compiledPDFs {
		value.SourceChanged = true
		a.compiledPDFs[key] = value
	}
}
