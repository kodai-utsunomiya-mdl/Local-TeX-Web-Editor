package app

import (
	"context"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
)

const (
	projectSearchMaxMatches = 1000
	projectSearchMaxBytes   = 32 << 20
	projectSearchMaxResult = 16 << 20
)

type projectSearchInput struct {
	Query         string         `json:"query"`
	Replacement   string         `json:"replacement"`
	CaseSensitive bool           `json:"caseSensitive"`
	Regexp        bool           `json:"regexp"`
	WholeWord     bool           `json:"wholeWord"`
	Documents     []FileDocument `json:"documents"`
}

type projectSearchMatch struct {
	From        int    `json:"from"`
	To          int    `json:"to"`
	Line        int    `json:"line"`
	Column      int    `json:"column"`
	Text        string `json:"text"`
	Snippet     string `json:"snippet"`
	Replacement string `json:"replacement"`
}

type projectSearchFile struct {
	FileDocument
	Matches []projectSearchMatch `json:"matches"`
}

type projectSearchResult struct {
	Files       []projectSearchFile `json:"files"`
	Count       int                 `json:"count"`
	Scanned     int                 `json:"scanned"`
	Skipped     int                 `json:"skipped"`
	Limited     bool                `json:"limited"`
	MaxMatches  int                 `json:"maxMatches"`
}

func utf16Length(text string) int {
	length := 0
	for _, value := range text {
		length++
		if value > 0xffff {
			length++
		}
	}
	return length
}

func searchWordCharacter(value rune) bool {
	return value == '_' || unicode.IsLetter(value) || unicode.IsNumber(value) || unicode.IsMark(value)
}

func searchWordBoundary(text string, from, to int) bool {
	if from > 0 {
		previous, _ := utf8.DecodeLastRuneInString(text[:from])
		if searchWordCharacter(previous) {
			return false
		}
	}
	if to < len(text) {
		next, _ := utf8.DecodeRuneInString(text[to:])
		if searchWordCharacter(next) {
			return false
		}
	}
	return true
}

func searchSnippet(text string, from, to int) string {
	start := from - 300
	if start < 0 { start = 0 }
	for start < from && !utf8.RuneStart(text[start]) { start++ }
	start += strings.LastIndexByte(text[start:from], '\n') + 1
	end := to + 300
	if end > len(text) { end = len(text) }
	for end > to && end < len(text) && !utf8.RuneStart(text[end]) { end-- }
	if relative := strings.IndexByte(text[to:end], '\n'); relative >= 0 {
		end = to + relative
	}
	before := []rune(text[start:from])
	if len(before) > 75 {
		before = append([]rune{'…'}, before[len(before)-75:]...)
	}
	matchEnd := to
	if matchEnd > from + 640 { matchEnd = from + 640 }
	for matchEnd > from && matchEnd < to && !utf8.RuneStart(text[matchEnd]) { matchEnd-- }
	matched := []rune(text[from:matchEnd])
	if len(matched) > 160 {
		matched = append(matched[:160], '…')
	}
	after := []rune(text[to:end])
	if len(after) > 75 {
		after = append(after[:75], '…')
	}
	return strings.ReplaceAll(string(before)+string(matched)+string(after), "\n", " ↵ ")
}

// Expand one replacement with a limit before each append. A small template can
// otherwise repeat a large capture many times before the result limit is seen.
func expandSearchReplacement(expression *regexp.Regexp, template, source string, match []int, limit int) (string, bool) {
	var output strings.Builder
	appendText := func(text string) bool {
		if len(text) > limit-output.Len() { return false }
		output.WriteString(text)
		return true
	}
	for position := 0; position < len(template); {
		if template[position] != '$' {
			end := strings.IndexByte(template[position:], '$')
			if end < 0 { end = len(template) } else { end += position }
			if !appendText(template[position:end]) { return "", false }
			position = end
			continue
		}
		if position+1 < len(template) && template[position+1] == '$' {
			if !appendText("$") { return "", false }
			position += 2
			continue
		}
		start := position + 1
		braces := start < len(template) && template[start] == '{'
		if braces { start++ }
		end := start
		for end < len(template) {
			character, size := utf8.DecodeRuneInString(template[end:])
			if character != '_' && !unicode.IsLetter(character) && !unicode.IsDigit(character) { break }
			end += size
		}
		if start == end || (braces && (end == len(template) || template[end] != '}')) {
			if !appendText("$") { return "", false }
			position++
			continue
		}
		name := template[start:end]
		position = end
		if braces { position++ }
		group, parseErr := strconv.Atoi(name)
		if parseErr != nil || len(name) > 9 || (len(name) > 1 && name[0] == '0') {
			group = -1
			for index, candidate := range expression.SubexpNames() {
				if candidate == name && 2*index+1 < len(match) && match[2*index] >= 0 { group = index; break }
			}
		}
		if group >= 0 && group < len(match)/2 && match[2*group] >= 0 {
			if !appendText(source[match[2*group]:match[2*group+1]]) { return "", false }
		}
	}
	return output.String(), true
}

