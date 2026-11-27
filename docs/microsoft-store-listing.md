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
Completely free TeX, Markdown and text editor. Set up TeX from the app, compile locally without an app time limit, and preview PDFs in your browser.
```

### Description

```text
Local TeX Web Editor is a completely free editor for TeX, Markdown and plain text on your Windows PC. All features are included, with no in-app purchases, paid upgrades, subscriptions or trial expiry. No account is required.

A small Go executable works with a tab in your existing browser. The download includes no separate browser engine, and TeX completion, compilation and PDF preview work without installing editor extensions. You can use it for Markdown notes, documentation and text files before installing TeX.

Compile with the TeX on your PC, with no compilation time limit set by the app. Choose Set up TeX… to install TinyTeX from the app, or select an existing TeX Live. When setup finishes, the app automatically selects the new environment so you can create a sample and compile it.

Review the download source, packages and destination, then choose Download and install. Setup provides pdfLaTeX, upLaTeX, XeLaTeX, LuaLaTeX, latexmk, SyncTeX, Japanese fonts, bibliography tools and common mathematics and drawing packages. It runs in your user folder and selects TeX after setup succeeds. Setup and package downloads require internet access; allow about 250 MB of downloads and 2 GB of free space during initial setup.

Manage TeX lists packages in the selected installation, including existing TeX Live and TinyTeX. Search the list, add packages after review, and check the proposed changes and dependencies before removing packages. Starting an entire environment's removal inside the app has a separate confirmation with its actual folder, contents and exact name. An installation shared with other applications can also affect their compilation. The Store edition opens the official TeX management tool or Windows app settings when administrator permission is required. Project documents stay in their project folders.

Complete TeX commands, environments, citations and labels. Tab moves between inserted fields; Ctrl + Space opens suggestions. Fold source sections and environments, and expand or collapse the outline.

PDF tools include continuous scrolling, search, zoom and SyncTeX navigation. Back and Forward return to earlier positions, including after PDF links. Dark PDF view changes screen colors; saved PDFs keep their original colors. Zoom buttons and Download stay visible in narrow previews; PDF actions includes Save as… and the remaining controls.

Search and replace across the project, compare local edit history, inspect citation and reference uses, and edit two source documents. Select multiple changes from a recorded version and restore them together, or select unneeded versions and confirm their deletion. Tabs and their order reopen with your project. Filter compilation errors and warnings.

Paste images, create or paste tables, and start from built-in or custom templates. Markdown opens in visual editing for headings, text, tables, tasks, and equations. Use pinch or Ctrl + wheel to change its text size; visual and source editing share the chosen size and remember it next time. Switch to source notation, show or hide the preview, and synchronize source and preview scrolling. Create linked Markdown pages, save Markdown as PDF using browser printing, or extract PDF text to TXT.

Manage project files from the context menu and copy multiple files from your computer. Download a file using the browser's settings, or choose Save as… to select its destination and name in the Windows save dialog. Files being edited use the current text, including unsaved changes. Create copies of files or folders from their saved contents while continuing to edit the originals. Sort by name or date, drag entries into a manual order, or drop onto a folder to move them. New files can start empty or use one previewed text file from a built-in or custom template. Each TeX document's latest successful PDF appears in the file list with its output name and TeX path; open it, download it, save it to a chosen folder, or copy it into the project. Delete a compiled result after reviewing its document and file count. This clears that document's cached previews and compilation files; source documents and PDFs saved or copied as ordinary files stay in place. Compile again to recreate the result.

Import a project ZIP from Home, choose its destination and name, and open it as a new project. In the editor or beside a recent project on Home, open ZIP and choose Download project as ZIP, or Save project ZIP as… to select the destination. Exporting the current project saves its edited documents first. Other recent projects use the files saved in their folders, and you can continue editing the current project after export. Source, bibliography, images, fonts and relative folders can travel together to Overleaf; app caches and compilation intermediates are omitted.

Edit Python, JavaScript and other program files. Home checks current and recent folders and explains missing locations; remove an entry while leaving its files and drafts in place. Open documents without unsaved edits load external changes. Documents being edited offer a comparison; a deleted file's text and draft stay available for review. The TeX logo opens Home with current and recent projects. Review a project's contents and enter its name before deleting it. Close all tabs together. The local app keeps running while the browser tab sleeps; use Quit to stop it. Start at login is enabled by default, so restored browser tabs can reconnect after a PC restart. Turn it on or off in Settings > Start at login.

Start in Dark mode from the first launch, or select Light or System in Appearance settings. Preview English or Japanese immediately in Settings, adjust panes and appearance, and use autosave and local drafts. Documents, history and templates stay on your PC.

