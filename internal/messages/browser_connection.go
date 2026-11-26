package messages

func init() {
	for japanese, translated := range map[string]string{
		"ブラウザの接続情報を作り直しました．以前のタブを閉じ，この画面を使ってください．":                                "The browser connection was recreated. Close the previous tab and use this page.",
		"以前の接続先 %s が使用中のため，%s で開きました．以前のタブを閉じ，この画面を使ってください．ブックマークもこのアドレスへ更新できます．": "The previous address %s is in use, so the editor opened at %s. Close the previous tab and use this page. You can also update your bookmark to this address.",
	} {
		english[japanese] = translated
	}
}
