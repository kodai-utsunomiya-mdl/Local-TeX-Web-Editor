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
Local TeX Web Editor edits TeX and Markdown projects on your Windows PC in a browser. Compile with your own TeX Live and read the PDF beside the source. No account or subscription is needed.

Complete TeX commands, environments, citations and labels. Tab moves between inserted fields; Ctrl + Space opens suggestions. Fold source sections and environments, and expand or collapse the outline.

PDF tools include continuous scrolling, search, zoom and SyncTeX navigation. Back and Forward return to earlier positions, including after PDF links. Dark PDF view changes screen colors; saved PDFs keep their original colors. Zoom buttons and Save PDF stay visible in narrow previews; PDF actions contains the remaining controls.

Search and replace across the project, compare local edit history, inspect citation and reference uses, and edit two source documents. Select multiple changes from a recorded version and restore them together, or select unneeded versions and confirm their deletion. Tabs and their order reopen with your project. Filter compilation errors and warnings.

Paste images, create or paste tables, and start from built-in or custom templates. Markdown opens in visual editing for headings, text, tables, tasks, and equations. Switch to source notation, show or hide the preview, and synchronize source and preview scrolling. Create linked Markdown pages, save Markdown as PDF using browser printing, or extract PDF text to TXT.

Manage project files from the context menu, copy multiple files from your computer, and edit Python, JavaScript and other program files. The TeX logo opens Home with current and recent projects. Review a project's contents and enter its name before deleting it. Close all tabs together. The local app keeps running while the browser tab sleeps; use Quit to stop it.

Preview English or Japanese immediately in Settings, adjust panes and appearance, and use autosave and local drafts. Documents, history and templates stay on your PC.

Requires an x64 PC with Windows 10 build 19041 or later, or Windows 11, and current Edge or Chrome. Install TeX Live with latexmk, SyncTeX and the packages your documents need separately. Markdown works without TeX Live. Free and open source under the MIT license.
```

### Product features

Enter each line as one feature, without adding a bullet character to the Store field.

```text
Compile local TeX projects with your installed TeX Live and latexmk
Read PDFs with continuous scrolling, search, selection and zoom
Move between corresponding source and PDF positions with SyncTeX
Edit rendered Markdown directly or switch to source and preview
Search project text, review replacements, and include unsaved edits
Return to earlier source and PDF positions with Back and Forward
Select several history changes to restore, or review and delete unneeded versions
Find citation and reference definitions and uses, and preview key renames
Use two source editors and restore open tabs and their order
Filter compilation errors and warnings by category
Import images, paste tables, or create and edit a new table
Create projects from built-in templates or add your own
Format Markdown and synchronize source and preview scrolling in both directions
Create a Markdown page and insert a relative link to it
Print Markdown to PDF and extract PDF text to a TXT file
Manage project files with a context menu and edit Python and other code files
Use autosave and local drafts, and resume after the browser tab sleeps
Preview English or Japanese, and choose colors and the editor font
Complete TeX commands and environments, fold source, and browse the outline
Use dark PDF colors with zoom and download buttons always visible
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
Version 0.1.10

- Insert inline or display equations in both Markdown editing modes, with rendered TeX and Markdown previews.
- Choose GitHub's backtick math syntax, dollar delimiters, or parentheses for inline equations. GitHub's syntax is the initial choice.
- Type inline math with its closing delimiter to render it. Enter or Space after --- creates a horizontal rule.
- See active formatting on toolbar buttons, including formatting chosen before typing and mixed selections.
- Use compact icons for images, tables, and new pages, with names available on hover.
- Display Japanese italic and strikethrough text correctly, including combined formatting next to punctuation.
- Right-click in TeX or Markdown to insert images and tables. Markdown also offers equations, links, code blocks, and linked pages.
- Sort files and folders by name or modification time in either direction. The chosen order is saved and follows file updates.
- Read notifications and floating menus with stronger backgrounds, borders, and shadows in light and dark modes.
- Save and apply settings explicitly using the renamed button in editing and history settings.
```

## 日本語の掲載内容

### 短い説明

```text
ブラウザで TeX と Markdown を編集し，PC の TeX Live でコンパイルできます．PDF の連続スクロール，SyncTeX による原稿との相互移動，Markdown のプレビューに対応します．
```

### 説明

```text
Local TeX Web Editor は，Windows PC にある TeX と Markdown のプロジェクトをブラウザで編集するアプリです．別途導入した TeX Live でコンパイルし，原稿と PDF を並べて表示します．

