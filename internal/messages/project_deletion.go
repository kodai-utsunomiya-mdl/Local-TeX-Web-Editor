package messages

func init() {
	for key, value := range map[string]string{
		"リンクを経由したフォルダーは削除できません．実際のプロジェクトを開いてから操作してください．": "Folders reached through a link cannot be deleted here. Open the actual project folder first.",
		"削除するプロジェクトのフォルダーが見つかりません．": "The project folder to delete could not be found.",
		"開いているプロジェクトか，最近使ったプロジェクトを選んでください．": "Choose the current project or one of your recent projects.",
		"ホーム，設定，アプリのフォルダーを含む場所は削除できません．原稿だけを含むプロジェクトを選んでください．": "A location containing your home, app settings, or the application cannot be deleted. Choose a project folder containing your manuscript files.",
		"開いている別のプロジェクトとフォルダーが重なっています．削除するプロジェクトを開いてから操作してください．": "This folder overlaps another open project. Open the project you want to delete first.",
		"保存した草稿や編集位置のファイルを読み取れません．": "The saved draft or editing position file could not be read.",
		"保存した草稿のファイル名を読み取れません．草稿を確認してから削除してください．": "The file names in the saved drafts could not be read. Review the drafts before deleting the project.",
		"確認後に草稿が変更されたため，その草稿を残しました．": "A draft changed after confirmation and was left in place.",
		"削除するプロジェクトのフォルダー名を正確に入力してください．": "Enter the exact name of the project folder to delete.",
		"コンパイルが終了してからプロジェクトを削除してください．": "Wait for compilation to finish before deleting the project.",
		"プロジェクトの内容や草稿が変更されました．現在の項目を確認してから，もう一度削除してください．": "Project files or drafts changed. Review the current items before confirming deletion again.",
		"プロジェクトを削除しましたが，一部の設定，草稿，PDF の記録を消去できませんでした: %v": "The project was deleted, but some settings, drafts, or saved PDF files could not be removed: %v",
	} {
		english[key] = value
	}
}
