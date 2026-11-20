package messages

func init() {
	for key, value := range map[string]string{
		"追加するファイルは 1 個あたり 128 MiB 以内にしてください．": "Choose files up to 128 MiB each.",
		"同じ名前の項目があります．保存先と置き換える内容を確認してください．": "An item with this name already exists. Review the destination and the content to replace.",
		"コピー先の内容が変更されました．保存先をもう一度確認してください．": "The destination changed. Review it again before copying the file.",
		"128 MiB を超えるファイルのコピー，名前変更，削除は，OS のファイル管理画面で行ってください．": "Copy, rename, or delete files larger than 128 MiB in your operating system's file manager.",
		"ファイルの操作を確認してください．": "Check the file operation and try again.",
		"コピー先には，元のフォルダーの外にある新しい名前を指定してください．": "Choose a new destination outside the original folder.",
		"コピー先のフォルダーが変更されました．保存先をもう一度確認してください．": "The destination folder changed. Review it again before copying.",
		"コピーを作成できません: %w": "Could not create the copy: %w",
		"ファイルの内容が変更されました．一覧を更新してから操作してください．": "The file or folder changed. Refresh the file list before trying again.",
		"フォルダー内の項目が多いため，OS のファイル管理画面で操作してください．": "This folder contains too many items. Use your operating system's file manager.",
		"コンパイルが終了してからファイルを操作してください．": "Wait for compilation to finish before changing files or folders.",
		"同じ名前のファイルまたはフォルダーがすでにあります．": "A file or folder with this name already exists.",
		"変更先には別の名前を指定してください．": "Choose a different name or destination.",
		"編集できるテキスト形式の拡張子を指定してください．": "Choose a supported text file extension so the file can still be edited.",
		"名前を変更できません: %w": "Could not rename the file or folder: %w",
		"ファイルやフォルダーの内容が変更されました．現在の項目を確認してから，もう一度操作してください．": "The file or folder changed. Review the current items before confirming the action again.",
		"削除を完了できませんでした．残っている項目を確認してから，もう一度操作してください: %v": "Deletion could not finish. Review the remaining items before trying again: %v",
		"削除できません: %w": "Could not delete the file or folder: %w",
		"名前を変更しましたが，一部の編集履歴を移動できませんでした: %v": "The item was renamed, but some edit history could not be moved: %v",
	} {
		english[key] = value
	}
}