TeX のコマンド，環境，引用キー，相互参照の候補を表示します．環境は対応する終了コマンドまで挿入でき，Tab で次の入力箇所へ進めます．長い文献の題名や著者は候補一覧の横または下で読めます．設定で補完や候補の自動表示をオフにできます．原稿のセクションや環境，Markdown の見出しも折りたためます．アウトラインの縦線で階層を確認し，矢印で下位の見出しを開閉できます．

PDF は連続スクロール，文字の検索・選択，拡大・縮小に対応します．PDF の文章をダブルクリックすると原稿へ，原稿を Ctrl + クリックすると PDF の対応箇所へ移動します．「戻る」「進む」で，PDF 内の参照リンクを開く前の位置にも戻れます．「PDF を暗く表示」で画面上の配色を変更でき，保存する PDF は元の色です．狭い表示欄でも +/− と PDF の保存ボタンは常に表示し，そのほかの操作は「PDF の操作」から使えます．

未保存の編集も含めてプロジェクト全体を検索し，変更内容を確認して選んだ箇所を置換できます．引用キーやラベルの定義・使用箇所を確認し，名前の変更も事前に確認できます．二つの原稿を並べて編集でき，次回はタブと順番，配置を読み戻します．コンパイルのエラーと警告は種類で絞れます．

編集履歴から以前の版と比較し，複数の箇所を選んでまとめて原稿へ戻せます．不要な版も複数選択し，確認画面から削除できます．「編集の操作 → 編集履歴を開く → 履歴の設定」で，初期値の 30 日・合計 50 MiB を変更したり，記録を停止したりできます．自動保存と草稿も使えます．

PNG・JPEG・PDF を 8 MiB まで取り込み，表計算ソフトからコピーした表や，行数と列数から作った表を挿入できます．標準のテンプレートからプロジェクトを作成し，自分の原稿や画像をテンプレートへ追加できます．Markdown は表示された見出し，本文，表，タスク，数式を直接編集する画面で開きます．ソースの記法を編集する表示や，プレビューの表示・非表示にも切り替えられます．ソースとプレビューでは両方向のスクロール同期を使えます．

新しい Markdown ページを作り，現在の文書にリンクを挿入できます．Markdown はブラウザの印刷画面から PDF に保存でき，PDF の文字はページ順に取り出して TXT に保存できます．

ファイル一覧の右クリックで作成，名前の変更，削除，パスのコピーを行えます．コンピューターから複数のファイルを選んでプロジェクトへコピーする操作もあります．TeX のロゴからホームへ移り，現在と最近使ったプロジェクトを管理できます．プロジェクトの削除には，中身の確認と名前の入力が必要です．Python，JavaScript などのプログラムも編集でき，すべてのタブをまとめて閉じる操作もあります．ブラウザのタブが休止してもアプリは動作を続け，終了ボタンで終了します．

英語・日本語は選択直後に表示を切り替えられ，配色，フォント，各欄の大きさを選べます．原稿，設定，草稿，履歴，テンプレートは PC に保存します．

必要な環境は Windows 10 build 19041 以降または Windows 11 の x64 PC と，現在の Edge または Chrome です．TeX のコンパイルには latexmk，SyncTeX と原稿で使うパッケージを含む TeX Live を別途導入します．Markdown は TeX Live がなくても使えます．

