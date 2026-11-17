# Microsoft Store listing

Listing text and review instructions for the Windows x64 MSIX edition of Local TeX Web Editor. English is the first listing language; Japanese is the second.

## Submission details

| Field | Value |
| --- | --- |
| Product name | Local TeX Web Editor |
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

Use the publisher name and package identity assigned to this product in Partner Center. Reserve **Local TeX Web Editor** there before producing the final Store package. The manifest's identity and publisher values must match the product's identity page. [Microsoft's preparation guide](https://learn.microsoft.com/en-us/windows/apps/publish/store-readiness-checklist)

Copy the three public identity values from that page into `packaging/windows/store-identity.json`: `identityName`, `publisher` and `publisherDisplayName`. The build also accepts `MSIX_IDENTITY_NAME`, `MSIX_PUBLISHER` and `MSIX_PUBLISHER_DISPLAY_NAME` as overrides. These are product identity fields; account passwords and identity-verification documents are not part of this file.

### Free registration and submission

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

Open several documents in tabs. Compiling an independent TeX document produces that document's PDF. Chapter files can use a configured main document or a TeX root comment. Multiline search and replacement, citation and reference completion, autosave and local drafts support editing longer projects.

Markdown files have a live preview with tables, code blocks, images and mathematics. Choose PDF, Markdown or Auto in the preview toolbar. You can read a compiled PDF while editing Markdown notes, or keep a Markdown preview visible while working on TeX.

The interface is available in English and Japanese, with light and dark themes. Launching the app opens a localhost page in your browser. Documents, settings and drafts are stored on your computer.

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
Search and replace pasted text across multiple lines
Use autosave and local drafts while editing files in project folders
Choose an English or Japanese interface and a light or dark theme
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

Leave this field empty for the first Store submission. Later submissions should describe changes since the previous Store version.

## 日本語の掲載内容

### 短い説明

```text
ブラウザで TeX と Markdown を編集し，PC の TeX Live でコンパイルできます．PDF の連続スクロール，SyncTeX による原稿との相互移動，Markdown のプレビューに対応します．
```

### 説明

```text
Local TeX Web Editor は，Windows PC にあるプロジェクトをブラウザで編集するアプリです．TeX のコンパイルには別途導入した TeX Live を使い，原稿と PDF を並べて表示します．

PDF はページをまたいで連続してスクロールでき，文字の選択・検索，拡大・縮小にも対応します．PDF の文章をダブルクリックすると原稿の対応する行へ移動し，原稿の行を Ctrl + クリックすると PDF の対応する位置へ移動します．この相互移動には SyncTeX を使います．

複数の文書をタブで開けます．独立した TeX 文書を編集中にコンパイルすると，その文書の PDF を作成します．章のファイルでは，既定のメイン文書や TeX root の指定を使えます．複数行の検索・置換，引用と相互参照の補完，自動保存，PC に記録する草稿も利用できます．

Markdown では，入力に合わせて表，コード，画像，数式をプレビューします．表示欄で「PDF・Markdown・自動」を選べるので，コンパイルした PDF を読みながら Markdown のメモを編集したり，メモの表示を続けながら TeX を編集したりできます．

表示言語は英語と日本語，テーマはライトとダークを選べます．起動するとブラウザに localhost のページが開き，原稿，設定，草稿は PC に保存します．

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
複数行をそのまま貼り付けて検索・置換
プロジェクト内のファイルを編集し，自動保存と草稿を利用
日本語・英語の UI と，ライト・ダークのテーマを選択
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

### このバージョンの新機能

Store への初回提出では空欄にする．以降は，前回の Store 版から変更した内容を書く．

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

TeX Live is an external prerequisite for TeX compilation. Markdown editing and preview work without it. The app prepares package-install commands for the user to run; it does not install TeX or packages automatically.

The Store edition uses Windows to manage installation and app updates. Source files remain in the selected project folder. Settings, drafts and PDF preview copies are stored in the app's local user data.

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

TeX Live はコンパイルに使う外部のソフトウェアです．Markdown の編集とプレビューは TeX Live がなくても使えます．アプリはパッケージ追加用のコマンドを用意し，ユーザーが必要に応じて実行します．TeX やパッケージの自動導入は行いません．

Store 版のインストールとアプリの更新は Windows が管理します．原稿は選んだプロジェクトフォルダーに保存し，設定・草稿・PDF の表示用コピーはアプリのローカルデータへ保存します．

TeX の導入と使い方: https://github.com/kodai-utsunomiya-mdl/Local-TeX-Web-Editor/blob/main/README.ja.md
プライバシー: https://kodai-utsunomiya-mdl.github.io/Local-TeX-Web-Editor/ja/privacy/
```

### Explanation for `runFullTrust`

```text
Local TeX Web Editor is an existing Win32 desktop app. It reads and writes files in project folders selected by the user, launches the user's installed latexmk, TeX and SyncTeX executables for document compilation and source/PDF navigation, and opens the default browser to its local loopback interface. These desktop operations require runFullTrust. The app runs in the user's session and does not request administrator elevation. Package-management help displays commands for the user to run separately.
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
