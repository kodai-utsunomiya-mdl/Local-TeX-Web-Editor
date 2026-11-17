package app

import (
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/messages"
	"github.com/kodai-utsunomiya-mdl/local-tex-editor/internal/platform"
)

func TestAPIExplainsErrorsAndToolSettingsInTheRequestedLanguage(t *testing.T) {
	a, root := testApp(t)
	writeTestFile(t, filepath.Join(root, "notes.md"), []byte("# Notes\n"))
	missing := filepath.Join(t.TempDir(), "原稿フォルダーを開いてください．")
	a.config.TexBin = missing
	a.options.InstallationError = messages.Errorf("ショートカットから起動するアプリを更新できませんでした．設定でショートカットをもう一度作成してください．%w", platform.ErrShortcutConflict)
	for _, test := range []struct {
		language, toolText, syncText, installText string
	}{
		{"en-US", "was not found", "See the SyncTeX instructions", "Could not update the app used by the shortcut"},
		{"ja", "が見つかりません", "設定画面の SyncTeX", "ショートカットから起動するアプリを更新できませんでした"},
	} {
		response := apiRequest(a, http.MethodGet, "/api/state", nil, map[string]string{"Accept-Language": test.language})
		var state State
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &state) != nil {
			t.Fatalf("state: %d %s", response.Code, response.Body.String())
		}
		if !strings.Contains(state.ToolError, test.toolText) || !strings.Contains(state.ToolError, missing) || !strings.Contains(state.SynctexError, test.syncText) || !strings.Contains(state.SynctexError, missing) || !strings.Contains(state.InstallationError, test.installText) {
			t.Fatalf("language %s: %#v", test.language, state)
		}
		if response.Header().Get("Content-Language") != messages.Language(test.language) || !strings.Contains(response.Header().Get("Vary"), "Accept-Language") {
			t.Fatalf("language response headers: %#v", response.Header())
		}
	}
	for _, test := range []struct{ language, expected string }{{"en", "Select a .tex file to compile."}, {"ja", "コンパイルする文書には .tex ファイルを選んでください．"}} {
		response := apiRequest(a, http.MethodPost, "/api/build", map[string]string{"main": "notes.md"}, map[string]string{"Accept-Language": test.language})
		var result struct{ Error string }
		if response.Code != http.StatusBadRequest || json.Unmarshal(response.Body.Bytes(), &result) != nil || result.Error != test.expected {
			t.Fatalf("API error in %s: %d %s", test.language, response.Code, response.Body.String())
		}
	}
}

func TestBuildLanguageChangesLeaveCompilerOutputAndDocumentNamesIntact(t *testing.T) {
	a, root := testApp(t)
	run := &buildRun{project: *a.project, started: time.Now(), result: Build{ID: "language-build", Main: "日本語の原稿.tex", Status: "running"}}
	a.build = run
	raw := "! LaTeX Error: 原稿フォルダーを開いてください．\n"
	a.appendMessageLocked(run, "[作業フォルダー] %s\n[実行] %s\n\n", root, `latexmk "日本語の原稿.tex"`)
	a.appendLogLocked(run, []byte(raw))
	code := 12
	a.finishBuild(run, &code, messages.Errorf("latexmk が終了コード %d で終了しました．上のログを確認してください．", code), "", "")
	for _, test := range []struct{ language, errorText, folderText, exitText string }{
		{"en", "latexmk exited with code 12. Check the log above.", "[Working folder]", "[Exit code: 12]"},
		{"ja", "latexmk が終了コード 12 で終了しました．上のログを確認してください．", "[作業フォルダー]", "[終了コード: 12]"},
	} {
		for _, endpoint := range []string{"/api/build", "/api/state"} {
			response := apiRequest(a, http.MethodGet, endpoint, nil, map[string]string{"Accept-Language": test.language})
			var result Build
			if endpoint == "/api/state" {
				var state State
				if err := json.Unmarshal(response.Body.Bytes(), &state); err != nil || state.Build == nil {
					t.Fatalf("state: %s (%v)", response.Body.String(), err)
				}
				result = *state.Build
			} else if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if result.Error != test.errorText || !strings.Contains(result.Log, test.folderText) || !strings.Contains(result.Log, test.exitText) || !strings.Contains(result.Log, raw) || !strings.Contains(result.Log, root) || result.Main != "日本語の原稿.tex" {
				t.Fatalf("%s in %s changed the build data: %#v", endpoint, test.language, result)
			}
		}
	}
}

func TestTranslatedBuildLogHandlesTruncation(t *testing.T) {
	a, _ := testApp(t)
	run := &buildRun{result: Build{Status: "failed"}}
	a.appendMessageLocked(run, "[SyncTeX] この PDF に対応するデータを保存しました．\n")
	a.appendLogLocked(run, []byte(strings.Repeat("x", maxLogBytes-32)))
	a.appendMessageLocked(run, "\n[終了コード: %d]\n", 1)
	a.appendLogLocked(run, []byte("\n! TeX: 原稿フォルダーを開いてください．\n"))
	text := localizedBuildLog(run, "en")
	if !run.truncated || !strings.Contains(text, "[Exit code: 1]") || !strings.HasSuffix(text, "\n! TeX: 原稿フォルダーを開いてください．\n") || strings.Contains(text, "Saved the data for this PDF") {
		t.Fatalf("truncated log messages became misaligned: %q", text[max(0, len(text)-180):])
	}
}

func TestShortcutMessagesAndWrappedConflictsFollowTheRequestedLanguage(t *testing.T) {
	a, _ := testApp(t)
	a.shortcutCreator = func(string) (platform.ShortcutResult, error) {
		return platform.ShortcutResult{Executable: "日本語/app.exe", Shortcut: "日本語/app.lnk", Message: "次回からこのショートカットで起動できます．"}, nil
	}
	response := apiRequest(a, http.MethodPost, "/api/shortcuts", map[string]string{"destination": "desktop"}, map[string]string{"Accept-Language": "en"})
	var result platform.ShortcutResult
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &result) != nil || result.Message != "You can use this shortcut to open the app next time." || result.Shortcut != "日本語/app.lnk" {
		t.Fatalf("shortcut result: %d %s", response.Code, response.Body.String())
	}
	a.shortcutCreator = func(string) (platform.ShortcutResult, error) {
		return platform.ShortcutResult{}, messages.Errorf("アプリの保存先が通常のフォルダーではありません (%s)．%w", "日本語", platform.ErrShortcutConflict)
	}
	response = apiRequest(a, http.MethodPost, "/api/shortcuts", map[string]string{"destination": "desktop"}, map[string]string{"Accept-Language": "en"})
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "The app destination is not a regular folder (日本語). Check the file at the destination.") {
		t.Fatalf("wrapped shortcut conflict: %d %s", response.Code, response.Body.String())
	}
	if !errors.Is(messages.Errorf("%w", platform.ErrShortcutConflict), platform.ErrShortcutConflict) {
		t.Fatal("the localized wrapper changed conflict detection")
	}
}