MIT ライセンスで公開されている無料のアプリです．アプリ用のアカウント登録やサブスクリプションは不要です．
```

### 製品の機能

各行を 1 件の機能として入力する．Store の入力欄には箇条書きの記号を付けない．

```text
導入済みの TeX Live と latexmk で PC の原稿をコンパイル
PDF の連続スクロール，文字の検索・選択，拡大・縮小
SyncTeX による原稿と PDF の対応位置への相互移動
Markdown を表示した形で直接編集し，ソースとプレビューにも切替
未保存の内容も含めてプロジェクト全体を検索し，選んだ箇所を置換
原稿や PDF の移動前の位置へ「戻る」「進む」で移動
履歴から複数の箇所をまとめて復元し，不要な版は選んで確認して削除
引用と相互参照の定義・使用箇所を確認し，名前の変更を事前に確認
原稿を二つ並べ，開いていたタブと並び順を復元
コンパイルのエラーと警告を種類で絞り込み
画像の取り込み，コピーした表の挿入，新しい表の作成と編集
標準のテンプレートから作成し，自分のテンプレートも追加
Markdown の装飾と，原稿・プレビューの両方向のスクロール同期
Markdown のページを作成し，現在の文書へ相対リンクを挿入
Markdown を PDF に保存し，PDF の文字を TXT として保存
右クリックでファイルを操作し，Python などのプログラムを編集
自動保存と草稿を使い，ブラウザのタブが休止した後も作業を再開
日本語・英語を選択直後に確認し，配色と原稿のフォントを選択
TeX のコマンドと環境を補完し，原稿を折りたたんでアウトラインを確認
PDF を暗い配色で表示し，狭い表示欄でも +/− と保存ボタンを利用
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
バージョン 0.1.10

・Markdown の両方の編集モードで，インライン数式と独立した数式を挿入できる．数式と Markdown の記述を確認して挿入する．
・インライン数式は GitHub 向けのバッククォート付き，ドル記号，丸括弧の 3 形式から選べる．初期値は GitHub 向けの形式とした．
・直接編集では数式の閉じ記号まで入力すると数式を表示する．--- の後に Enter または Space を押すと水平線になる．
・書式ボタンに現在の装飾を表示する．文字を入力する前に選んだ装飾や，複数の書式を含む範囲にも対応する．
・画像，表，新規ページはアイコンで表示し，カーソルを合わせると名前が分かる．
・日本語の斜体と取り消し線を表示し，装飾の組み合わせや句読点に接した記法も読み取れるようにした．
・TeX と Markdown の原稿で右クリックすると，画像や表を挿入できる．Markdown では数式，リンク，コードブロック，リンク付きの新規ページも選べる．
・ファイルとフォルダーを名前や更新日時で並び替えられる．昇順と降順を選べ，設定と更新後の並び順にも反映する．
・通知やメニューの背景，境界線，影を調整し，ライトとダークで読みやすくした．
・設定の実行ボタンを「設定を保存して反映」に変更した．編集・コンパイルの設定と履歴の設定で表記を揃えた．
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
2. Open notes.md. It starts in Visual editing with the preview closed. Edit a rendered sentence and save with Ctrl+S. Switch to Source to edit the Markdown notation and use the separate preview. Show preview / Hide preview controls its visibility.
3. Open Settings, switch Language between English and Japanese, and change the theme. These changes do not alter document contents.
4. To test TeX compilation, install TeX Live separately with latexmk, pdflatex and synctex. A smaller TeX Live installation is sufficient for the sample. The installation guide is linked below.
5. If the programs are not found automatically, set the TeX program folder in Settings, for example C:\texlive\2026\bin\windows. Choose pdfLaTeX as the compilation mode for the sample.
6. Open main.tex, set the preview to Auto, and click Compile. A PDF appears on the right.
7. Double-click a sentence in the PDF to open its source line. Ctrl-click that source line to navigate back to the PDF.
8. Open notes.md, use Show preview if it is closed, and choose PDF in the preview toolbar. Editing and saving the Markdown keeps the PDF visible. Select Auto to return to the Markdown preview.
9. Save the files and close the browser tab. The local app keeps running. Launch the same app again to reopen the running editor. Use Quit at the top right to stop it.

