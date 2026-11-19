package messages

func init() {
	for key, value := range map[string]string{
		"画像は 8 MiB 以内にしてください．": "Use an image up to 8 MiB.",
		"PDF の内容を読み取れません．": "Could not read the PDF contents.",
		"PNG または JPEG の画像を選んでください (最大 4000 万画素)．": "Choose a PNG or JPEG image with at most 40 million pixels.",
		"画像の形式とファイル名の拡張子を合わせてください．": "Match the filename extension to the image format.",
		"画像やテンプレートの保存先には通常のフォルダーを選んでください．": "Choose a regular folder for images and template files.",
		"画像の保存先には，文字，数字，空白，ハイフン，アンダースコアを使ってください．": "Use letters, numbers, spaces, hyphens, and underscores in the image destination.",
		"同じ名前の画像が多いため，別の名前を指定してください．": "Too many images share this name. Choose another filename.",
		"画像のデータを読み取れません．": "Could not read the image data.",
		"テンプレートの名前は 1〜80 文字で入力してください．": "Enter a template name between 1 and 80 characters.",
		"テンプレートの保存先が通常のフォルダーではありません．": "The template storage path is not a regular folder.",
		"テンプレートが見つかりません．": "The template was not found.",
		"テンプレートのファイルが大きすぎます．": "The template archive is too large.",
		"テンプレートには 200 個までのファイルを登録できます．": "A template can contain at most 200 files.",
		"テンプレートに通常のファイル以外が含まれています．": "The template contains an entry that is not a regular file.",
		"テンプレート内のファイル名が重複しています．": "The template contains duplicate filenames.",
		"テンプレート内のファイル名を読み取れません．": "Could not read a filename in the template.",
		"テンプレート内に使用できないファイル名があります．": "The template contains an unsupported filename.",
		"テンプレート内のファイルは 8 MiB 以内にしてください．": "Each template file must be at most 8 MiB.",
		"テンプレートの内容は合計 32 MiB 以内にしてください．": "Keep the total template contents within 32 MiB.",
		"テンプレートの内容を読み取れません．": "Could not read the template contents.",
		"テンプレートの説明を読み取れません．": "Could not read the template description.",
		"テンプレートの内容を確認してください．": "Check the template contents.",
		"テンプレートのメイン文書が見つかりません．": "The template's main document was not found.",
		"ユーザー用のテンプレートは 20 個までです．": "You can register up to 20 custom templates.",
		"テンプレートの合計が 128 MiB を超えます．使わないテンプレートを削除してください．": "The templates exceed 128 MiB in total. Delete templates you no longer use.",
		"同じテンプレートがすでに登録されています．": "A template with this identifier is already registered.",
		"標準のテンプレートは変更できません．": "Built-in templates cannot be changed.",
		"テンプレートの説明を短くしてください．": "Use a shorter template description.",
		"登録するファイルを 1〜200 個選んでください．": "Select between 1 and 200 files to register.",
		"登録するファイルを確認してください．生成した PDF や補助ファイルは含められません．": "Check the selected files. Generated PDFs and auxiliary files cannot be included.",
		"保存先のフォルダーを選んでください．": "Choose the destination folder.",
		"新しいプロジェクトのフォルダー名を入力してください．": "Enter a folder name for the new project.",
		"同じ名前のフォルダーがあります．新しい名前を選んでください．": "A folder with this name already exists. Choose a new name.",
	} {
		english[key] = value
	}
}
