package messages

func init() {
	for key, value := range map[string]string{
		"別の画面で保存情報が初期化されました．未保存の原稿を確認してから，画面を読み込み直してください．":    "Saved information was reset in another tab. Check your unsaved documents before reloading this page.",
		"保存情報の初期化が終わってから操作してください．":                            "Wait for the saved information to finish resetting before continuing.",
		"初期化する項目を 1 つ以上選び，確認してから実行してください．":                    "Select at least one item to reset and confirm before continuing.",
		"コンパイル，TeX の操作，フォルダー選択が終わってから初期化してください．":              "Wait for compilation, TeX operations, and folder selection to finish before resetting.",
		"保存情報の場所が通常のフォルダーではありません: %s":                         "The saved information is not in a regular folder: %s",
		"保存情報の項目が多いため，設定フォルダーの内容を確認してください．":                   "There are too many saved items. Check the contents of the settings folder.",
		"保存情報のファイルを確認できません: %s":                               "The saved information file could not be verified: %s",
		"前回の初期化の記録を読み取れません: %s":                               "The record of the previous reset could not be read: %s",
		"初期化の作業ファイルを確認できません: %s":                              "A temporary reset file could not be verified: %s",
		"初期化の作業フォルダーに別のファイルがあります: %s":                         "The temporary reset folder contains another file: %s",
		"初期化前の情報を戻す場所に別のファイルがあります: %s":                        "Another file exists where the information from before the reset would be restored: %s",
		"前回の初期化の後処理を完了できません: %w":                              "The previous reset could not finish its cleanup: %w",
		"初期化を中止しましたが，一部の情報を元の場所へ戻せませんでした: %v; %v":             "The reset was stopped, but some information could not be returned to its original location: %v; %v",
		"初期化は完了しましたが，作業ファイルを消去できませんでした．アプリを起動し直すと再度消去します: %v": "The reset is complete, but temporary files could not be removed. The app will try removing them again when it next starts: %v",
	} {
		english[key] = value
	}
}