func searchProject(ctx context.Context, root string, input projectSearchInput) (projectSearchResult, error) {
	result := projectSearchResult{Files: []projectSearchFile{}, MaxMatches: projectSearchMaxMatches}
	if err := ctx.Err(); err != nil { return result, err }
	if input.Query == "" || len(input.Query) > 4096 || len(input.Replacement) > 65536 {
		return result, fail(http.StatusBadRequest, "検索する文字列は 1～4096 バイト，置換後の文字列は 64 KiB 以内で入力してください．")
	}
	pattern := regexp.QuoteMeta(input.Query)
	if input.Regexp {
		pattern = input.Query
	}
	flags := "(?m)"
	if !input.CaseSensitive {
		flags = "(?mi)"
	}
	expression, err := regexp.Compile(flags + pattern)
	if err != nil {
		return result, fail(http.StatusBadRequest, "正規表現を確認してください: %v", err)
	}
	if expression.NumSubexp() > 64 {
		return result, fail(http.StatusBadRequest, "正規表現のキャプチャは 64 個以内にしてください．")
	}
	overrides := make(map[string]FileDocument)
	for _, document := range input.Documents {
		clean, _, err := projectFilePath(root, document.Path, false)
		if err != nil {
			return result, err
		}
		if len(document.Content) > maxTextSize || !utf8.ValidString(document.Content) || strings.ContainsRune(document.Content, 0) {
			return result, fail(http.StatusBadRequest, "検索する原稿は 8 MiB 以内の UTF-8 にしてください．")
		}
		document.Path = clean
		overrides[clean] = document
	}
	files, err := listProjectFiles(root)
	if err != nil {
		return result, err
	}
	readBytes, responseBytes := 0, 0
	for _, file := range files {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		if !isTextFile(file.Path) {
			continue
		}
		document, opened := overrides[file.Path]
		if !opened {
			if file.Size > maxTextSize || readBytes+int(file.Size) > projectSearchMaxBytes {
				result.Skipped++
				result.Limited = true
				continue
			}
			document, err = readDocument(root, file.Path)
			if err != nil {
				result.Skipped++
				continue
			}
		}
		if readBytes+len(document.Content) > projectSearchMaxBytes {
			result.Skipped++
			result.Limited = true
			continue
		}
		readBytes += len(document.Content)
		result.Scanned++
		// RE2 evaluates patterns in linear time. Limit matches before allocating
		// snippets, and keep all offsets in the UTF-16 units used by the editor.
		indices := expression.FindAllStringSubmatchIndex(document.Content, projectSearchMaxMatches*10+1)
		if len(indices) > projectSearchMaxMatches*10 {
			indices = indices[:projectSearchMaxMatches*10]
			result.Limited = true
		}
		found := projectSearchFile{FileDocument: document, Matches: []projectSearchMatch{}}
		fileResponseBytes := len(document.Content)
		bytePosition, characterPosition, line, lineCharacterStart := 0, 0, 1, 0
		for _, index := range indices {
			if err := ctx.Err(); err != nil {
				return result, err
			}
			from, to := index[0], index[1]
			if input.WholeWord && !searchWordBoundary(document.Content, from, to) {
				continue
			}
			if result.Count >= projectSearchMaxMatches {
				result.Limited = true
				break
			}
			between := document.Content[bytePosition:from]
			characterPosition += utf16Length(between)
			line += strings.Count(between, "\n")
			if lastBreak := strings.LastIndexByte(between, '\n'); lastBreak >= 0 { lineCharacterStart = characterPosition - utf16Length(between[lastBreak+1:]) }
			replacement := input.Replacement
			if input.Regexp {
				var withinLimit bool
				replacement, withinLimit = expandSearchReplacement(expression, input.Replacement, document.Content, index, maxTextSize)
				if !withinLimit { result.Limited = true; break }
			}
			snippet := searchSnippet(document.Content, from, to)
			matchBytes := to - from + len(replacement) + len(snippet) + 128
			if responseBytes + fileResponseBytes + matchBytes > projectSearchMaxResult {
				result.Limited = true
				break
			}
			fileResponseBytes += matchBytes
			found.Matches = append(found.Matches, projectSearchMatch{
				From: characterPosition, To: characterPosition + utf16Length(document.Content[from:to]),
				Line: line, Column: characterPosition - lineCharacterStart + 1,
				Text: document.Content[from:to], Snippet: snippet, Replacement: replacement,
			})
			bytePosition = from
			result.Count++
		}
		if len(found.Matches) > 0 {
			if responseBytes+fileResponseBytes > projectSearchMaxResult {
				result.Count -= len(found.Matches)
				result.Limited = true
				break
			}
			responseBytes += fileResponseBytes
			result.Files = append(result.Files, found)
		}
		if result.Count >= projectSearchMaxMatches {
			result.Limited = true
			break
		}
	}
	return result, nil
}

