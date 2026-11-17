package messages

import (
	"errors"
	"os"
	"strings"
	"testing"
)

func TestWrappedExplanationsTranslateWithoutChangingPathsOrSystemErrors(t *testing.T) {
	path := "/原稿フォルダーを開いてください．/draft.tex"
	cause := &os.PathError{Op: "open", Path: path, Err: os.ErrPermission}
	message := Errorf("保存できません: %w", Errorf("ファイルを開けません (%s): %w", path, cause))
	if !errors.Is(message, os.ErrPermission) {
		t.Fatal("the wrapped filesystem error is no longer available")
	}
	english := ErrorText("en", message)
	if !strings.HasPrefix(english, "Could not save: Could not open the file (") || strings.Count(english, path) != 2 || !strings.Contains(english, cause.Error()) {
		t.Fatalf("translated explanation changed the original data: %s", english)
	}
	if ErrorText("ja", message) != message.Error() || !strings.HasPrefix(message.Error(), "保存できません: ファイルを開けません (") {
		t.Fatalf("the Japanese explanation changed: %s", message)
	}
	if got := ErrorText("en", errors.New("原稿フォルダーを開いてください．")); got != "原稿フォルダーを開いてください．" {
		t.Fatalf("an unstructured external error was translated: %s", got)
	}
}

func TestLanguageUsesTheSupportedPreferenceAndJapaneseDefault(t *testing.T) {
	for _, example := range []struct{ header, want string }{
		{"", "ja"}, {"en", "en"}, {"ja", "ja"}, {"en-US,en;q=0.9,ja;q=0.8", "en"},
		{"fr,en;q=0.6,ja;q=0.9", "ja"}, {"en;q=0,ja;q=0.1", "ja"}, {"fr,de", "ja"},
		{"EN-gb;q=0.8,ja;q=0.7", "en"}, {"en;q=invalid,ja", "ja"},
	} {
		if got := Language(example.header); got != example.want {
			t.Errorf("Language(%q) = %q, want %q", example.header, got, example.want)
		}
	}
}
