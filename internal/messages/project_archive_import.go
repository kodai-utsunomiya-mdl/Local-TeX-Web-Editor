package messages

func init() {
	for japanese, translated := range map[string]string{
		"ZIP ファイルと保存先を送信してください．":                       "Send a ZIP file and its destination.",
		"読み込む ZIP は 512 MiB 以内にしてください．":                "Choose a ZIP file no larger than 512 MiB.",
		"ZIP ファイルと保存先を読み取れませんでした．":                     "Could not read the ZIP file and its destination.",
		"ZIP ファイルと保存先をそれぞれ 1 つ指定してください．":               "Provide one ZIP file and one destination.",
		"読み込む ZIP ファイルを選んでください．":                       "Choose a ZIP file to import.",
		"保存先のフォルダーと新しいプロジェクト名を確認してください．":               "Check the destination folder and the new project name.",
		"ZIP ファイル，保存先，新しいプロジェクト名を指定してください．":            "Provide the ZIP file, destination folder, and new project name.",
		"ZIP 内に使用できないパスがあります: %s":                      "The ZIP contains a path that cannot be used: %s",
		"ZIP 内のファイルとフォルダーは合計 20,000 件以内にしてください．":       "The ZIP can contain up to 20,000 files and folders in total.",
		"ZIP 内のリンクや特殊なファイルは読み込めません: %s":                "Links and special files in a ZIP cannot be imported: %s",
		"暗号化された ZIP は読み込めません．パスワードを解除した ZIP を選んでください．": "Encrypted ZIP files cannot be imported. Choose a ZIP without password protection.",
		"ZIP 内のフォルダー情報が正しくありません: %s":                   "The ZIP contains invalid folder information: %s",
		"ZIP 内のファイルは 10,000 件以内にしてください．":               "The ZIP can contain up to 10,000 files.",
		"展開後のファイルは 1 個あたり 128 MiB 以内にしてください: %s":       "Each extracted file must be no larger than 128 MiB: %s",
		"ZIP を展開した内容は合計 512 MiB 以内にしてください．":            "The extracted project must be no larger than 512 MiB in total.",
		"ZIP 内に重複する名前や大文字小文字だけが異なる名前があります: %s":         "The ZIP contains duplicate names or names that differ only in letter case: %s",
		"同じ名前の項目があります．新しいプロジェクト名を選んでください．":             "An item with this name already exists. Choose a new project name.",
		"ZIP ファイルを読み取れません．正常な ZIP を選んでください．":           "Could not read the ZIP file. Choose a valid ZIP archive.",
		"ZIP 内のファイルを読み取れません: %s":                       "Could not read a file in the ZIP: %s",
		"ZIP 内のファイルが破損しているか，最後まで読み取れませんでした: %s":        "A file in the ZIP is damaged or could not be read completely: %s",
	} {
		english[japanese] = translated
	}
}
