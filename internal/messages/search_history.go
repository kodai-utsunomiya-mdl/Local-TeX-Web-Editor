package messages

func init() {
	for japanese, translated := range map[string]string{
		"検索する文字列は 1～4096 バイト，置換後の文字列は 64 KiB 以内で入力してください．": "Enter 1–4096 bytes to search for, and at most 64 KiB of replacement text.",
		"正規表現を確認してください: %v": "Check the regular expression: %v",
		"正規表現のキャプチャは 64 個以内にしてください．": "Use at most 64 capturing groups in a regular expression.",
		"検索する原稿は 8 MiB 以内の UTF-8 にしてください．": "Search documents must contain UTF-8 text no larger than 8 MiB.",
		"置換するファイルを 1～1000 件選んでください．": "Choose between 1 and 1000 files to replace text in.",
		"コンパイルが終わってから置換してください．": "Wait for compilation to finish before replacing text.",
		"置換後の原稿は 8 MiB 以内の UTF-8 にしてください．": "The replacement document must contain UTF-8 text no larger than 8 MiB.",
		"同じファイルが複数回指定されています．": "The same file was included more than once.",
		"%s は検索した後に変更されました．検索し直してから置換してください．": "%s changed after the search. Search again before replacing text.",
		"原稿は保存しましたが，編集履歴を記録できませんでした: %v": "The document was saved, but its history could not be recorded: %v",
		"編集履歴の記録はオフになっています．": "Recording edit history is turned off.",
		"2 MiB を超える原稿は編集履歴の対象外です．": "Documents larger than 2 MiB are not recorded in edit history.",
		"履歴の名前は 100 文字以内，原稿は UTF-8 で指定してください．": "Use at most 100 characters for the version name and UTF-8 text for the document.",
		"履歴を保存する期間は 1～365 日，容量は 5～200 MiB で指定してください．": "Choose 1–365 days and 5–200 MiB for history storage.",
		"履歴の項目を選び直してください．": "Select the history entry again.",
		"この履歴は保存期間または容量の上限により削除されました．": "This version was removed because the history age or storage limit was reached.",
		"この履歴を読み取れません．別の版を選んでください．": "This version could not be read. Select another version.",
	} {
		english[japanese] = translated
	}
}
