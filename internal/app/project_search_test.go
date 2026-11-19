package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestProjectSearchUsesEditingTextAndUTF16Positions(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "章.tex"), []byte("saved text\n"))
	saved, err := readDocument(root, "章.tex")
	if err != nil { t.Fatal(err) }
	editing := saved
	editing.Content = "😀cat\n日本語 cat\n"
	result, err := searchProject(context.Background(), root, projectSearchInput{
		Query: `(?P<word>cat)`, Replacement: `${word}-犬`, Regexp: true, CaseSensitive: true, Documents: []FileDocument{editing},
	})
	if err != nil { t.Fatal(err) }
	if result.Count != 2 || len(result.Files) != 1 { t.Fatalf("unexpected search results: %#v", result) }
	file := result.Files[0]
	if file.Content != editing.Content || file.Revision != saved.Revision { t.Fatalf("editing text or disk revision changed: %#v", file) }
	first, second := file.Matches[0], file.Matches[1]
	if first.From != 2 || first.To != 5 || first.Line != 1 || first.Column != 3 || first.Replacement != "cat-犬" { t.Fatalf("first match: %#v", first) }
	if second.From != 10 || second.To != 13 || second.Line != 2 || second.Column != 5 { t.Fatalf("second match: %#v", second) }
}

func TestProjectSearchWordOptionsAndGeneratedFiles(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "main.tex"), []byte("Cat scat cat猫 cat\n"))
	writeTestFile(t, filepath.Join(root, "main.aux"), []byte("cat"))
	writeTestFile(t, filepath.Join(root, ".local-tex-editor", "build", "generated.tex"), []byte("cat"))
	writeTestFile(t, filepath.Join(root, "binary.txt"), []byte{0xff, 0, 0xfe})
	result, err := searchProject(context.Background(), root, projectSearchInput{Query: "cat", Replacement: "$1", WholeWord: true})
	if err != nil { t.Fatal(err) }
	if result.Count != 2 || result.Files[0].Path != "main.tex" || result.Skipped != 1 { t.Fatalf("unexpected matches: %#v", result) }
	for _, match := range result.Files[0].Matches { if match.Replacement != "$1" { t.Fatal("literal replacement interpreted a dollar expression") } }
}

func TestProjectSearchLimitsResultsAndHonorsCancellation(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "main.tex"), []byte(strings.Repeat("match\n", projectSearchMaxMatches+20)))
	result, err := searchProject(context.Background(), root, projectSearchInput{Query: "match"})
	if err != nil { t.Fatal(err) }
	if !result.Limited || result.Count != projectSearchMaxMatches { t.Fatalf("the match limit was not applied: %#v", result) }
	ctx, cancel := context.WithCancel(context.Background()); cancel()
	if _, err := searchProject(ctx, root, projectSearchInput{Query: "match"}); !errors.Is(err, context.Canceled) { t.Fatalf("cancel: %v", err) }
	if _, err := searchProject(context.Background(), root, projectSearchInput{Query: `(?<=x)y`, Regexp: true}); err == nil { t.Fatal("an unsupported regular expression was accepted") }
}

func TestSearchReplacementExpansionMatchesRegularExpressionsWithinTheLimit(t *testing.T) {
	expression := regexp.MustCompile(`(?P<animal>cat)(s)?`)
	source := "cat"
	match := expression.FindStringSubmatchIndex(source)
	for _, template := range []string{"$1", "${animal}", "$$", "$0 $2", "$unknown", "$1x", "${1}x", "${bad!$1}", "$", "$01", "${1", "日本語${animal}😀"} {
		actual, ok := expandSearchReplacement(expression, template, source, match, 1024)
		want := string(expression.ExpandString(nil, template, source, match))
		if !ok || actual != want { t.Fatalf("%q: got %q, want %q", template, actual, want) }
	}
	if _, ok := expandSearchReplacement(expression, strings.Repeat("$1", 10000), source, match, 1024); ok { t.Fatal("the replacement size limit was not applied before expansion") }
}