Also try Search project with an unsaved edit and review a selected replacement; use Back after following a source or PDF link; and open the second source editor. In Editing tools, try Document history, References and citations, Insert an image, Insert a table, and Manage templates. History settings explains the storage limits and allows recording to be disabled. The Markdown toolbar in notes.md adds formatting, links, code blocks and tables; in Source mode, Sync scrolling links source and preview in both directions. Reopen the app to review the saved tabs and layout. F1 opens Help, and Settings > Appearance provides the color scheme and editor font.

In main.tex, type \b, accept \begin, type i inside the braces, and accept itemize; Tab / Shift+Tab moves between fields. In Settings, try Enable TeX completion and Show suggestions while typing; with automatic suggestions off, Ctrl+Space opens the list. Add \subsection{Details} below the sample section. Fold the section with its line-number arrow or Ctrl+Shift+[, then select Details in Outline: its source should unfold with space above it. Ctrl+Shift+] unfolds at the cursor. Use the Outline arrows to collapse and expand child headings, and also try folding a heading in notes.md. For the compiled PDF, toggle Dark PDF view, narrow the preview, and use the always-visible +/− and Save PDF buttons, and … (PDF actions) for the zoom selector and search. Confirm that the toolbar stays on one row and the saved PDF uses its original colors.

For version 0.1.10, leave the editor in a background browser tab, return, and continue editing. In Settings, selecting a language changes the dialog immediately; Cancel restores the saved language, and Save and apply settings confirms it. The label always shows Language / 言語設定. Try Close all tabs with Save, Discard and Cancel. Right-click a project entry to create a file/folder, copy a path, rename it, or delete a disposable file or folder. A folder's confirmation lists its contents. Add files from your computer opens the file picker and copies the selected files into the project after reviewing conflicts. Click the TeX logo to see Home, then Return to editing to resume unsaved text. To test project deletion, create a disposable project and review its path, file list, and drafts; the acknowledgment and exact project name are required. A .py file can be edited and saved with syntax highlighting. In notes.md, use Image, Table and New page in the formatting toolbar. The same actions remain available in Editing tools. Then use Editing tools > Save Markdown as PDF > Print / Save as PDF. Display the compiled PDF and choose Editing tools > Convert PDF to text > Download TXT. The conversion extracts existing PDF text, with no OCR.

In notes.md, insert inline equations using each notation in the math dialog, then switch between visual and source editing. Type --- followed by Enter to add a horizontal rule, and check active toolbar buttons before typing formatted text. Check Japanese italic and strikethrough text next to punctuation. Right-click in TeX and Markdown to open insertion commands, and use Shift+right-click for the browser menu. Try all four file sort orders, save a file, and reopen the app to check the selected order. Save and apply settings should show a clearly visible notification in light and dark themes.

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
2. notes.md を開きます．初期状態は「直接編集」で，プレビューは閉じています．表示された文章を編集し，Ctrl + S で保存します．「ソース」へ切り替えると Markdown の記法とプレビューを使えます．「プレビューを表示 / プレビューを閉じる」で表示を変更できます．
3. Settings の Language で英語と日本語を切り替え，テーマも変更します．原稿の内容は変わりません．
4. TeX のコンパイルを確認するため，latexmk，pdflatex，synctex を含む TeX Live を別途導入します．このサンプルには小さめの TeX の構成を使えます．導入手順は末尾の README にあります．
5. 自動で見つからない場合は，Settings で C:\texlive\2026\bin\windows などの TeX のプログラムの場所を指定します．このサンプルのコンパイル方法には pdfLaTeX を選びます．
6. main.tex を開き，プレビューを Auto にして Compile を押します．右側に PDF が表示されます．
7. PDF の文章をダブルクリックして原稿の行へ移動し，その行を Ctrl + クリックして PDF へ移動します．
8. notes.md を開き，閉じている場合は「プレビューを表示」を押します．プレビューを PDF にすると，Markdown の編集・保存中も PDF を表示します．Auto に戻すと Markdown を表示します．
9. 原稿を保存してブラウザのタブを閉じても，アプリは動作を続けます．同じアプリを起動すると，起動中の編集画面へ戻ります．右上の終了ボタンで終了します．