Requires an x64 PC with Windows 10 build 19041 or later, or Windows 11, and current Edge or Chrome. Use in-app TeX setup or select TeX Live with the packages your documents need. Open source under the MIT license.
```

### Product features

Enter each line as one feature, without adding a bullet character to the Store field.

```text
All features are free, with no in-app purchases, paid upgrades, subscriptions or trial expiry
A small Go app works with your existing browser, with no separate browser engine to install
Set up and automatically select TinyTeX, or use existing TeX Live, and compile locally with no app time limit
Read PDFs with continuous scrolling, search, zoom and Back/Forward; open or delete each TeX document's saved previews
Move between corresponding source and PDF positions with SyncTeX
Edit rendered Markdown, resize its text with pinch or Ctrl + wheel, and switch to source with synchronized preview scrolling
Search project text, review replacements, and include unsaved edits
Select several history changes to restore, or review and delete unneeded versions
Find citation and reference definitions and uses, and preview key renames
Use two source editors and restore open tabs and their order
Filter compilation errors and warnings by category
Import images, paste tables, or create and edit a new table
Import or download project ZIPs for Overleaf, or create projects and files from templates
Create a Markdown page and insert a relative link to it
Print Markdown to PDF and extract PDF text to a TXT file
Edit plain text, Python and other code; copy files and folders, sort by name or date, and drag to arrange or move
Use autosave and local drafts, and resume after the browser tab sleeps
Preview English or Japanese, and choose colors and the editor font
Complete TeX commands and environments, fold source, and browse the outline
Manage packages in app-installed or existing TeX, review removal, and open official tools for shared installations
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
TeX installed through the app, or an existing TeX Live with latexmk and SyncTeX
Internet access for TeX setup and additional package downloads
About 2 GB free for initial TeX setup; extra packages may need more space
```

### What's new

```text
Version 0.1.20

- Download a ZIP or choose Save project ZIP as… from each recent project on Home.
- Save edited documents when exporting the current project, or export another project's saved files.
- Start at login is enabled by default and can be turned on or off in Settings.
- Automatic app updates remain enabled by default and use updates available from Microsoft Store.
```

## 日本語の掲載内容

### 短い説明

```text
TeX，Markdown，テキストを編集できる完全無料のアプリです．TeX もアプリから導入でき，コンパイル時間の制限を気にせず PC で原稿を組版し，ブラウザで PDF を確認できます．
```

### 説明

```text
Local TeX Web Editor は，Windows PC にある TeX，Markdown，テキストの原稿を編集する完全無料のアプリです．アプリ内購入，有料アップグレード，サブスクリプション，試用期限はなく，すべての機能を使えます．アカウント登録も不要です．

Go の小さな実行ファイルと普段のブラウザのタブで動作します．配布ファイルに専用のブラウザエンジンを含めず，TeX の補完，コンパイル，PDF の表示も追加の拡張機能を入れずに使える軽量な構成です．TeX を導入する前から，Markdown のメモや説明文，テキストファイルの編集にも使えます．

コンパイルには PC の TeX を使い，アプリによるコンパイル時間の上限はありません．「TeX をセットアップ…」から TinyTeX を導入するか，既存の TeX Live を選んで使えます．導入が完了すると環境が自動で選ばれ，サンプルの作成とコンパイルへ進めます．

取得元，パッケージ，導入先を確認し，「ダウンロードしてインストール」を選ぶと，pdfLaTeX，upLaTeX，XeLaTeX，LuaLaTeX，latexmk，SyncTeX，日本語フォント，文献処理と数式・図の基本的なパッケージを導入します．自分のユーザーフォルダーへ導入し，成功後は新しい TeX を選択します．導入や追加パッケージの取得にはインターネット接続を使います．初期構成のダウンロードは約 250 MB，作業中の空き容量は約 2 GB が目安です．

「TeX を管理」では，既存の TeX Live と TinyTeX を含め，選択中の環境のパッケージを一覧で確認できます．一覧の検索，内容を確認した上での追加，削除予定と依存関係を確認した上での削除を行えます．アプリ内で環境全体の削除を開始する場合には別の確認画面があり，実際の保存先，中身，正確なフォルダー名を確認します．他のアプリと共用する環境への変更は，そのアプリのコンパイルにも影響します．管理者権限が必要な場合，Store 版では公式の TeX 管理ツールや Windows のアプリ設定を開きます．原稿はプロジェクトのフォルダーに保存します．

