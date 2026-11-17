# Local TeX Editor

[English](README.md) | 日本語

[![Windows 版をダウンロード](docs/download-windows.svg)](https://github.com/kodai-utsunomiya-mdl/local-tex-editor/releases/download/v0.1.4/local-tex-editor-0.1.4-windows-x64.zip)
[![macOS 版をダウンロード](docs/download-macos.svg)](https://github.com/kodai-utsunomiya-mdl/local-tex-editor/releases/download/v0.1.4/local-tex-editor-0.1.4-macos-universal.zip)

**v0.1.4** · [配布ファイルと更新内容](https://github.com/kodai-utsunomiya-mdl/local-tex-editor/releases/latest) · [利用前の準備](#利用前の準備) · [起動する](#ダウンロードして起動する)

Windows と macOS のブラウザで TeX の原稿を編集し，PC にある TeX Live でコンパイルするアプリ．編集画面と PDF を同じウィンドウで確認できる．アプリを起動すると，既定のブラウザで `localhost` の画面が開く．Markdown の編集とプレビューにも対応する．

![ダークモードで TeX の原稿と PDF を並べて表示した Local TeX Editor](docs/screenshots/editor-dark.png)

原稿は PC 上のフォルダーに保存する．TeX Live と原稿の `latexmkrc` を使い，コンパイル中のログと生成した PDF を画面へ表示する．利用する PC に追加の Python，Node.js，Go，VS Code を導入する必要はない．

## 作成した経緯

このアプリは，作者が TeX の原稿を書くために複数のエディタを使ってきた経験から作り始めた．

- **Overleaf:** 長い原稿がコンパイル時間の上限に達し，複数行の文章をひとまとまりで貼り付けて検索する操作にも不便を感じていた．ブラウザで編集する使い方には利点を感じていた．
- **VS Code:** 既存の TeX Live でコンパイルできる環境は整っていた．TeX の執筆だけに使うには開発向けの機能が多く，メモリに余裕が少ない PC では，デスクトップ版の起動も重く感じていた．
- **Prism:** ブラウザで執筆する場所として使っていた．OpenAI による [2027 年 1 月 1 日にサービスを終了するという告知](https://openai.com/index/introducing-prism/) を受け，作業を続けるための環境を探すことになった．

PC にはすでに TeX Live があった．その環境をブラウザのエディタから使い，PDF の連続スクロール，原稿と PDF の相互移動，複数行の検索，Markdown のプレビューを同じ画面で使えるようにしたのが Local TeX Editor である．普段の執筆を快適に進められることと，手元のツールや原稿をそのまま使えることを目指している．

## 利用前の準備

コンパイルには，PC に導入済みの TeX Live を使う．すでに別のエディタから原稿をコンパイルできている場合は，その TeX Live の場所を指定すればよい．

| 項目 | Windows | macOS |
| --- | --- | --- |
| OS と CPU | Windows 10 / 11，64-bit (x64) | macOS 12 Monterey 以降，Apple Silicon または Intel |
| ブラウザ | 現行の Chrome または Edge | 現行の Chrome または Edge |
| TeX の配布物 | [TeX Live](https://tug.org/texlive/windows.html) | [BasicTeX / MacTeX](https://tug.org/mactex/) または必要なパッケージを導入した TeX Live |
| TeX の場所の例 | `C:\texlive\2025\bin\windows` | `/Library/TeX/texbin` |
| 原稿 | PC にあるプロジェクトのフォルダー | PC にあるプロジェクトのフォルダー |

macOS 版の最低 OS は，アプリのビルドに使う [Go 1.25 の対応 OS](https://go.dev/doc/go1.25#darwin) に基づく．MacTeX の GUI アプリ向けの TeX の場所は，公式の [What Is Installed](https://tug.org/mactex/What_Is_Installed.pdf) で案内されている．

### TeX に必要なプログラム

| プログラム | 用途 |
| --- | --- |
| `latexmk` | 原稿のコンパイルと，引用・相互参照のための再実行 |
| `pdflatex`，`uplatex`，`xelatex`，`lualatex` など | 原稿とコンパイラーの設定に合う TeX の実行 |
| `synctex` | PDF と原稿の対応する位置へ移動する操作 |
| `bibtex`，`upbibtex`，`biber` など | 原稿で採用している方法による参考文献の処理 |
| 原稿が使うパッケージとフォント | `\usepackage`，文書クラス，日本語フォントなどの読み込み |

upLaTeX の原稿では通常 `uplatex` と `dvipdfmx` を使い，参考文献の設定に応じて `upbibtex` なども使う．プロジェクトにある `latexmkrc` / `.latexmkrc` を一緒に用意する．

### 小さめの構成から始める

このアプリでは，TeX Live の一部を導入した環境を使える．最初に基本的なパッケージをまとめて入れ，原稿で必要になったものを TeX Live Manager (`tlmgr`) で追加していく．

**Windows** では，[TeX Live のネットワークインストーラー](https://tug.org/texlive/acquire-netinstall.html) を開き，`Advanced` からインストールする `scheme` を選ぶ．`small` は基本的な LaTeX にいくつかのプログラムや言語を加えた構成，`medium` はそこからパッケージを増やした構成である．必要な `collection` を個別に選ぶこともできる．公式の [インストールガイド](https://tug.org/texlive/doc/texlive-en/texlive-en.html) に選択画面と各構成の説明がある．

**Mac** では，[BasicTeX](https://tug.org/mactex/morepackages.html) が `scheme-small` に基づく構成を提供する．インストール後は `/Library/TeX/texbin/tlmgr` で必要なものを追加できる．[BasicTeX の公式説明](https://tug.org/mactex/BasicTeX.pdf) も参照できる．

日本語の原稿には `collection-langjapanese`，このエディタのコンパイルには `latexmk`，原稿と PDF の相互移動には `synctex` を追加する．`collection-langjapanese` は日本語のエンジン，文書クラス，フォントと，それらが使うパッケージをまとめて追加する．数式・図・文献管理などのパッケージは，原稿に応じて追加する．

容量を抑える設定として，TeX Live のインストーラーでは package のドキュメントとソースの収録を外せる．すでに導入済みの場合は `tlmgr option docfiles 0` と `tlmgr option srcfiles 0` で，今後の追加時の設定を変えられる．これは今あるファイルを削除する操作ではない．詳細は [install-tl のマニュアル](https://tug.org/texlive/doc/install-tl.html) にある．

### 後からパッケージを追加する

アプリの **設定 → TeX パッケージを追加** には，見つかったプログラムと追加コマンドを表示する．`latexmk` / SyncTeX と日本語の組版を選べるほか，パッケージ名を入力できる．コマンドをコピーし，Windows では PowerShell，Mac ではターミナルで実行する．設定済みの TeX の場所と確認できた年度に合わせてコマンドを作る．旧年度にはその年度の `tlnet-final` を指定する．

現行年度の TeX Live へ追加する例は次の通り．Windows のパスは実際の導入先に合わせる．

```powershell
& 'C:\texlive\2026\bin\windows\tlmgr.bat' update --self
& 'C:\texlive\2026\bin\windows\tlmgr.bat' install latexmk synctex synctex.windows collection-langjapanese
```

```sh
sudo /Library/TeX/texbin/tlmgr update --self
sudo /Library/TeX/texbin/tlmgr install latexmk synctex collection-langjapanese
```

MacTeX / BasicTeX の標準の導入先では，書き込みに `sudo` を使う．自分のユーザーフォルダーへ TeX Live を導入した場合は，アプリ内で `sudo` を外したコマンドも作れる．Windows で書き込み権限のエラーが出た場合は，TeX Live を導入したユーザーと場所を確認し，必要に応じて管理者の PowerShell で同じコマンドを実行する．

例えば `File 'siunitx.sty' not found` と表示された場合は，`tlmgr search --global --file '/siunitx\.sty$'` でそのファイルを収録するパッケージを調べ，結果に出た名前を `tlmgr install siunitx` の形で追加する．ファイル名とパッケージ名が異なる場合もある．アプリ内の「不足しているファイルからパッケージを探す」にファイル名を入れると，検索用のコマンドをコピーできる．[tlmgr のマニュアル](https://tug.org/texlive/doc/tlmgr.html) に `search` と `install` の説明がある．

原稿と一緒に配布された独自の `.sty` や `.cls` は，配布元から取得してプロジェクトへ置く．追加が終わったらアプリの設定を開き直し，原稿を再コンパイルする．登録済みなのに実行ファイルが欠けている場合には，アプリ内の再取得のチェックを入れるか，`tlmgr install --reinstall` を使う．SyncTeX の例は後の「SyncTeX を追加する」を参照する．

### 導入済みの TeX を確認する

Windows の PowerShell では，実際に導入した年度と場所に合わせて実行する．

```powershell
& 'C:\texlive\2025\bin\windows\latexmk.exe' -v
& 'C:\texlive\2025\bin\windows\synctex.exe' help
```

Mac のターミナルでは次を実行する．

```sh
/Library/TeX/texbin/latexmk -v
/Library/TeX/texbin/synctex help
```

バージョンと使い方が表示されたら，アプリの設定に同じ TeX のフォルダーを指定する．MacTeX / BasicTeX でこの 2 つのプログラムを追加する場合は，`sudo /Library/TeX/texbin/tlmgr install latexmk synctex` を使える．旧年度の TeX Live へ追加する際の取得先については，後の「SyncTeX を追加する」を参照する．

## ダウンロードして起動する

### Windows

1. [Releases](https://github.com/kodai-utsunomiya-mdl/local-tex-editor/releases) を開き，最新のバージョンを選ぶ．
2. **Assets** の `local-tex-editor-0.1.4-windows-x64.zip` をダウンロードする．`Source code` は開発用のソースである．
3. ZIP を展開し，`local-tex-editor.exe` をダブルクリックする．
4. 開いたブラウザで原稿のフォルダーを選ぶ．フォルダーのパスを入力して開くこともできる．
5. TeX Live の場所が自動で見つからない場合は，設定に `C:\texlive\2025\bin\windows` など，`latexmk.exe` があるフォルダーを指定する．
6. コンパイルしたい `.tex` をエディタで開き，「コンパイル」を押す．

Windows の配布ファイルにはコード署名が付いていない．GitHub のリリースから取得したファイルを開く際に SmartScreen の「Windows によって PC が保護されました」が出た場合は，「詳細情報」でアプリ名を確認し，「実行」を選ぶ．[Microsoft の案内](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/publish-first-app) も参照できる．

### macOS

1. [Releases](https://github.com/kodai-utsunomiya-mdl/local-tex-editor/releases) の **Assets** から `local-tex-editor-0.1.4-macos-universal.zip` をダウンロードする．Apple Silicon と Intel で共通の ZIP を使う．
2. ZIP を展開し，`Local TeX Editor.app` を「アプリケーション」フォルダーへ移す．
3. Finder や Spotlight から `Local TeX Editor` を開く．ブラウザに編集画面が開く．
4. 原稿のフォルダーを開く．TeX の場所が自動で見つからない場合は，設定に `/Library/TeX/texbin` を指定する．
5. コンパイルしたい `.tex` をエディタで開き，「コンパイル」を押す．

macOS 版には Apple Developer ID による署名と notarization が付いていない．初回に開けない場合は，このリポジトリの Release から取得したアプリであることを確認したうえで，macOS の「システム設定 → プライバシーとセキュリティ → このまま開く」を使う．手順は [Apple の公式案内](https://support.apple.com/ja-jp/102445) にある．

### プロジェクトを開き，作業を終了する

例えば，Overleaf にあるような原稿は，プロジェクトのソースを ZIP としてダウンロードして展開し，そのフォルダーを開く．GitHub などから取得した原稿を開く場合も，`.tex`，`.bib`，画像，`latexmkrc` などを含むプロジェクトのフォルダーを指定する．

最後の編集タブを閉じると，約 5 秒後にコンパイル中の処理とアプリが終了する．ページを再読み込みして接続が戻った場合や，別の編集タブが開いている場合は，そのまま動作を続ける．原稿に未保存の編集がある場合は，ブラウザの確認画面が出る．草稿は編集中にも PC に記録され，次回の起動で読み込まれる．

右上の終了ボタンからもアプリを終了できる．未保存の編集がある場合は，保存するか草稿に残すかを選べる．ブラウザが自動で閉じる操作を認めない場合は，終了したことを画面に表示するので，Windows では `Ctrl + W`，Mac では `Cmd + W` でタブを閉じる．

### 更新する

Windows では，新しい ZIP を展開して `.exe` を起動する．異なるバージョンが動いている場合は，起動中のバージョンと今回開いたバージョンが表示される．原稿を保存して旧版を終了すると，新版の画面が開く．設定画面の「アプリのバージョン」と「起動中の実行ファイル」で，動いているアプリを確認できる．

Mac では，原稿を保存してアプリを終了し，展開した新しい `Local TeX Editor.app` を「アプリケーション」にある旧版と置き換えてから開く．設定と草稿はユーザーの設定フォルダーから読み込む．

同じバージョンのアプリをもう一度開くと，既存の編集画面へ接続する．同じ原稿を複数のプロセスが同時にコンパイルすることを防ぐ仕組みも入れている．

### スタートメニューやデスクトップから開く (Windows)

1. アプリの「設定」を開く．
2. 「起動用のショートカット」で「スタートメニューに追加」または「デスクトップに作成」を押す．
3. 次回から，スタートメニューで `Local TeX Editor` を探すか，デスクトップのショートカットを開く．ブラウザに編集画面が開く．

この操作で，アプリを `%LOCALAPPDATA%\Programs\LocalTeXEditor\local-tex-editor.exe` に配置する．ダウンロード時のフォルダーを移動しても，ショートカットから起動できる．設定と草稿は共通の場所から読み込む．

実行ファイル，ショートカット，ブラウザのタブには，緑の背景に白い TeX の専用アイコンを使う．

新しい ZIP の `.exe` を起動すると，配置済みのアプリと，スタートメニューやデスクトップに作成済みのショートカットが更新される．次回も同じショートカットから新版を起動できる．

## 原稿を編集する

初回の表示言語は English である．**Settings → Language → 日本語** で切り替えられ，保存した言語は次回の起動にも反映する．切り替える対象はアプリの画面と案内であり，原稿，PDF，Markdown の本文は入力した内容を表示する．

左側のファイル一覧から `.tex`，`.bib` などを開く．複数のファイルはタブで切り替えられる．編集画面と PDF の間にある境界をドラッグすると，それぞれの幅を変更できる．右上のボタンでライト／ダークを切り替えられる．設定ではエディタの文字サイズを 8〜40 px に変更できる (既定は 14 px)．テーマと文字サイズの選択は，次回の起動でも同じになる．

フォルダーは左側の一覧で展開できる．画像や PDF を選ぶと，原稿と同じタブ欄でプレビューを開く．原稿のタブへ戻ると，編集中の内容とカーソルの位置から作業を続けられる．

文字を選択すると，選択範囲に背景色が付く．ライト／ダークの両方で，現在の行やエディタからフォーカスを移した後の範囲も確認できる．

| 操作 | 使い方 |
| --- | --- |
| ファイルや見出しを探す | 左側の検索欄を使う．「アウトライン」タブでは，原稿の節・小節をクリックしてその行へ移動できる |
| 引用を入力する | `\citep{` や `\cite{` の中で，プロジェクト内の `.bib` にあるキーが候補になる．著者・年・題名も確認できる |
| 相互参照を入力する | `\ref{`，`\eqref{`，`\cref{` などの中で，原稿の `\label` が候補になる |
| 補完を呼び出す | `Ctrl + Space` を押す．TeX のコマンドも補完できる |
| 原稿を検索・置換する | エディタで `Ctrl + F` を押す，または「検索」を押す．複数行をそのまま貼り付けられる |
| 原稿の文字を拡大・縮小する | エディタ上で `Ctrl + ホイール`，タッチパッドのピンチ，またはタッチ画面の 2 本指で操作する．設定の文字サイズにも反映される |
| ファイルを保存する | `Ctrl + S` を押す．開いているファイルをすべて保存する操作は `Ctrl + Shift + S` |
| コンパイルする | `Ctrl + Enter`，または「コンパイル」を押す．ファイルを保存してから，編集対象の TeX 文書をコンパイルする |
| エラーの行へ移動する | ログの上に表示されるファイル名と行番号をクリックする |

Mac では，保存・検索・コンパイル・SyncTeX のクリック操作に使う `Ctrl` を `Cmd` に読み替える．ホイールでの拡大・縮小は `Ctrl + ホイール` を使い，トラックパッドではピンチ操作を使える．

検索欄と置換欄では，改行と TeX の `\` を入力どおりに扱う．`Enter` で次の一致箇所へ，`Shift + Enter` で前へ移動する．欄の中で改行を入力するには `Ctrl + Enter` を使う．正規表現は検索欄のチェックボックスから有効にできる．

文字サイズやテーマの変更は，原稿の内容とコンパイル済みの PDF に影響しない．PDF の更新案内は，原稿またはコンパイルの設定に変更がある場合に表示される．

### 自動保存と作業の再開

自動保存は初期状態でオンになっている．入力が落ち着いた時点で，原稿のファイルへ保存する．コンパイル中も編集を続けられ，自動保存はコンパイルの終了を待って実行する．設定から自動保存をオフにして，手動で保存することもできる．

編集中の草稿は，原稿のファイルへの保存とは別に PC へ記録する．アプリを開き直した際に前回の草稿があれば，「草稿を確認」が表示される．ファイルと草稿の内容を見比べてから「草稿をエディタで開く」を選ぶ．別のアプリが原稿を書き換えた場合には，ディスクと編集中の内容を確認する画面から，保存する内容を選べる．

次回の起動では，前回のプロジェクト，開いていた原稿のカーソル位置，PDF のページと倍率を読み戻す．前回成功した PDF も表示できるので，読み返すためにコンパイルを待つ必要はない．

### Markdown を編集する

プレビューの種類が「自動」のとき，`.md` または `.markdown` を開くと，右側に Markdown のプレビューを表示する．入力に合わせて本文を更新し，見出し，箇条書き，表，コードブロック，チェック項目，リンク，画像，数式を表示する．「プレビュー」または `Ctrl + Enter` を押すと，原稿を保存して表示を更新する．

プレビュー上部で「自動・PDF・Markdown」を選べる．「PDF」を選ぶと，PDF を読みながら Markdown を編集できる．「Markdown」を選ぶと，TeX のタブへ移っても最後に編集した Markdown を表示する．選んだ表示は，原稿の保存やコンパイルの後も続く．「自動」に戻すと，編集中のファイルに合わせて表示を切り替える．この選択は，次回そのプロジェクトを開いたときにも読み込む．

数式には `$...$`，GitHub のドル記号とバッククォートで囲む形式，`$$...$$`，`math` のコードブロック，`\(...\)` を使える．プロジェクト内の画像は，Markdown のファイルからの相対パスで指定する．外部の画像は，その URL をブラウザで開くリンクとして表示する．

プレビュー内の相対リンクから別の文書を開ける．本文の段落や見出しをダブルクリックすると，エディタの対応する行へ移動する．Markdown の各文書でスクロール位置を記録する．PDF の表示へ戻ると，最後にコンパイルした PDF を表示する．

## PDF を読み，原稿と行き来する

PDF はページをまたいで連続してスクロールできる．表示中のページとその周辺を優先して描画し，長い原稿の全ページを一度に画像へ変換することを防ぐ．PDF の文字は選択してコピーでき，PDF 内のリンクから参照先にも移動できる．

| 操作 | 使い方 |
| --- | --- |
| 拡大・縮小する | `＋` / `−`，倍率の選択，または `Ctrl + ホイール` を使う．タッチパッドのピンチ操作にも対応する |
| 表示幅をそろえる | 倍率の選択から「幅に合わせる」または「ページに合わせる」を選ぶ |
| ページへ移動する | ページ番号を入力する，または左右の矢印を押す |
| PDF 内の文字を探す | 「PDF 内を検索」を押す．PDF にフォーカスした状態では `Ctrl + F` でも開く．`Enter` / `Shift + Enter` で次／前の結果へ移動する |
| PDF から原稿へ移動する | PDF の文章などをダブルクリックする．該当する `.tex` が開き，移動先の行が一時的に強調される |
| 原稿から PDF へ移動する | 原稿の行を `Ctrl + クリック` する，またはカーソルを置いて「PDF の位置へ」を押す．PDF の該当箇所が一時的に強調される |
| PDF を取り出す | 「PDF を保存」を押す |

原稿と PDF の相互移動には，TeX Live の `synctex` を使う．コンパイル時に SyncTeX のデータを生成し，その PDF と一緒に保存する．TeX のマクロや数式の組み方によっては，クリックした文字の近くの行へ移動する．PDF を作成した後に原稿を編集した場合は，画面に更新の案内が出る．

### SyncTeX を追加する

`synctex.exe` が見つからない場合は，TeX Live Manager で `synctex` と Windows 用の実行ファイルを追加する．TeX Live 2025 を `C:\texlive\2025` に入れている場合は，PowerShell で次を順に実行する．

```powershell
& 'C:\texlive\2025\bin\windows\tlmgr.bat' --repository 'https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2025/tlnet-final' update --self

& 'C:\texlive\2025\bin\windows\tlmgr.bat' --repository 'https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2025/tlnet-final' install --reinstall synctex synctex.windows

& 'C:\texlive\2025\bin\windows\synctex.exe' help
```

旧年度の TeX Live にパッケージを追加する際は，その年度の `tlnet-final` を使う．上記の `--repository` は，各コマンドの取得先を指定する．`--reinstall` は，パッケージが登録済みで実行ファイルだけが欠けている場合にもファイルを取り直す．詳細は [TUG の配布先の案内](https://www.tug.org/texlive/acquire.html) と [tlmgr のマニュアル](https://www.tug.org/texlive/doc/tlmgr.html) にある．

`synctex.exe help` で使い方が表示されたら，アプリで一度コンパイルしてから相互移動を使う．TeX Live の場所が異なる場合は，コマンドのパスとアプリの「TeX Live のフォルダー」を合わせる．

再コンパイル後も同じページ付近を表示する．コンパイルが失敗した場合や途中で停止した場合も，前回成功した PDF を参照しながら修正を続けられる．

ログは右上の「ログ」から必要なときに開ける．コンパイルが失敗した場合は自動で開き，エラーの内容を確認できる．

## コンパイルの設定

コンパイルする文書は，その時点でエディタに表示している `.tex` から選ぶ．`\documentclass` または `\begin{document}` があるファイルを開いて「コンパイル」を押すと，その文書の PDF を表示する．TeX のタブを切り替えただけでは，表示中の PDF は変わらない．画面上部に次のコンパイル対象，PDF の操作欄に表示中の文書名を示す．

`\input` で読む章や共通設定のファイルを編集している場合は，設定画面の「既定のメイン文書」をコンパイルする．文書ごとの親ファイルを指定するには，編集するファイルに `% !TeX root = ../main.tex` のようなコメントを書く．パスはそのファイルのフォルダーから指定する．

文書ごとに PDF のページ位置と倍率を記録する．別の文書のコンパイルに失敗した場合も，直前に成功した PDF と SyncTeX を使って作業を続けられる．

既存の `latexmkrc` がある原稿では，設定画面のコンパイラーを「latexmkrc の設定を使う」にする．`latexmkrc` / `.latexmkrc` に書かれた `uplatex`，`upbibtex`，`dvipdfmx` などの指定を使う．

`latexmkrc` を置かないプロジェクトでは，pdfLaTeX，upLaTeX，XeLaTeX，LuaLaTeX を選択できる．アプリは `latexmk` を実行し，参考文献や相互参照に必要な再実行も `latexmk` が担当する．

コンパイルの中間ファイルは，プロジェクト内の `.local-tex-editor/build` 以下に文書ごとに保存する．次回のコンパイルでは，同じ文書の中間ファイルを使う．プロジェクトを Git で管理する場合は，そのプロジェクトの `.gitignore` に次を追加できる．

```gitignore
.local-tex-editor/
```

コンパイル時間の上限はアプリ側で設けていない．実行中のコンパイルは，画面の停止ボタンから停止できる．

## アプリとデータの保存先

編集画面に必要な JavaScript，PDF.js の worker，フォントなどは実行ファイルに含む．起動のたびに CDN から取得する処理はない．

設定，草稿，前回の表示位置，表示用の PDF と SyncTeX のコピーは，Windows では `%APPDATA%\LocalTeXEditor`，Mac では `~/Library/Application Support/LocalTeXEditor` に保存する．原稿そのものは，選択したプロジェクトのフォルダーへ保存する．PDF のコピーを使うことで，TeX が書き込み中の PDF と表示中の PDF が競合する状況を防ぐ．

接続は `127.0.0.1` などの loopback のアドレスに限定する．起動ごとに生成する token を使い，ファイルの読み書きとコンパイルの API を呼び出す．

## 開発する

以下はアプリを開発する環境での手順である．配布済みの `.exe` / `.app` を使う PC では実行しない．

必要なものは Node.js 22.13 以降と Go 1.25 以降である．動作確認には TeX Live / TinyTeX と Chromium も使う．macOS の `.app` の作成には Xcode Command Line Tools も使う．

Windows でのビルド:

```sh
npm ci
npm run test:unit
npm run build
npm run build:windows-resources
go test ./...
go build -o bin/local-tex-editor.exe ./cmd/local-tex-editor
```

Windows 用の配布ファイルは次のコマンドで作成する．

```sh
go build -trimpath -ldflags="-s -w -H=windowsgui -X main.version=0.1.4" -o dist/local-tex-editor.exe ./cmd/local-tex-editor
```

`build:windows-resources` は同梱の ICO から Windows x64 用の resource を生成する．実行ファイルのビルド時に，16〜256 px の 9 サイズのアイコンが組み込まれる．

macOS でのビルド:

```sh
npm ci
npm run test:unit
npm run build
go test ./...
npx playwright install chromium
node scripts/build-macos.mjs
```

`dist/local-tex-editor-0.1.4-macos-universal.zip` に，Apple Silicon と Intel で動く `.app`，日英の README，ライセンスを収録する．

起動時のオプション:

```text
--project PATH       開くプロジェクトのフォルダー
--tex-bin PATH       TeX Live の実行ファイルのフォルダー
--no-browser         ブラウザを自動で開かない
--listen ADDRESS     loopback のアドレスとポート (既定: 127.0.0.1:0)
--config-dir PATH    設定とキャッシュの保存先
--ready-file PATH    起動したサーバーの URL と token を書くファイル
--version            アプリのバージョンを表示する
```

`--ready-file` は自動テストなどで使用する．このファイルには，アプリを操作するための token が含まれる．アプリを終了すると削除する．

GitHub Actions はアプリをビルドし，Windows と macOS の Apple Silicon / Intel で動作を確認する．Windows では，日本語と空白を含むフォルダーでの TeX の実行，参考文献，PDF のスクロール・拡大縮小・検索，SyncTeX の往復，自動保存，草稿の復元，エラー箇所への移動を確認する．macOS では，同じ配布 ZIP を両 CPU の環境で展開し，`.app` の起動，日本語の TeX，SyncTeX，文書の切り替え，Markdown，終了を確認する．日々の原稿のコンパイルは PC の TeX Live が担当する．

`main` の Windows と両 macOS のテストが成功し，`package.json` のバージョンに対応する Release がまだ存在しない場合は，その実行で確認したアプリを Releases に公開する．新しいバージョンを作る際は，`package.json` を更新し，`release-notes/v<バージョン>.md` を追加する．Actions の **Artifacts** にある `local-tex-editor-windows-x64` と `local-tex-editor-macos-universal` からも取得できる．Release の `SHA256SUMS.txt` に，両 ZIP の SHA-256 を記録する．

## 利用するライブラリ

- [CodeMirror](https://codemirror.net/): 編集画面 (MIT)
- [PDF.js](https://mozilla.github.io/pdf.js/): PDF の表示 (Apache-2.0)
- [markdown-it](https://github.com/markdown-it/markdown-it): Markdown の表示 (MIT)
- [KaTeX](https://katex.org/): Markdown 内の数式 (MIT)
- [DOMPurify](https://github.com/cure53/DOMPurify): プレビューの HTML の処理 (Apache-2.0 または MPL-2.0)
- [Go](https://go.dev/): HTTP サーバーと TeX の実行

依存する JavaScript のバージョンは `package-lock.json` に記録する．同梱するライブラリのライセンス本文は，アプリの `/THIRD_PARTY_LICENSES.txt` に含む．アプリ自体のライセンスは [MIT](LICENSE) である．
