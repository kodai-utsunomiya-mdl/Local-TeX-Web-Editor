package messages

func init() {
	for key, value := range map[string]string{
		"ZIP に含める項目が多すぎます．原稿を含むフォルダーを直接選んでください．":     "There are too many entries to archive. Open the folder containing the manuscript directly.",
		"ZIP に含めるファイル名を確認してください: %s":                 "Review this file name before exporting the project ZIP: %s",
		"ZIP に含める名前が大文字小文字の違いで重複しています: %s / %s":      "These names differ only in letter case and cannot be exported together: %s / %s",
		"ZIP に含める 1 ファイルは 128 MiB 以内にしてください: %s":     "Each file in the ZIP must be 128 MiB or smaller: %s",
		"ZIP に含めるファイルは合計 512 MiB，10,000 件以内にしてください．": "The project ZIP can include up to 10,000 files totalling 512 MiB.",
		"ZIP に含めるファイルとフォルダーは合計 20,000 件以内にしてください．":   "The project ZIP can include up to 20,000 files and folders in total.",
		"作成する ZIP は 512 MiB 以内にしてください．":              "The resulting ZIP must be 512 MiB or smaller.",
		"ZIP にするプロジェクトを開いてから，もう一度操作してください．":          "Open the project to export, then try again.",
		"ZIP の保存先には .zip ファイル名を指定してください．":            "Choose a file name ending in .zip for the exported project.",
		"プロジェクトの ZIP を保存できません: %w":                   "Could not save the project ZIP: %w",
	} {
		english[key] = value
	}
}