TeX のコマンド，環境，引用キー，相互参照の候補を表示します．環境は対応する終了コマンドまで挿入でき，Tab で次の入力箇所へ進めます．長い文献の題名や著者は候補一覧の横または下で読めます．設定で補完や候補の自動表示をオフにできます．原稿のセクションや環境，Markdown の見出しも折りたためます．アウトラインの縦線で階層を確認し，矢印で下位の見出しを開閉できます．

PDF は連続スクロール，文字の検索・選択，拡大・縮小に対応します．PDF の文章をダブルクリックすると原稿へ，原稿を Ctrl + クリックすると PDF の対応箇所へ移動します．「戻る」「進む」で，PDF 内の参照リンクを開く前の位置にも戻れます．「PDF を暗く表示」で画面上の配色を変更でき，保存する PDF は元の色です．狭い表示欄でも +/− と「ダウンロード」は常に表示します．「PDF の操作」から「名前を付けて保存…」を選ぶと，保存先とファイル名を指定できます．

未保存の編集も含めてプロジェクト全体を検索し，変更内容を確認して選んだ箇所を置換できます．引用キーやラベルの定義・使用箇所を確認し，名前の変更も事前に確認できます．二つの原稿を並べて編集でき，次回はタブと順番，配置を読み戻します．コンパイルのエラーと警告は種類で絞れます．

編集履歴から以前の版と比較し，複数の箇所を選んでまとめて原稿へ戻せます．不要な版も複数選択し，確認画面から削除できます．「編集の操作 → 編集履歴を開く → 履歴の設定」で，初期値の 30 日・合計 50 MiB を変更したり，記録を停止したりできます．自動保存と草稿も使えます．

PNG・JPEG・PDF を 8 MiB まで取り込み，表計算ソフトからコピーした表や，行数と列数から作った表を挿入できます．標準のテンプレートからプロジェクトを作成し，自分の原稿や画像をテンプレートへ追加できます．Markdown は表示された見出し，本文，表，タスク，数式を直接編集する画面で開きます．ピンチや Ctrl + ホイールで文字サイズを変えられ，ソース編集と共通のサイズを次回の起動にも使います．ソースの記法を編集する表示や，プレビューの表示・非表示にも切り替えられます．ソースとプレビューでは両方向のスクロール同期を使えます．

新しい Markdown ページを作り，現在の文書にリンクを挿入できます．Markdown はブラウザの印刷画面から PDF に保存でき，PDF の文字はページ順に取り出して TXT に保存できます．

ファイル一覧の右クリックで作成，コピー，名前の変更，削除，パスのコピーを行えます．「ダウンロード」はブラウザの設定に従ってコピーを保存し，「名前を付けて保存…」は Windows の保存画面で保存先と名前を選べます．編集中のファイルでは，未保存の変更を含む現在の本文を使います．ファイルやフォルダーのコピーには保存済みの内容を使い，元の原稿を引き続き編集できます．コンピューターから複数のファイルを選んで追加する操作もあります．名前順・日時順・手動の順序を選べ，ドラッグで並び替え，フォルダーの中央へのドロップで移動できます．新規ファイルは空で作るか，標準・ユーザーのテンプレートからテキストファイルを 1 個選び，内容を確認して作れます．

各 TeX 文書の最新のコンパイル成功結果を，実際の PDF 名と TeX のパス付きで一覧に表示します．プレビューへ開く，ダウンロードする，名前を付けて保存する，プロジェクトへコピーする操作を選べます．右クリックの「削除…」では，文書とファイルの件数を確認して，その文書の表示用キャッシュとコンパイルの出力・補助ファイルを削除できます．原稿と，通常のファイルとして保存・コピーした PDF はそのまま残り，再コンパイルで結果を作り直せます．

ホームからプロジェクトの ZIP を読み込み，保存先と名前を選んで新しいプロジェクトとして開けます．編集画面の上部や，ホームの最近開いた各プロジェクトにある「ZIP」から，「プロジェクトを ZIP でダウンロード」または「ZIP にして名前を付けて保存…」を選べます．編集中のプロジェクトは原稿を保存してから ZIP を作り，別のプロジェクトはそのフォルダーに保存済みのファイルを書き出します．書き出した後も現在のプロジェクトで編集を続けられます．原稿，参考文献，画像，フォント，元のフォルダー構成をまとめて Overleaf へ持ち込めます．アプリのキャッシュやコンパイルの中間ファイルは除きます．

