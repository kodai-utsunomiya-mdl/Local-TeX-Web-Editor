package messages

func init() {
	for key, value := range map[string]string{
		"Microsoft Store から導入した Windows 版で更新できます．":      "Updates are available for the Windows edition installed from Microsoft Store.",
		"アプリの更新操作を選んでください．":                             "Choose an app update action.",
		"Microsoft Store の更新を取り消しました．":                  "The Microsoft Store update was cancelled.",
		"バッテリーを充電してから，Microsoft Store の更新を再開します．":       "Microsoft Store updates will resume after the battery is charged.",
		"通信の設定により，Microsoft Store の自動更新を待っています．":        "Automatic Microsoft Store updates are waiting for a suitable network connection.",
		"Microsoft Store の設定や通信の状態により，自動更新を待っています．":     "Automatic updates are waiting for Microsoft Store settings or a suitable network connection.",
		"Microsoft Store の更新を完了できませんでした (状態 %d)．":       "The Microsoft Store update could not be completed (state %d).",
		"Microsoft Store の更新画面を準備できません: %w":             "Could not prepare the Microsoft Store update window: %w",
		"Microsoft Store から更新の応答を受け取れませんでした．":           "Microsoft Store did not return an update response.",
		"更新後に開くアプリの起動引数が長すぎるか無効です．":                     "The command-line arguments for restarting the updated app are too long or invalid.",
		"Microsoft Store の更新を処理できません (HRESULT 0x%08X)．": "Could not process the Microsoft Store update (HRESULT 0x%08X).",
	} {
		english[key] = value
	}
}