func TestProjectReplacementChecksAllRevisionsBeforeWriting(t *testing.T) {
	a, root := testApp(t)
	writeTestFile(t, filepath.Join(root, "second.tex"), []byte("second original\n"))
	first, err := readDocument(root, "main.tex"); if err != nil { t.Fatal(err) }
	second, err := readDocument(root, "second.tex"); if err != nil { t.Fatal(err) }
	original := first.Content
	first.Content = "replacement for first\n"
	second.Content = "replacement for second\n"
	writeTestFile(t, filepath.Join(root, "second.tex"), []byte("external edit\n"))
	response := apiRequest(a, http.MethodPut, "/api/project/replace", map[string]any{"changes": []FileDocument{first, second}}, nil)
	if response.Code != http.StatusConflict { t.Fatalf("want conflict: %d %s", response.Code, response.Body.String()) }
	current, _ := readDocument(root, "main.tex")
	if current.Content != original { t.Fatal("the first file was changed despite the later conflict") }
	current, _ = readDocument(root, "second.tex")
	if current.Content != "external edit\n" { t.Fatal("the external edit was overwritten") }
}

func TestProjectReplacementSavesSelectedDocumentsAndRecordsHistory(t *testing.T) {
	a, root := testApp(t)
	document, err := readDocument(root, "main.tex"); if err != nil { t.Fatal(err) }
	original := document.Content
	document.Content += "replacement\n"
	response := apiRequest(a, http.MethodPut, "/api/project/replace", map[string]any{"changes": []FileDocument{document}}, nil)
	if response.Code != http.StatusOK { t.Fatalf("replace: %d %s", response.Code, response.Body.String()) }
	var result struct { Documents []FileDocument `json:"documents"` }
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil { t.Fatal(err) }
	if len(result.Documents) != 1 || result.Documents[0].Revision == document.Revision { t.Fatalf("saved documents: %#v", result) }
	actual, _ := os.ReadFile(filepath.Join(root, "main.tex"))
	if string(actual) != document.Content { t.Fatalf("saved text: %s", actual) }
	directory, err := a.historyDirectory(root, "main.tex", false); if err != nil { t.Fatal(err) }
	entries, err := readHistoryEntries(directory); if err != nil { t.Fatal(err) }
	if len(entries) != 1 || entries[0].Hash != revision([]byte(original)) { t.Fatalf("history: %#v", entries) }
}

func TestProjectSearchAndHistoryRejectAnOldProjectHeader(t *testing.T) {
	a, firstRoot := testApp(t)
	secondRoot := t.TempDir()
	writeTestFile(t, filepath.Join(secondRoot, "main.tex"), []byte("second project"))
	opened := apiRequest(a, http.MethodPost, "/api/project/open", map[string]string{"path": secondRoot}, nil)
	if opened.Code != http.StatusOK { t.Fatalf("open: %s", opened.Body.String()) }
	headers := map[string]string{"X-Project-Root": url.PathEscape(firstRoot)}
	for _, request := range []struct { method, path string; body any }{
		{http.MethodPost, "/api/project/search", projectSearchInput{Query: "project"}},
		{http.MethodPut, "/api/project/replace", map[string]any{"changes": []FileDocument{{Path: "main.tex", Content: "wrong project"}}}},
		{http.MethodGet, "/api/history?path=main.tex", nil},
		{http.MethodPost, "/api/history", map[string]string{"path": "main.tex", "content": "wrong project"}},
	} {
		response := apiRequest(a, request.method, request.path, request.body, headers)
		if response.Code != http.StatusConflict { t.Fatalf("%s: got %d %s", request.path, response.Code, response.Body.String()) }
	}
	content, _ := os.ReadFile(filepath.Join(secondRoot, "main.tex"))
	if string(content) != "second project" { t.Fatal("an old browser tab changed the new project") }
}