未保存の編集を含む Search project と選んだ箇所の置換，原稿や PDF のリンクから Back で戻る操作，二つ目のエディタを開く操作も確認できます．Editing tools には Document history，References and citations，Insert an image，Insert a table，Manage templates があります．History settings で上限を確認し，記録を停止できます．notes.md の Markdown ツールバーから装飾・リンク・コードブロック・表を挿入できます．「ソース」の Sync scrolling では原稿とプレビューが両方向に動きます．アプリを開き直すと，タブと配置を読み戻します．F1 ではヘルプ，Settings → Appearance では配色と原稿のフォントを確認できます．

main.tex で \b から \begin を選び，中括弧に i と入力して itemize を選びます．Tab / Shift + Tab で入力箇所を移動できます．「設定」の「TeX の入力補完を使う」と「入力中に候補を自動で表示する」を試し，自動表示をオフにした状態で Ctrl + Space から候補を開きます．サンプルのセクションの下に \subsection{Details} を追加し，行番号の横の矢印か Ctrl + Shift + [ でセクションを折りたたみます．アウトラインの Details を選び，原稿が展開され，上側に余白を付けて表示されることを確認します．Ctrl + Shift + ] でも展開できます．アウトラインの矢印で下位の見出しを開閉し，notes.md の見出しも折りたたんでください．コンパイルした PDF で「PDF を暗く表示」を切り替え，表示欄を狭くして常に表示される +/− と保存ボタン，「… (PDF の操作)」内の倍率の選択と検索を試します．操作欄が 1 行に収まり，保存した PDF が元の配色であることを確認します．

v0.1.10 では，別のブラウザタブで作業してから編集画面へ戻り，編集を続けてください．設定で言語を選ぶと直ちに表示が切り替わり，キャンセルで元へ戻り，「設定を保存して反映」で確定します．項目名は「Language / 言語設定」です．「すべてのタブを閉じる」の保存・破棄・キャンセルも確認できます．ファイル一覧の右クリックで新規ファイル・フォルダー，パスのコピー，名前の変更を試し，不要なテスト用ファイルやフォルダーを削除してください．フォルダーの確認画面には中身の一覧が表示されます．「コンピューターからファイルを追加…」では選択画面からファイルを選び，同名の項目を確認してプロジェクトへコピーします．TeX のロゴからホームへ移り，「編集に戻る」で未保存の本文から続けられます．プロジェクト削除はテスト用のフォルダーで試し，パス，中身，草稿を確認してください．チェックと正確なプロジェクト名が必要です．.py ファイルも色付けして編集・保存できます．notes.md の書式ツールバーで「画像」「表」「新規ページ」を試します．同じ操作は「編集の操作」からも開けます．続いて「編集の操作 → Markdown を PDF に保存 → 印刷画面で PDF に保存」を試します．コンパイルした PDF を表示して「編集の操作 → PDF をテキストに変換 → TXT をダウンロード」を使えます．この変換は PDF の文字情報を読み取り，OCR は行いません．

notes.md の数式ダイアログでインライン数式の 3 形式を試し，直接編集とソースを切り替えます．--- の後で Enter を押して水平線を追加し，文字を入力する前に選んだ書式もボタンに表示されることを確認します．句読点に接した日本語の斜体と取り消し線を試してください．TeX と Markdown の原稿で右クリックから挿入を選び，Shift + 右クリックでブラウザのメニューを開きます．ファイルの並び順を 4 通り試し，保存後と起動し直した後の順番を確認します．「設定を保存して反映」の後に，ライトとダークの両方で通知が読みやすいことを確認します．

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
