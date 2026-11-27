package messages

func init() {
	for key, value := range map[string]string{
		"前回この版への更新に失敗しました．さらに新しい版を自動で確認します．同じ版への更新は手動で再試行できます．": "The previous update to this version failed. The app will check automatically for a newer version. You can retry this version manually.",
		"自動更新を有効にするか選んでください．":                    "Choose whether to enable automatic updates.",
		"自動更新を停止しました．":                           "Automatic updates are turned off.",
		"更新を延期する時間を選んでください．":                     "Choose when to resume the update.",
		"アプリの更新を適用しています．":                        "The application update is being installed.",
		"更新を 1 時間延期しました．":                        "The update is postponed for one hour.",
		"この起動方法ではアプリの自動更新を利用できません．":              "Automatic updates are unavailable with this launch method.",
		"アプリの更新用接続を確認できません．":                     "The application update connection could not be verified.",
		"更新の状態を読み取れません．":                         "The update status could not be read.",
		"編集画面との接続を確認してから更新します．":                  "The app will update after the editor connection is ready.",
		"編集中の操作やコンパイルが終わってから更新してください．":           "Wait for editing operations and compilation to finish before updating.",
		"更新のダウンロードが完了するまでお待ちください．":               "Wait for the update download to finish.",
		"開いている編集画面の保存が終わってから更新します．":              "The app will update after the open editors finish saving.",
		"開いている編集画面の保存状況を確認しています．":                "Checking that all open editors have saved their work.",
		"更新前の確認をもう一度行います．":                       "The app will check the open editors again before updating.",
		"未保存の原稿や実行中の操作があるため，更新を待っています．":          "The update is waiting for unsaved documents and active operations.",
		"アプリを更新しています．":                           "Updating the application.",
		"Microsoft Store の設定や接続状況により，更新を待っています．": "The update is waiting for Microsoft Store settings or network access.",
		"編集を再開できます．":                             "You can continue editing.",
		"アプリを更新しています．編集画面は自動で再接続します．":            "Updating the application. The editor will reconnect automatically.",
	} {
		english[key] = value
	}
}
