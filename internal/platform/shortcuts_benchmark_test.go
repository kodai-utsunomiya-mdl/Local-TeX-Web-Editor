package platform

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func BenchmarkRefreshInstalledExecutable(b *testing.B) {
	for _, checks := range []int{1, 3} {
		name := "once"
		if checks == 3 {
			name = "for_each_shortcut"
		}
		b.Run(name, func(b *testing.B) {
			directory := b.TempDir()
			source := filepath.Join(directory, shortcutExecutableName)
			if err := os.WriteFile(source, bytes.Repeat([]byte("MZ application "), (18<<20)/15), 0600); err != nil {
				b.Fatal(err)
			}
			if _, err := installShortcutExecutable(source, directory); err != nil {
				b.Fatal(err)
			}
			b.ReportAllocs()
			b.ResetTimer()
			for iteration := 0; iteration < b.N; iteration++ {
				for index := 0; index < checks; index++ {
					if _, err := installShortcutExecutable(source, directory); err != nil {
						b.Fatal(err)
					}
				}
			}
		})
	}
}