TeX のロゴからホームへ移り，現在と最近使ったプロジェクトを管理できます．フォルダーの状態を読み直し，見つからない場合は案内を表示します．一覧から外しても原稿と草稿は残ります．未保存の編集がない原稿には外部で変更された本文を読み込み，編集中の場合は内容を比較できます．外部で削除されたファイルも本文と草稿を残して確認できます．プロジェクトの削除には，中身の確認と名前の入力が必要です．Python，JavaScript などのプログラムも編集でき，すべてのタブをまとめて閉じる操作もあります．ブラウザのタブが休止してもアプリは動作を続け，終了ボタンで終了します．ログイン時の起動は初期状態で有効です．ログイン後にバックグラウンドで起動し，PC の再起動後も復元したブラウザのタブから再接続できます．「設定 → ログイン時の起動」からオン・オフを切り替えられます．

初回起動からダークモードを使い，外観の設定でライトやシステムに合わせるモードも選べます．英語・日本語は選択直後に表示を切り替えられ，配色，フォント，各欄の大きさを選べます．原稿，設定，草稿，履歴，テンプレートは PC に保存します．

必要な環境は Windows 10 build 19041 以降または Windows 11 の x64 PC と，現在の Edge または Chrome です．アプリから TeX を導入するか，原稿で使うパッケージを含む既存の TeX Live を選びます．

ソースコードは MIT ライセンスで公開しています．
```

### 製品の機能

各行を 1 件の機能として入力する．Store の入力欄には箇条書きの記号を付けない．

```text
アプリ内購入，有料アップグレード，サブスクリプション，試用期限のない完全無料のアプリ
小さな Go のアプリと既存のブラウザで動作し，専用のブラウザエンジンの導入は不要
アプリから TeX を導入して自動選択するか，既存の TeX を使い，時間制限なしで PC の原稿をコンパイル
PDF を連続スクロール・検索・拡大し，移動前の位置へ戻り，文書ごとの結果を一覧から開く・削除
SyncTeX による原稿と PDF の対応位置への相互移動
Markdown を直接編集し，文字サイズを変え，ソースとプレビューのスクロールを同期
未保存の内容も含めてプロジェクト全体を検索し，選んだ箇所を置換
履歴から複数の箇所をまとめて復元し，不要な版は選んで確認して削除
引用と相互参照の定義・使用箇所を確認し，名前の変更を事前に確認
原稿を二つ並べ，開いていたタブと並び順を復元
コンパイルのエラーと警告を種類で絞り込み
画像の取り込み，コピーした表の挿入，新しい表の作成と編集
ZIP でプロジェクトを読み込み・保存して Overleaf とやり取りし，テンプレートからも原稿を作成
Markdown のページを作成し，現在の文書へ相対リンクを挿入
Markdown を PDF に保存し，PDF の文字を TXT として保存
テキストやコードを編集し，ファイルやフォルダーをコピー・並べ替え・ドラッグで移動
自動保存と草稿を使い，ブラウザのタブが休止した後も作業を再開
日本語・英語を選択直後に確認し，配色と原稿のフォントを選択
TeX のコマンドと環境を補完し，原稿を折りたたんでアウトラインを確認
アプリから導入した TeX と既存の TeX のパッケージを管理し，削除の確認や共用環境の公式ツールを開く
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
アプリから導入する TeX，または latexmk と SyncTeX を含む既存の TeX Live
TeX の導入と追加パッケージの取得にはインターネット接続
初期導入時の空き容量は約 2 GB が目安．追加パッケージによって増加
```

### このバージョンの最新情報

```text
バージョン 0.1.20

