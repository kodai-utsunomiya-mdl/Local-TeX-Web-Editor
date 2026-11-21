package messages

func init() {
	for key, value := range map[string]string{
		"コンパイル結果や補助ファイルが変更されました．現在の内容を確認してから，もう一度削除してください．": "The compiled output or auxiliary files changed. Review the current files before confirming deletion again.",
		"コンパイル結果の項目が多いため，出力先のファイルを確認してください．": "There are too many output files to delete here. Review the files in the output folder.",
		"選択した PDF が一覧から変更されました．一覧を読み直してから操作してください．": "The selected PDF is no longer in the list. Refresh the list before continuing.",
		"別の画面でコンパイルしています．完了後に PDF の一覧を読み直してください．": "Another instance is compiling this project. Refresh the PDF list after it finishes.",
		"コンパイルした PDF の TeX ファイルを選んでください．": "Choose the TeX file associated with a compiled PDF.",
		"コンパイルが終了してから PDF を削除してください．": "Wait for compilation to finish before deleting the PDF.",
	} {
		english[key] = value
	}
}
