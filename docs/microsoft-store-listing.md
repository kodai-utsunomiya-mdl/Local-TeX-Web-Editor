# Microsoft Store listing

Listing text and review instructions for the Windows x64 MSIX edition of Local TeX Web Editor. English is the first listing language; Japanese is the second.

## Submission details

| Field | Value |
| --- | --- |
| Product name | Local TeX Web Editor |
| Store ID | `9P6QF32N19HG` |
| Published Store page | https://apps.microsoft.com/detail/9P6QF32N19HG |
| Price | Free |
| Suggested category | Productivity |
| Device family | Windows desktop |
| Architecture | x64 |
| Minimum Windows version | Windows 10 version 2004 (build 19041), or Windows 11 |
| Listing languages | English (United States), Japanese |
| Website | https://kodai-utsunomiya-mdl.github.io/Local-TeX-Web-Editor/ |
| Japanese website | https://kodai-utsunomiya-mdl.github.io/Local-TeX-Web-Editor/ja/ |
| Support | https://github.com/kodai-utsunomiya-mdl/Local-TeX-Web-Editor/issues |
| Privacy policy | https://kodai-utsunomiya-mdl.github.io/Local-TeX-Web-Editor/privacy/ |
| Japanese privacy policy | https://kodai-utsunomiya-mdl.github.io/Local-TeX-Web-Editor/ja/privacy/ |
| Source code | https://github.com/kodai-utsunomiya-mdl/Local-TeX-Web-Editor |
| License | MIT |
| Copyright | Copyright (c) 2026 Local TeX Web Editor contributors |