・ホームの各プロジェクトから，ZIP のダウンロードと「ZIP にして名前を付けて保存…」を選べるようにした．
・編集中のプロジェクトでは原稿を保存してから ZIP を作り，別のプロジェクトでは保存済みのファイルを書き出せるようにした．
・ログイン時の起動の初期値を有効にした．設定からオン・オフを切り替えられる．
・アプリの自動更新は初期状態で有効とし，Microsoft Store から利用可能な更新を取得する．
```

## Images and captions

Use the **1600 × 1000** PNG screenshots captured from the installed MSIX by `scripts/test-msix.mjs`. They are written to `test-results/msix/` and copied into the `microsoft-store-listing` artifact after both package-build paths. Check that `screenshot-source.json` says `installed-msix` and that the installed-package tests succeeded. If a run failed before capturing all images, its listing artifact uses the available repository screenshots. This size meets the desktop minimum of 1366 × 768. Upload the same images separately for each listing language, with the corresponding captions below.

| Image | English caption | 日本語の説明 |
| --- | --- | --- |
| `editor-tex-dark.png` | Edit TeX source and read the compiled PDF side by side in dark mode. | ダークモードで TeX の原稿とコンパイルした PDF を並べて表示． |
| `editor-markdown-light.png` | Edit rendered Markdown directly in light mode, with headings, equations, task checkboxes and a table. | ライトモードで Markdown の本文を直接編集する画面．見出し，数式，チェック項目，表を表示． |
| `editor-tex-management.png` | See the selected TeX installation and search installed packages before adding or removing them. | 選択中の TeX の保存先と導入済みのパッケージを確認し，検索して追加・削除へ進める管理画面． |
| `tex-setup-home.png` | Open TeX setup from Home. | ホームから TeX のセットアップを開く． |
| `tex-setup-plan.png` | Review the tools and packages included in TeX setup. | 導入するプログラムとパッケージを確認する． |
| `tex-setup-location.png` | Check the download sources, required space and destination before installing. | 取得元，容量，保存先を確認して導入を始める． |
| `tex-setup-progress.png` | Follow the actual download and installation progress. | ダウンロードと導入の進捗を確認する． |
| `tex-setup-complete.png` | Finish TeX setup and create a sample project. | TeX の導入を終えて，サンプルの作成へ進む． |

For the Store app icon, export a **300 × 300 PNG** from [the existing app icon](../internal/branding/app-icon.svg). The package's manifest icons are also required by the package format and are prepared with the MSIX. A separate Store icon gives the listing a consistent image.

Desktop listings accept up to 10 screenshots, each as PNG up to 50 MB. At least one screenshot is required. Captions can contain up to 200 characters. Use images of the submitted app's interface. [Microsoft's image specifications](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/screenshots-and-images)

The eight screenshots show editing, TeX management and each step of setup. The five setup images follow a real installation started from the app. The management image is captured after setup succeeds, with the installed package list filtered by `math`.

## Reviewer notes

In Partner Center, open **Supplemental info > Additional Testing Information** (補足情報 > 追加のテスト情報), paste the notes into **Description**, and choose **Save description**. The app uses no account credentials, so the credentials table can stay empty.

Use these notes with the Store package after checking its launch, save and compile behavior on Windows. The build puts `main.tex` and `notes.md` from [the sample folder](../packaging/windows/review-sample/) at the root of `dist/store-listing/store-review-sample.zip`. The sample URL below already provides that project. Check the download before submitting the app, and update the published ZIP if the sample files have changed.

### English

```text
Local TeX Web Editor is a Windows desktop application with a browser interface. Launching it from the Start menu starts a server on the local loopback address and opens the editor in the default browser. The page is served by the installed app on this computer. No app login or subscription is required.

For review, use a current Microsoft Edge or Google Chrome. Download the sample ZIP below and extract it to a writable project folder. It contains main.tex and notes.md.

Sample project: https://kodai-utsunomiya-mdl.github.io/Local-TeX-Web-Editor/downloads/store-review-sample.zip

1. Launch Local TeX Web Editor and use Open to select that folder.
2. Open notes.md. It starts in Visual editing with the preview closed. Edit a rendered sentence and save with Ctrl+S. Switch to Source to edit the Markdown notation and use the separate preview. Show preview / Hide preview controls its visibility.
3. Open Settings, switch Language between English and Japanese, and change the theme. These changes do not alter document contents.
4. To test setup in version 0.1.20, open Home or Settings > Set up TeX…. Review TinyTeX v2026.11, the packages, about 250 MB of downloads and the destination under the app's LocalState folder. Choose Download and install. Allow about 2 GB of free space and an internet connection. Follow the progress log; Close and continue editing allows editing while setup continues. On a disposable first attempt, Stop setup and confirm that it can be started again.
5. After setup succeeds, the app selects the new environment. Choose pdfLaTeX as the compilation mode for the sample. An existing TeX installation can also be selected in Settings, for example C:\texlive\2026\bin\windows.
6. Open main.tex, set the preview to Auto, and click Compile. A PDF appears on the right.
7. Double-click a sentence in the PDF to open its source line. Ctrl-click that source line to navigate back to the PDF.
8. Open notes.md, use Show preview if it is closed, and choose PDF in the preview toolbar. Editing and saving the Markdown keeps the PDF visible. Select Auto to return to the Markdown preview.
9. Save the files and close the browser tab. The local app keeps running. Launch the same app again to reopen the running editor. Use Quit at the top right to stop it.