func (a *App) projectSearchHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var input projectSearchInput
	if err := readJSON(w, r, &input); err != nil {
		writeError(w, err)
		return
	}
	a.mu.Lock()
	err := a.checkProjectLocked(r.Header.Get("X-Project-Root"))
	root := ""
	if a.project != nil {
		root = a.project.Root
	}
	a.mu.Unlock()
	if err != nil {
		writeError(w, err)
		return
	}
	if root == "" {
		writeError(w, fail(http.StatusBadRequest, "原稿フォルダーを開いてください．"))
		return
	}
	result, err := searchProject(r.Context(), root, input)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (a *App) projectReplaceHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPut) {
		return
	}
	var input struct {
		Changes []FileDocument `json:"changes"`
	}
	if err := readJSON(w, r, &input); err != nil {
		writeError(w, err)
		return
	}
	if len(input.Changes) == 0 || len(input.Changes) > 1000 {
		writeError(w, fail(http.StatusBadRequest, "置換するファイルを 1～1000 件選んでください．"))
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := a.checkProjectLocked(r.Header.Get("X-Project-Root")); err != nil {
		writeError(w, err)
		return
	}
	if a.project == nil {
		writeError(w, fail(http.StatusBadRequest, "原稿フォルダーを開いてください．"))
		return
	}
	if a.isRunningLocked() {
		writeError(w, fail(http.StatusConflict, "コンパイルが終わってから置換してください．"))
		return
	}
	seen := map[string]bool{}
	for _, change := range input.Changes {
		if len(change.Content) > maxTextSize || !utf8.ValidString(change.Content) || strings.ContainsRune(change.Content, 0) {
			writeError(w, fail(http.StatusBadRequest, "置換後の原稿は 8 MiB 以内の UTF-8 にしてください．"))
			return
		}
		clean, _, err := projectFilePath(a.project.Root, change.Path, false)
		if err != nil {
			writeError(w, err)
			return
		}
		key := strings.ToLower(clean)
		if seen[key] {
			writeError(w, fail(http.StatusBadRequest, "同じファイルが複数回指定されています．"))
			return
		}
		seen[key] = true
		document, err := readDocument(a.project.Root, clean)
		if err != nil {
			writeError(w, err)
			return
		}
		if document.Revision != change.Revision {
			writeError(w, fail(http.StatusConflict, "%s は検索した後に変更されました．検索し直してから置換してください．", clean))
			return
		}
	}
	sort.Slice(input.Changes, func(i, j int) bool { return input.Changes[i].Path < input.Changes[j].Path })
	saved := []FileDocument{}
	for _, change := range input.Changes {
		if err := r.Context().Err(); err != nil {
			writeJSON(w, http.StatusConflict, map[string]any{"error": "Replacement stopped.", "documents": saved})
			return
		}
		document, err := a.saveDocumentWithHistoryLocked(change, messages.LanguageFromContext(r.Context()))
		if err != nil {
			status := http.StatusConflict
			writeJSON(w, status, map[string]any{"error": messages.ErrorText(messages.LanguageFromContext(r.Context()), err), "documents": saved, "failedPath": change.Path})
			return
		}
		a.noteSavedSourceLocked(document.Path)
		saved = append(saved, document)
	}
	writeJSON(w, http.StatusOK, map[string]any{"documents": saved})
}
