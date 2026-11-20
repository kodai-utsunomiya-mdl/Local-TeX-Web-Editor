package messages

func init() {
	for key, value := range map[string]string{
		"プロジェクトの場所を確認できません．フォルダーを選び直してください．": "The project location could not be checked. Select its folder again.",
		"この場所にプロジェクトフォルダーがありません．移動先を選ぶか，ドライブの接続を確認してください．": "The project folder is no longer at this location. Select its new location or check that its drive is connected.",
		"プロジェクトフォルダーを読み取れません．アクセス権やドライブの接続を確認してください: %w": "The project folder could not be read. Check its permissions and drive connection: %w",
		"プロジェクトの場所にファイルがあります．原稿を含むフォルダーを選び直してください．": "This project location now contains a file. Select the folder containing your documents again.",
		"プロジェクトの場所が別のフォルダーへのリンクに変わりました．実際の場所を選び直してください．": "The project location has become a link to another folder. Select the actual folder again.",
		"最近のプロジェクトの一覧を保存できません: %w": "The recent projects list could not be saved: %w",
	} {
		english[key] = value
	}
}