In Settings > Manage TeX…, verify the actual folder and installed packages. Search for math, clear the search, and add a small extra package such as blindtext using Review packages to add… and Add these packages. Refresh the list, select that package, and open Remove selected packages…. Review the proposed removals and dependency information; try Cancel before confirming Remove the displayed packages. For an existing shared TeX installation, the Store edition offers Open the TeX management tool when tlshell is installed; this opens the official tool, which handles any administrator approval. Refresh the app's list after changes there.

After the compilation checks, use the disposable app-installed environment to test Remove the entire TeX environment…. Review its actual path, file count and size. The acknowledgment and exact folder name are both required. Try Cancel first, then confirm removal; the sample project's files and Markdown editing remain available. For a shared external installation, Uninstall in Windows Settings… opens the native app settings; opening that screen alone does not mark TeX as removed. The app runs with the current user's permissions.

In notes.md, also try Ctrl + wheel, a trackpad pinch or a two-finger touchscreen pinch in Visual editing. The font size is shared with Source and the other editor pane, and is saved for the next launch.

Right-click main.tex and try Download, then Save as… to choose a folder and file name in the Windows dialog. Confirm the saved text, including a small unsaved edit, and try cancelling the dialog. After compiling main.tex, use Download and Save as… on its Compiled PDFs entry and confirm that both save a PDF. Then use Copy into project… to create saved-main.pdf. Open Delete… on the compiled entry, review the TeX document and file count, and try Cancel. Open the confirmation again and choose Delete. Check that main.tex and the ordinary saved-main.pdf remain in the file list. Compile main.tex again and confirm that its result returns under Compiled PDFs.

Also try Search project with an unsaved edit and review a selected replacement; use Back after following a source or PDF link; and open the second source editor. In Editing tools, try Document history, References and citations, Insert an image, Insert a table, and Manage templates. History settings explains the storage limits and allows recording to be disabled. The Markdown toolbar in notes.md adds formatting, links, code blocks and tables; in Source mode, Sync scrolling links source and preview in both directions. Reopen the app to review the saved tabs and layout. F1 opens Help, and Settings > Appearance provides the color scheme and editor font.

In main.tex, type \b, accept \begin, type i inside the braces, and accept itemize; Tab / Shift+Tab moves between fields. In Settings, try Enable TeX completion and Show suggestions while typing; with automatic suggestions off, Ctrl+Space opens the list. Add \subsection{Details} below the sample section. Fold the section with its line-number arrow or Ctrl+Shift+[, then select Details in Outline: its source should unfold with space above it. Ctrl+Shift+] unfolds at the cursor. Use the Outline arrows to collapse and expand child headings, and also try folding a heading in notes.md. For the compiled PDF, toggle Dark PDF view, narrow the preview, and use the always-visible +/− and Download buttons, and … (PDF actions) for the zoom selector and search. Confirm that the toolbar stays on one row and the saved PDF uses its original colors.

Leave the editor in a background browser tab, return, and continue editing. In Settings, selecting a language changes the dialog immediately; Cancel restores the saved language, and Save and apply settings confirms it. The label always shows Language / 言語設定. Try Close all tabs with Save, Discard and Cancel. Right-click a project entry to create a file/folder, copy a path, rename it, or delete a disposable file or folder. A folder's confirmation lists its contents. Add files from your computer opens the file picker and copies the selected files into the project after reviewing conflicts. Click the TeX logo to see Home, then Return to editing to resume unsaved text. To test project deletion, create a disposable project and review its path, file list, and drafts; the acknowledgment and exact project name are required. A .py file can be edited and saved with syntax highlighting. In notes.md, use the Insert an image, Insert a table and New Markdown page icons in the formatting toolbar. The same actions remain available in Editing tools. Then use Editing tools > Save Markdown as PDF > Print / Save as PDF. Display the compiled PDF and choose Editing tools > Convert PDF to text > Download TXT. The conversion extracts existing PDF text, with no OCR.

In notes.md, insert inline equations using each notation in the math dialog, then switch between visual and source editing. Type --- followed by Enter to add a horizontal rule, and check active toolbar buttons before typing formatted text. Check Japanese italic and strikethrough text next to punctuation. Right-click in TeX and Markdown to open insertion commands, and use Shift+right-click for the browser menu. Try sorting files by name and date, then drag entries into a manual order. Save a file and reopen the app to check the selected order. Save and apply settings should show a clearly visible notification in light and dark themes.

