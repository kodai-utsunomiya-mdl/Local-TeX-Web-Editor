package messages

func init() {
	for key, value := range map[string]string{
		"ダウンロードまたは保存するファイルを 1 個選んでください．":            "Choose one file to download or save.",
		"保存先の絶対パスを指定してください．":                        "Choose an absolute path for the destination.",
		"保存先には通常のフォルダーを選んでください．":                    "Choose a regular folder for the destination.",
		"保存先には通常のファイル名を選んでください．":                    "Choose a regular file name for the destination.",
		"保存先が変更されました．名前を付けて保存をもう一度選び，保存先を確認してください．": "The destination changed. Choose Save As again and review the destination.",
		"ファイルを保存できません: %w":                          "Could not save the file: %w",
	} {
		english[key] = value
	}
}
