package messages

func init() {
	for key, value := range map[string]string{
		"128 MiB を超えるファイルの名前変更と削除は，OS のファイル管理画面で行ってください．": "Rename or delete files larger than 128 MiB in your operating system's file manager.",
		"ファイルの内容が変更されました．一覧を更新してから操作してください．": "The file or folder changed. Refresh the file list before trying again.",
		"フォルダー内の項目が多いため，OS のファイル管理画面で名前を変更してください．": "This folder contains too many items. Rename it in your operating system's file manager.",
		"コンパイルが終了してからファイルを操作してください．": "Wait for compilation to finish before changing files or folders.",
		"同じ名前のファイルまたはフォルダーがすでにあります．": "A file or folder with this name already exists.",
		"変更先には別の名前を指定してください．": "Choose a different name or destination.",
		"編集できるテキスト形式の拡張子を指定してください．": "Choose a supported text file extension so the file can still be edited.",
		"名前を変更できません: %w": "Could not rename the file or folder: %w",
		"中に項目があるフォルダーは削除できません．空にしてから操作してください．": "This folder contains items. Empty it before deleting it.",
		"削除できません: %w": "Could not delete the file or folder: %w",
		"名前を変更しましたが，一部の編集履歴を移動できませんでした: %v": "The item was renamed, but some edit history could not be moved: %v",
	} {
		english[key] = value
	}
}