TeX is required for TeX compilation; Markdown editing and preview work without it. Setup and package changes begin after the user reviews and confirms them. Setup downloads the official TinyTeX archive from GitHub, verifies its SHA-256, and obtains packages from CTAN or the matching TeX Live archive. Existing installations use their configured repositories, with a matching-year archive retry for a CTAN year mismatch. Project documents are not uploaded.

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
2. notes.md を開きます．初期状態は「直接編集」で，プレビューは閉じています．表示された文章を編集し，Ctrl + S で保存します．「ソース」へ切り替えると Markdown の記法とプレビューを使えます．「プレビューを表示 / プレビューを閉じる」で表示を変更できます．
3. Settings の Language で英語と日本語を切り替え，テーマも変更します．原稿の内容は変わりません．
4. v0.1.20 のセットアップを確認するため，ホームまたは「設定 → TeX をセットアップ…」を開きます．TinyTeX v2026.11，パッケージ，約 250 MB のダウンロード，アプリの LocalState 内の導入先を確認し，「ダウンロードしてインストール」を選びます．インターネット接続と約 2 GB の空き容量が必要です．進捗とログを確認し，「閉じて編集を続ける」で導入中も編集できます．試験用の最初の操作では「セットアップを停止」も試し，再度開始できることを確認します．
5. 導入が成功すると，新しい環境が選ばれます．このサンプルのコンパイル方法には pdfLaTeX を選びます．設定で C:\texlive\2026\bin\windows などの既存の TeX を選ぶこともできます．
6. main.tex を開き，プレビューを Auto にして Compile を押します．右側に PDF が表示されます．
7. PDF の文章をダブルクリックして原稿の行へ移動し，その行を Ctrl + クリックして PDF へ移動します．
8. notes.md を開き，閉じている場合は「プレビューを表示」を押します．プレビューを PDF にすると，Markdown の編集・保存中も PDF を表示します．Auto に戻すと Markdown を表示します．
9. 原稿を保存してブラウザのタブを閉じても，アプリは動作を続けます．同じアプリを起動すると，起動中の編集画面へ戻ります．右上の終了ボタンで終了します．

「設定 → TeX を管理…」で，実際の保存先と導入済みのパッケージを確認します．math で検索した後に検索を解除し，blindtext などの小さい追加パッケージを入力して「追加する内容を確認…」「確認したパッケージを追加」へ進みます．一覧を更新してその項目を選び，「選んだパッケージを削除…」で削除予定と依存関係を確認します．キャンセルを試してから，「表示したパッケージを削除」で実行します．既存の共用 TeX では，tlshell が導入済みなら「TeX の管理ツールを開く」へ進めます．公式の管理ツールが必要な管理者承認を扱います．そこで変更した後，アプリの一覧を更新します．

コンパイルの確認が終わったら，試験用にアプリから導入した環境で「TeX の環境全体を削除…」を開きます．実際のパス，項目数，容量を確認します．チェックと正確なフォルダー名の入力が両方必要です．キャンセルを試してから削除し，サンプルの原稿と Markdown の編集が引き続き使えることを確認します．共用の外部環境では，「Windows の設定でアンインストール…」から OS のアプリ設定を開きます．この画面を開くだけで TeX が削除された扱いにはなりません．アプリは現在のユーザーの通常の権限で動作します．

notes.md の「直接編集」では Ctrl + ホイール，トラックパッドのピンチ，タッチ画面の 2 本指のピンチも試してください．文字サイズはソースと別のペインで共通になり，次回の起動にも使われます．

main.tex の右クリックから「ダウンロード」と「名前を付けて保存…」を試します．後者では Windows の画面でフォルダーと名前を選び，未保存の変更を含む本文を保存できることとキャンセルを確認します．main.tex をコンパイルした後，「コンパイルした PDF」の項目でも両方の操作で PDF を保存します．続いて「プロジェクトへコピー…」から saved-main.pdf を作ります．同じコンパイル結果で「削除…」を開き，TeX 文書とファイルの件数を確認して「キャンセル」を試します．もう一度確認画面を開いて「削除」を押し，main.tex と通常のファイルの saved-main.pdf が一覧に残ることを確認します．main.tex を再コンパイルすると，その結果が「コンパイルした PDF」に戻ります．

未保存の編集を含む Search project と選んだ箇所の置換，原稿や PDF のリンクから Back で戻る操作，二つ目のエディタを開く操作も確認できます．Editing tools には Document history，References and citations，Insert an image，Insert a table，Manage templates があります．History settings で上限を確認し，記録を停止できます．notes.md の Markdown ツールバーから装飾・リンク・コードブロック・表を挿入できます．「ソース」の Sync scrolling では原稿とプレビューが両方向に動きます．アプリを開き直すと，タブと配置を読み戻します．F1 ではヘルプ，Settings → Appearance では配色と原稿のフォントを確認できます．

