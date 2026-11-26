package messages

func init() {
	for key, value := range map[string]string{
		"ログイン時の自動起動は Windows と Mac の通常の設定フォルダーで利用できます．":                        "Start at login is available on Windows and Mac when using the app's standard settings folder.",
		"自動起動の登録先に別のファイルがあります．内容を確認してください．":                                    "Another file is using the startup registration path. Check its contents before continuing.",
		"ログイン時の自動起動は無効です．":                                                     "Start at login is disabled.",
		"ログイン時にバックグラウンドで起動します．ブラウザで前回のタブを復元すると編集画面へ戻れます．":                      "The app will start in the background when you log in. Restore your browser tabs to return to the editor.",
		"Windows の設定で自動起動が無効になっています．スタートアップの設定でこのアプリを有効にしてください．":               "Windows has disabled start at login. Enable this app in Windows Startup settings.",
		"ログイン時の起動設定を%sできません (HRESULT 0x%08X)．":                                 "Could not %s the startup setting (HRESULT 0x%08X).",
		"Windows から起動設定の応答を受け取れませんでした．":                                        "Windows did not return a startup setting response.",
		"ログイン時の起動設定がキャンセルされました．":                                               "Changing start at login was cancelled.",
		"Windows の起動設定から応答がありません．もう一度お試しください．":                                 "Windows startup settings did not respond. Try again.",
		"Windows の管理設定で自動起動が無効になっています．":                                        "Windows administration settings have disabled start at login.",
		"Windows の管理設定でログイン時に起動します．":                                           "Windows administration settings enable start at login.",
		"Windows のスタートアップ設定で状態を確認してください．":                                      "Check this app's state in Windows Startup settings.",
		"ログイン時に起動するには，アプリケーションフォルダーの Local TeX Web Editor.app から設定してください．":     "To enable start at login, open Local TeX Web Editor.app from Applications and change this setting there.",
		"macOS のシステム設定でログイン項目を開き，Local TeX Web Editor のバックグラウンドでの実行を許可してください．": "Open Login Items in macOS System Settings and allow Local TeX Web Editor to run in the background.",
		"自動起動を登録しました．macOS のシステム設定のログイン項目で，バックグラウンドでの実行を確認してください．":             "Start at login is registered. Check background execution under Login Items in macOS System Settings.",
		"macOS のログイン項目を登録できません: %w":                                            "Could not register the macOS login item: %w",
		"ログイン時の起動を有効にするか選んでください．":                                              "Choose whether to enable start at login.",
		"ログイン時の起動設定を処理しています．完了してから操作してください．":                                   "The startup setting is being processed. Wait for it to finish before continuing.",
		"この環境では OS の起動設定を開けません．":                                               "System startup settings cannot be opened in this environment.",
		"ログイン時の起動は OS が管理しています．OS の起動設定で確認してください．":                             "The operating system manages start at login. Check its startup settings.",
		"設定は初期化しましたが，ログイン時の起動を変更できませんでした: %w":                                  "Settings were reset, but start at login could not be changed: %w",
	} {
		english[key] = value
	}
}