The published product uses the publisher name and package identity configured in `packaging/windows/store-identity.json`. The manifest's identity and publisher values must match the product's identity page in Partner Center. [Microsoft's preparation guide](https://learn.microsoft.com/en-us/windows/apps/publish/store-readiness-checklist)

The three public identity fields in `packaging/windows/store-identity.json` are `identityName`, `publisher` and `publisherDisplayName`. The build also accepts `MSIX_IDENTITY_NAME`, `MSIX_PUBLISHER` and `MSIX_PUBLISHER_DISPLAY_NAME` as overrides. These are product identity fields; account passwords and identity-verification documents are not part of this file.

### Initial registration and submission

1. Start at [storedeveloper.microsoft.com](https://storedeveloper.microsoft.com/), choose **Get started for free**, then **Individual developer** for the personal project account.
2. The account owner signs in with a Microsoft account and completes the requested identity verification using a government-issued ID and a selfie.
3. In Partner Center, reserve the product name and create an MSIX submission. Select Free pricing, the intended markets, and the Windows desktop device family.
4. Upload the MSIX package, complete the age-rating questionnaire, and add the English and Japanese listings below. Enter the public privacy-policy URL and support URL.
5. Add the reviewer notes and the explanation for the restricted capability used by the package, then submit the completed entry for review.

Microsoft documents the free registration flow at [Free developer registration for individual developers](https://learn.microsoft.com/en-us/windows/apps/publish/whats-new-individual-developer). Begin at the Store developer website; the article notes that other registration entry points can show the older flow. If a payment screen appears, return to that free entry point.

For MSIX submissions, Microsoft provides Store signing after review. This route does not require purchasing signing services. See [App package requirements](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/package-version-numbering) and [MSIX submission steps](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/create-app-submission).

## English listing

### Short description

```text
Edit TeX and Markdown in your browser, compile with TeX Live on your PC, and use SyncTeX to move between source and PDF. Includes continuous PDF viewing and live Markdown preview.
```

### Description

```text
Local TeX Web Editor opens an editor in your browser for projects stored on your Windows PC. TeX compilation uses TeX Live, which you install separately. The resulting PDF appears beside the source.

Read PDFs with continuous scrolling, text selection, search and zoom. Double-click text in the PDF to open the corresponding source line, or Ctrl-click a source line to move to its position in the PDF. These navigation features use SyncTeX.

Open several documents in tabs, arrange their order, or use two source editors. The next session restores your tabs and layout. Compiling an independent TeX document produces that document's PDF. Chapter files can use a configured main document or a TeX root comment.

Search text across the project, including unsaved edits, and choose which occurrences to replace after reviewing the changes. Inspect the definitions and uses of citation keys and labels, and preview a key rename before applying it. Back and Forward return to earlier source and preview positions, including the position before following an internal PDF link. Compilation errors and warnings can be filtered by category.

Local edit history lets you compare earlier versions and restore selected changes. Open Editing tools > Document history > History settings to adjust its defaults of 30 days and 50 MiB or stop recording. History supports 50 versions per file, 2000 versions overall, and documents up to 2 MiB. Autosave and local drafts also help you resume your work.

Paste or drop PNG, JPEG or PDF files up to 8 MiB, then review the figure source to insert. Paste a table from a spreadsheet or create one by choosing its rows and columns. Start projects from built-in templates or add your own templates from selected project files.

Markdown files have a live preview with tables, code blocks, images and mathematics. A toolbar adds headings, text formatting, lists, links and code blocks to the source. Sync scrolling works in both directions and can be turned off. Choose PDF, Markdown or Auto in the preview toolbar to read a PDF while editing notes or keep Markdown visible while working on TeX.

The interface is available in English and Japanese, with system, light and dark modes. The initial appearance uses the Gray color scheme and Consolas; an available monospace font is used when Consolas is absent. You can change the colors and editor font in Settings > Appearance. Launching the app opens a localhost page in your browser. Documents, settings, drafts, history and custom templates are stored on your computer.

Requirements:
• Windows 10 version 2004 (build 19041) or later, or Windows 11, on an x64 PC.
• A current version of Microsoft Edge or Google Chrome.
• TeX Live with latexmk and the engines, packages and fonts your documents use. SyncTeX is needed for navigation between source and PDF.

TeX Live is installed separately. You can use an existing installation or start with a smaller one and add packages as needed. The app's Settings includes guidance for preparing package-install commands. Markdown editing and preview work without TeX Live.

The app is free and open source under the MIT license. No app account or subscription is needed.
```

### Product features

Enter each line as one feature, without adding a bullet character to the Store field.

```text
Compile local TeX projects with your installed TeX Live and latexmk
Read PDFs with continuous scrolling, search, selection and zoom
Move between corresponding source and PDF positions with SyncTeX
Edit Markdown with live previews of mathematics, tables and images
Choose a PDF or Markdown preview while working in another document
Search project text, review replacements, and include unsaved edits
Return to earlier source and PDF positions with Back and Forward
Compare local edit history and restore selected changes
Find citation and reference definitions and uses, and preview key renames
Use two source editors and restore open tabs and their order
Filter compilation errors and warnings by category
Import images, paste tables, or create and edit a new table
Create projects from built-in templates or add your own
Format Markdown and synchronize source and preview scrolling in both directions
Use autosave and local drafts while editing files in project folders
Choose an English or Japanese interface, colors, and editor font
```

### Search terms

```text
LaTeX
TeX editor
Markdown editor
SyncTeX
PDF preview
scientific writing
local editor
```

### Additional requirements

```text
Current Microsoft Edge or Google Chrome
TeX Live with latexmk for TeX compilation
SyncTeX for source and PDF navigation
Document-specific TeX packages, fonts and bibliography tools
```

### What's new

```text
Version 0.1.7

- Search and replace across project text, including unsaved edits. Review and select the occurrences to change.
- Use Back and Forward after following source or PDF links.
- Compare local edit history and restore selected changes. Defaults: 30 days and 50 MiB; limits: 50 versions per file, 2000 overall, and 2 MiB per document. Adjust or disable it in Editing tools > Document history > History settings.
- Inspect citation and reference definitions and uses; preview key renames.
- Open two source editors. Restore all open tabs, their order, and the layout.
- Filter compilation errors and warnings by category.
- Paste or drop PNG, JPEG and PDF files up to 8 MiB. Paste a table or create one and edit its cells before insertion.
- Create projects from built-in templates or add your own.
- Use the Markdown toolbar for headings, bold, italic, strikethrough, lists, quotes, inline code, links, code blocks and tables.
- Synchronize Markdown scrolling in both directions, or turn it off.
- New appearance defaults: Gray and Consolas. Existing choices remain; computers without Consolas use the usual fallback fonts.
- Outline and PDF jumps show the source line with space above it.
```

## 日本語の掲載内容

### 短い説明

```text
ブラウザで TeX と Markdown を編集し，PC の TeX Live でコンパイルできます．PDF の連続スクロール，SyncTeX による原稿との相互移動，Markdown のプレビューに対応します．
```

### 説明

```text
Local TeX Web Editor は，Windows PC にあるプロジェクトをブラウザで編集するアプリです．TeX のコンパイルには別途導入した TeX Live を使い，原稿と PDF を並べて表示します．

PDF はページをまたいで連続してスクロールでき，文字の選択・検索，拡大・縮小にも対応します．PDF の文章をダブルクリックすると原稿の対応する行へ移動し，原稿の行を Ctrl + クリックすると PDF の対応する位置へ移動します．この相互移動には SyncTeX を使います．

複数の文書をタブで開き，順番を変えたり，二つのエディタへ並べたりできます．次回の起動ではタブと配置を読み戻します．独立した TeX 文書を編集中にコンパイルすると，その文書の PDF を作成します．章のファイルでは，既定のメイン文書や TeX root の指定を使えます．

プロジェクト全体の本文を，未保存の編集も含めて検索し，変更内容を確認して選んだ箇所を置換できます．引用のキーやラベルの定義・使用箇所を確認し，名前の変更も事前に確認して進められます．「戻る」「進む」では原稿やプレビューの以前の位置へ移動でき，PDF 内の参照リンクを開く前の位置にも戻れます．コンパイルのエラーと警告は種類で絞り込めます．

PC に記録した編集履歴から，以前の版と見比べて選んだ箇所を戻せます．「編集の操作 → 編集履歴を開く → 履歴の設定」で，初期値の 30 日・合計 50 MiB を変更したり，記録を停止したりできます．上限は 1 ファイル 50 版，全体 2000 版，原稿 1 版につき 2 MiB です．自動保存と草稿も利用できます．

PNG・JPEG・PDF を 8 MiB まで貼り付けやドラッグで取り込み，挿入する原稿を確認できます．表計算ソフトからコピーした表の挿入や，行数と列数を指定した表の作成にも対応します．標準のテンプレートからプロジェクトを作成でき，自分の原稿や画像を選んでテンプレートへ追加することもできます．

Markdown では，入力に合わせて表，コード，画像，数式をプレビューします．ツールバーから見出し，文字の装飾，リスト，リンク，コードブロックを挿入できます．スクロールは両方向に同期でき，オフにもできます．表示欄で「PDF・Markdown・自動」を選び，PDF を読みながらメモを編集したり，TeX の編集中も Markdown を表示したりできます．

表示言語は英語と日本語，モードはシステム・ライト・ダークを選べます．初期状態では配色にグレー，フォントに Consolas を使い，Consolas がない PC では利用できる等幅フォントを使います．「設定 → 外観」で配色やフォントを変更できます．起動するとブラウザに localhost のページが開き，原稿，設定，草稿，編集履歴，自分のテンプレートは PC に保存します．

必要な環境:
・Windows 10 version 2004 (build 19041) 以降，または Windows 11 の x64 PC．
・現在の Microsoft Edge または Google Chrome．
・latexmk と，原稿で使うエンジン・パッケージ・フォントを含む TeX Live．原稿と PDF の相互移動には SyncTeX を使います．

TeX Live は別途導入します．すでにある環境を使うことも，小さめの構成から始めて必要なパッケージを追加することもできます．アプリの設定には，追加コマンドを用意する案内があります．Markdown の編集とプレビューは TeX Live がなくても使えます．

MIT ライセンスで公開されている無料のアプリです．アプリ用のアカウント登録やサブスクリプションは不要です．
```

### 製品の機能

各行を 1 件の機能として入力する．Store の入力欄には箇条書きの記号を付けない．

```text
導入済みの TeX Live と latexmk で PC の原稿をコンパイル
PDF の連続スクロール，文字の検索・選択，拡大・縮小
SyncTeX による原稿と PDF の対応位置への相互移動
数式，表，画像に対応した Markdown のプレビュー
別の文書を編集しながら PDF や Markdown を表示
未保存の内容も含めてプロジェクト全体を検索し，選んだ箇所を置換
原稿や PDF の移動前の位置へ「戻る」「進む」で移動
以前の編集履歴と比較し，選んだ箇所を原稿へ戻す
引用と相互参照の定義・使用箇所を確認し，名前の変更を事前に確認
原稿を二つ並べ，開いていたタブと並び順を復元
コンパイルのエラーと警告を種類で絞り込み
画像の取り込み，コピーした表の挿入，新しい表の作成と編集
標準のテンプレートから作成し，自分のテンプレートも追加
Markdown の装飾と，原稿・プレビューの両方向のスクロール同期
プロジェクト内のファイルを編集し，自動保存と草稿を利用
日本語・英語の UI，配色，原稿のフォントを選択
```

### 検索語

```text
LaTeX
TeX エディタ
Markdown
SyncTeX
PDF プレビュー
論文執筆
ローカル編集
```

### 追加の動作条件

```text
現在の Microsoft Edge または Google Chrome
TeX のコンパイルには latexmk を含む TeX Live
原稿と PDF の相互移動には SyncTeX
原稿で使う TeX パッケージ，フォント，文献処理のプログラム
```

### このバージョンの最新情報

```text
バージョン 0.1.7

・未保存の内容も含めてプロジェクト全体の本文を検索し，変更を確認して選んだ箇所を置換できるようにした．
・原稿や PDF の参照先から「戻る」「進む」で元の位置へ移動できるようにした．
・編集履歴と現在の原稿を見比べ，選んだ箇所を戻せるようにした．初期値は 30 日・合計 50 MiB，上限は 1 ファイル 50 版，全体 2000 版，原稿 1 版につき 2 MiB．「編集の操作 → 編集履歴を開く → 履歴の設定」で変更や無効化ができる．
・引用と相互参照の定義・使用箇所を確認し，名前の変更を事前に確認できるようにした．
・原稿を二つ並べて編集し，全てのタブと並び順，配置を読み戻せるようにした．
・コンパイルのエラーと警告を種類で絞り込めるようにした．
・PNG・JPEG・PDF を 8 MiB まで貼り付けやドラッグで取り込めるようにした．コピーした表の挿入と，新しい表の作成・セルの編集にも対応した．
・標準のテンプレートからプロジェクトを作成でき，自分のテンプレートも追加できるようにした．
・Markdown のツールバーから，見出し，太字，斜体，取消線，リスト，引用，行内コード，リンク，コードブロック，表を挿入できるようにした．
・Markdown のスクロール同期を両方向にし，オフにもできるようにした．
・外観の初期値をグレーと Consolas にした．保存済みの選択は引き続き使い，Consolas がない場合は従来の標準の順序でフォントを選ぶ．
・アウトラインや PDF から移動した原稿の行を，上側に余白を設けて表示するようにした．
```

## Images and captions

Use the **1600 × 1000** PNG screenshots captured from the installed MSIX by `scripts/test-msix.mjs`. They are written to `test-results/msix/` and copied into the `microsoft-store-listing` artifact after both package-build paths. Check that `screenshot-source.json` says `installed-msix` and that the installed-package tests succeeded. If a run failed before capturing both images, its listing artifact contains the repository screenshots instead. This size meets the desktop minimum of 1366 × 768. Upload the same images separately for each listing language, with the corresponding captions below.

| Image | English caption | 日本語の説明 |
| --- | --- | --- |
| `editor-tex-dark.png` | Edit TeX source and read the compiled PDF side by side in dark mode. | ダークモードで TeX の原稿とコンパイルした PDF を並べて表示． |
| `editor-markdown-light.png` | Preview Markdown mathematics, a task list and a table while editing in light mode. | ライトモードで Markdown を編集し，数式，チェック項目，表をプレビュー． |

For the Store app icon, export a **300 × 300 PNG** from [the existing app icon](../internal/branding/app-icon.svg). The package's manifest icons are also required by the package format and are prepared with the MSIX. A separate Store icon gives the listing a consistent image.

Desktop listings accept up to 10 screenshots, each as PNG up to 50 MB. At least one screenshot is required. Captions can contain up to 200 characters. Use images of the submitted app's interface. [Microsoft's image specifications](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/screenshots-and-images)

Trailers, promotional artwork and extra screenshots can be added later. These two screenshots show the TeX/PDF and Markdown workflows.

## Reviewer notes

In Partner Center, open **Supplemental info > Additional Testing Information** (補足情報 > 追加のテスト情報), paste the notes into **Description**, and choose **Save description**. The app uses no account credentials, so the credentials table can stay empty.

Use these notes with the Store package after checking its launch, save and compile behavior on Windows. The build puts `main.tex` and `notes.md` from [the sample folder](../packaging/windows/review-sample/) at the root of `dist/store-listing/store-review-sample.zip`. The sample URL below already provides that project. Check the download before submitting the app, and update the published ZIP if the sample files have changed.

### English

```text
Local TeX Web Editor is a Windows desktop application with a browser interface. Launching it from the Start menu starts a server on the local loopback address and opens the editor in the default browser. The page is served by the installed app on this computer. No app login or subscription is required.

For review, use a current Microsoft Edge or Google Chrome. Download the sample ZIP below and extract it to a writable project folder. It contains main.tex and notes.md.

Sample project: https://kodai-utsunomiya-mdl.github.io/Local-TeX-Web-Editor/downloads/store-review-sample.zip

1. Launch Local TeX Web Editor and use Open to select that folder.
2. Open notes.md. With the preview set to Auto, edit a sentence and confirm that the Markdown preview updates. Save with Ctrl+S.
3. Open Settings, switch Language between English and Japanese, and change the theme. These changes do not alter document contents.
4. To test TeX compilation, install TeX Live separately with latexmk, pdflatex and synctex. A smaller TeX Live installation is sufficient for the sample. The installation guide is linked below.
5. If the programs are not found automatically, set the TeX program folder in Settings, for example C:\texlive\2026\bin\windows. Choose pdfLaTeX as the compilation mode for the sample.
6. Open main.tex, set the preview to Auto, and click Compile. A PDF appears on the right.
7. Double-click a sentence in the PDF to open its source line. Ctrl-click that source line to navigate back to the PDF.
8. Open notes.md and choose PDF in the preview toolbar. Editing and saving the Markdown keeps the PDF visible. Select Auto to return to the Markdown preview.
9. Save the files and close the last browser tab showing this app. The local app stops after about five seconds. Reopen it to continue with the previous project.

For version 0.1.7, also try Search project with an unsaved edit and review a selected replacement; use Back after following a source or PDF link; and open the second source editor. In Editing tools, try Document history, References and citations, Insert an image, Insert a table, and Manage templates. History settings explains the storage limits and allows recording to be disabled. The Markdown toolbar in notes.md adds formatting, links, code blocks and tables; Sync scrolling links source and preview in both directions. Reopen the app to review the saved tabs and layout. F1 opens Help, and Settings > Appearance provides the color scheme and editor font.

TeX Live is an external prerequisite for TeX compilation. Markdown editing and preview work without it. The app prepares package-install commands for the user to run; it does not install TeX or packages automatically.

The Store edition uses Windows to manage installation and app updates. Source files remain in the selected project folder. Settings, drafts, edit history, custom templates and PDF preview copies are stored in the app's local user data.

TeX setup and usage: https://github.com/kodai-utsunomiya-mdl/Local-TeX-Web-Editor/blob/main/README.md#requirements
Privacy: https://kodai-utsunomiya-mdl.github.io/Local-TeX-Web-Editor/privacy/
```

### 日本語

```text
Local TeX Web Editor は，ブラウザを画面として使う Windows のデスクトップアプリです．スタートメニューから起動すると，PC の loopback アドレスでサーバーを起動し，既定のブラウザに編集画面を開きます．このページは，同じ PC にインストールされたアプリから読み込みます．アプリのログインやサブスクリプションは不要です．

確認には現在の Microsoft Edge または Google Chrome を使います．下記のサンプル ZIP をダウンロードし，書き込み可能なプロジェクトフォルダーへ展開します．main.tex と notes.md が入っています．

サンプルのプロジェクト: https://kodai-utsunomiya-mdl.github.io/Local-TeX-Web-Editor/downloads/store-review-sample.zip

1. アプリを起動し，Open からそのフォルダーを選びます．
2. notes.md を開きます．プレビューを Auto にして文章を編集し，表示が更新されることを確認します．Ctrl + S で保存できます．
3. Settings の Language で英語と日本語を切り替え，テーマも変更します．原稿の内容は変わりません．
4. TeX のコンパイルを確認するため，latexmk，pdflatex，synctex を含む TeX Live を別途導入します．このサンプルには小さめの TeX の構成を使えます．導入手順は末尾の README にあります．
5. 自動で見つからない場合は，Settings で C:\texlive\2026\bin\windows などの TeX のプログラムの場所を指定します．このサンプルのコンパイル方法には pdfLaTeX を選びます．
6. main.tex を開き，プレビューを Auto にして Compile を押します．右側に PDF が表示されます．
7. PDF の文章をダブルクリックして原稿の行へ移動し，その行を Ctrl + クリックして PDF へ移動します．
8. notes.md を開いてプレビューを PDF にすると，Markdown の編集・保存中も PDF を表示します．Auto に戻すと Markdown を表示します．
9. 原稿を保存し，このアプリを開いている最後のブラウザタブを閉じると，約 5 秒後にアプリが終了します．起動し直すと前回のプロジェクトを開きます．

v0.1.7 では，未保存の編集を含む Search project と選んだ箇所の置換，原稿や PDF のリンクから Back で戻る操作，二つ目のエディタを開く操作も確認できます．Editing tools には Document history，References and citations，Insert an image，Insert a table，Manage templates があります．History settings で上限を確認し，記録を停止できます．notes.md の Markdown ツールバーから装飾・リンク・コードブロック・表を挿入でき，Sync scrolling では原稿とプレビューが両方向に動きます．アプリを開き直すと，タブと配置を読み戻します．F1 ではヘルプ，Settings → Appearance では配色と原稿のフォントを確認できます．

TeX Live はコンパイルに使う外部のソフトウェアです．Markdown の編集とプレビューは TeX Live がなくても使えます．アプリはパッケージ追加用のコマンドを用意し，ユーザーが必要に応じて実行します．TeX やパッケージの自動導入は行いません．

Store 版のインストールとアプリの更新は Windows が管理します．原稿は選んだプロジェクトフォルダーに保存し，設定・草稿・編集履歴・自分のテンプレート・PDF の表示用コピーはアプリのローカルデータへ保存します．

TeX の導入と使い方: https://github.com/kodai-utsunomiya-mdl/Local-TeX-Web-Editor/blob/main/README.ja.md
プライバシー: https://kodai-utsunomiya-mdl.github.io/Local-TeX-Web-Editor/ja/privacy/
```

### Explanation for `runFullTrust`

Enter this explanation in **Submission options > Restricted capabilities**. The text fits the form's 500-character limit.

```text
Local TeX Web Editor is a packaged Win32 desktop app. It requires runFullTrust to read and write files in project folders selected by the user, run the user's installed latexmk, TeX and SyncTeX programs for compilation and navigation between source files and PDFs, and open the default browser to its local loopback interface. The app runs in the user's session with the user's permissions. TeX package installation commands are displayed for the user to run separately.
```

If the submitted manifest declares additional restricted capabilities, document the concrete feature that uses each one. Microsoft's [submission-options guide](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/manage-submission-options) explains the information reviewers need.

### Sample `main.tex`

```tex
\documentclass{article}
\title{Local TeX Web Editor sample}
\author{}
\date{}
\begin{document}
\maketitle
\section{A local document}
This document is compiled with TeX Live on this computer.
Double-click this sentence in the PDF to open its source line.
\[
  E = mc^2
\]
\end{document}
```

### Sample `notes.md`

````markdown
# Reading notes

Edit this sentence to update the preview.

- [x] Open the project
- [ ] Compile the TeX document

$$
E = mc^2
$$

| File | Purpose |
| --- | --- |
| main.tex | TeX document |
| notes.md | Notes |
````

## Field limits and remaining submission information

The description supports 10,000 characters. The short description supports 1,000, with fewer than 270 recommended for the views that shorten it. Up to 20 product features can be entered, each at most 200 characters. The first submission leaves What's new empty; later entries support 1,500 characters. See [Store listing fields](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/add-and-edit-store-listing-info).

The proposed search terms use seven entries in each language. [Store policies](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies) limit search terms to seven relevant terms or phrases. The same policies require a privacy policy for Win32 and Desktop Bridge apps.

Before submitting, the account owner completes the publisher profile, product-name reservation, age-rating questionnaire and market selection. The package's actual minimum Windows version, identity, supported languages and capabilities should match the submission. The website and both privacy URLs should be reachable, and the submitted MSIX should have been tested with the sample above. These steps use the free Store registration and MSIX distribution route.