main.tex で \b から \begin を選び，中括弧に i と入力して itemize を選びます．Tab / Shift + Tab で入力箇所を移動できます．「設定」の「TeX の入力補完を使う」と「入力中に候補を自動で表示する」を試し，自動表示をオフにした状態で Ctrl + Space から候補を開きます．サンプルのセクションの下に \subsection{Details} を追加し，行番号の横の矢印か Ctrl + Shift + [ でセクションを折りたたみます．アウトラインの Details を選び，原稿が展開され，上側に余白を付けて表示されることを確認します．Ctrl + Shift + ] でも展開できます．アウトラインの矢印で下位の見出しを開閉し，notes.md の見出しも折りたたんでください．コンパイルした PDF で「PDF を暗く表示」を切り替え，表示欄を狭くして常に表示される +/− と「ダウンロード」，「… (PDF の操作)」内の倍率の選択と検索を試します．操作欄が 1 行に収まり，保存した PDF が元の配色であることを確認します．

別のブラウザタブで作業してから編集画面へ戻り，編集を続けてください．設定で言語を選ぶと直ちに表示が切り替わり，キャンセルで元へ戻り，「設定を保存して反映」で確定します．項目名は「Language / 言語設定」です．「すべてのタブを閉じる」の保存・破棄・キャンセルも確認できます．ファイル一覧の右クリックで新規ファイル・フォルダー，パスのコピー，名前の変更を試し，不要なテスト用ファイルやフォルダーを削除してください．フォルダーの確認画面には中身の一覧が表示されます．「コンピューターからファイルを追加…」では選択画面からファイルを選び，同名の項目を確認してプロジェクトへコピーします．TeX のロゴからホームへ移り，「編集に戻る」で未保存の本文から続けられます．プロジェクト削除はテスト用のフォルダーで試し，パス，中身，草稿を確認してください．チェックと正確なプロジェクト名が必要です．.py ファイルも色付けして編集・保存できます．notes.md の書式ツールバーで「画像を挿入」「表を挿入」「新しい Markdown ページ」のアイコンを試します．同じ操作は「編集の操作」からも開けます．続いて「編集の操作 → Markdown を PDF に保存 → 印刷画面で PDF に保存」を試します．コンパイルした PDF を表示して「編集の操作 → PDF をテキストに変換 → TXT をダウンロード」を使えます．この変換は PDF の文字情報を読み取り，OCR は行いません．

notes.md の数式ダイアログでインライン数式の 3 形式を試し，直接編集とソースを切り替えます．--- の後で Enter を押して水平線を追加し，文字を入力する前に選んだ書式もボタンに表示されることを確認します．句読点に接した日本語の斜体と取り消し線を試してください．TeX と Markdown の原稿で右クリックから挿入を選び，Shift + 右クリックでブラウザのメニューを開きます．名前や日時でファイルを並べた後，ドラッグで手動の順序へ並べ替え，保存後と起動し直した後の順番を確認します．「設定を保存して反映」の後に，ライトとダークの両方で通知が読みやすいことを確認します．

TeX のコンパイルには TeX が必要で，Markdown の編集とプレビューは TeX がなくても使えます．導入とパッケージの変更は，ユーザーが内容を確認して開始します．GitHub から公式の TinyTeX を取得して SHA-256 を照合し，パッケージは CTAN または TeX Live の年度に合う過去の配布元から取得します．既存の環境には設定済みの取得先を使い，CTAN との年度の不一致が出た場合は同じ年度の配布元へ再試行します．原稿はアップロードしません．手動のパッケージ用コマンドも使えます．

Store 版のインストールとアプリの更新は Windows が管理します．原稿は選んだプロジェクトフォルダーに保存し，設定・草稿・編集履歴・自分のテンプレート・PDF の表示用コピーはアプリのローカルデータへ保存します．

TeX の導入と使い方: https://github.com/kodai-utsunomiya-mdl/Local-TeX-Web-Editor/blob/main/README.ja.md
プライバシー: https://kodai-utsunomiya-mdl.github.io/Local-TeX-Web-Editor/ja/privacy/
```

### Explanation for `runFullTrust`

Enter this explanation in **Submission options > Restricted capabilities**. The text fits the form's 500-character limit.

```text
Local TeX Web Editor uses runFullTrust to read and save selected project files, run latexmk, TeX and SyncTeX, and open its loopback editor in the browser. With user confirmation it downloads and verifies TinyTeX, installs it in the user's folder, and manages TeX packages and removal. It runs with normal user permissions. For shared TeX requiring administrator approval, it opens the existing official TeX tool or Windows app settings. Documents stay on the PC.
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
