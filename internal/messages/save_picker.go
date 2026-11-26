package messages

func init() {
	for source, translation := range map[string]string{
		"名前を付けて保存":        "Save As",
		"保存するファイル名が無効です．": "The suggested file name is invalid.",
		"保存先の選択画面が開いています．保存またはキャンセルしてから，もう一度実行してください．": "A Save As dialog is already open. Save or cancel it before trying again.",
		"この OS では「ダウンロード」を使って保存してください．":                "Use Download to save files on this operating system.",
		"保存先の選択画面を%sできません (HRESULT 0x%08X)．":           "Could not %s the Save As dialog (HRESULT 0x%08X).",
		"選択した保存先のパスを取得できません．":                          "Could not get the selected destination path.",
		"保存先の選択画面を開けません: %w":                           "Could not open the Save As dialog: %w",
		"保存先の選択画面を開けません: %s (%w)":                      "Could not open the Save As dialog: %s (%w)",
		"選択した保存先を取得できません: %w":                          "Could not get the selected destination: %w",
	} {
		english[source] = translation
	}
}
