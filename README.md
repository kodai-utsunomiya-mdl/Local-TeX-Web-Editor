# Local TeX Editor

English | [日本語](README.ja.md)

[![Download for Windows](docs/download-windows.svg)](https://github.com/kodai-utsunomiya-mdl/local-tex-editor/releases/download/v0.1.4/local-tex-editor-0.1.4-windows-x64.zip)
&nbsp;&nbsp;
[![Download for macOS](docs/download-macos.svg)](https://github.com/kodai-utsunomiya-mdl/local-tex-editor/releases/download/v0.1.4/local-tex-editor-0.1.4-macos-universal.zip)

**v0.1.4** · [All downloads and release notes](https://github.com/kodai-utsunomiya-mdl/local-tex-editor/releases/latest) · [Requirements](#requirements) · [Get started](#download-and-launch)

Edit TeX documents in your browser on Windows or macOS, and compile them with TeX Live on your computer. The editor and PDF preview appear in the same window. Launching the app opens a `localhost` page in your default browser. Markdown editing and preview are also supported.

![Local TeX Editor showing a TeX document and its PDF in dark mode](docs/screenshots/editor-dark.png)

Documents stay in the project folder on your computer. The app uses your TeX Live installation and the project's `latexmkrc`, and displays compilation logs and the resulting PDF. The distributed app runs without installing Python, Node.js, Go, or VS Code.

## Why this editor exists

This project grew out of the author's experience using several editors for TeX documents.

- **Overleaf:** Longer documents reached the compilation time limit, and searching for a pasted block of text spanning several lines was cumbersome. The browser editing workflow was still useful.
- **VS Code:** The existing setup could already compile with TeX Live. For writing TeX alone, its broader development features felt unnecessary, and starting the desktop editor felt heavy on a computer where memory was limited.
- **Prism:** It provided a browser workspace for writing. OpenAI's [announcement that the service will end on January 1, 2027](https://openai.com/index/introducing-prism/) prompted the search for another place to continue that work.

TeX Live was already installed on the computer. Local TeX Editor connects that installation to a browser editor, with continuous PDF scrolling, source–PDF navigation, multiline search, and Markdown preview in the same workspace. The aim is to make everyday writing comfortable while using the tools and files already on the computer.

## Requirements

Compilation uses TeX Live installed on your computer. If you can already compile your project in another editor, select that same TeX Live installation in Settings.

| Requirement | Windows | macOS |
| --- | --- | --- |
| OS and CPU | Windows 10 / 11, 64-bit (x64) | macOS 12 Monterey or later, Apple Silicon or Intel |
| Browser | Current Chrome or Edge | Current Chrome or Edge |
| TeX distribution | [TeX Live](https://tug.org/texlive/windows.html) | [BasicTeX / MacTeX](https://tug.org/mactex/), or TeX Live with the packages your project needs |
| Example TeX folder | `C:\texlive\2025\bin\windows` | `/Library/TeX/texbin` |
| Documents | A project folder on your computer | A project folder on your computer |

The macOS requirement follows the [operating systems supported by Go 1.25](https://go.dev/doc/go1.25#darwin), which is used to build the app. MacTeX documents `/Library/TeX/texbin` as the TeX location for GUI applications in [What Is Installed](https://tug.org/mactex/What_Is_Installed.pdf).

### TeX programs used by the app

| Program | Purpose |
| --- | --- |
| `latexmk` | Compiles the document and repeats the required steps for citations and cross-references |
| `pdflatex`, `uplatex`, `xelatex`, `lualatex`, or another configured engine | Runs the TeX engine selected for the document |
| `synctex` | Navigates between corresponding positions in the source and PDF |
| `bibtex`, `upbibtex`, `biber`, or another bibliography processor | Processes references using the method selected by the project |
| Packages and fonts used by the document | Provides document classes, `\usepackage` dependencies, Japanese fonts, and other resources |

An upLaTeX project usually needs `uplatex` and `dvipdfmx`, and may use `upbibtex` for references. Include the project's `latexmkrc` or `.latexmkrc` when you copy the project to your computer.

### Start with a smaller TeX installation

The app can use a partial TeX Live installation. Start with a basic set of packages, then add what your documents need through TeX Live Manager (`tlmgr`).

On **Windows**, open the [TeX Live network installer](https://tug.org/texlive/acquire-netinstall.html) and choose an installation `scheme` under **Advanced**. The `small` scheme includes basic LaTeX with some additional programs and languages; `medium` includes more packages. You can also select individual `collection` groups. The official [installation guide](https://tug.org/texlive/doc/texlive-en/texlive-en.html) explains the choices and their installation screens.

On **Mac**, [BasicTeX](https://tug.org/mactex/morepackages.html) provides an installation based on `scheme-small`. After installation, use `/Library/TeX/texbin/tlmgr` to add packages. See the official [BasicTeX guide](https://tug.org/mactex/BasicTeX.pdf) for details.

Add `latexmk` for compilation and `synctex` for navigation between source and PDF. For Japanese documents, add `collection-langjapanese`; it includes Japanese engines, document classes, fonts, and their dependencies. Add packages for mathematics, figures, and bibliography management as your documents require them.

To reduce disk usage, the TeX Live installer lets you omit package documentation and source files. In an existing installation, `tlmgr option docfiles 0` and `tlmgr option srcfiles 0` change these options for future package installations. Existing documentation and source files remain on disk. These options are described in the [install-tl manual](https://tug.org/texlive/doc/install-tl.html).

### Add packages later

Open **Settings → Add TeX packages** to see the programs found in your TeX installation and prepare installation commands. You can choose `latexmk` and SyncTeX, choose Japanese typesetting, or enter package names. Copy the commands into PowerShell on Windows or Terminal on Mac. The app uses the configured TeX folder and the installation year it can identify. For older TeX Live releases, it selects that year's `tlnet-final` repository.

For the current TeX Live release, the following commands are examples. Change the Windows path to match your installation.

```powershell
& 'C:\texlive\2026\bin\windows\tlmgr.bat' update --self
& 'C:\texlive\2026\bin\windows\tlmgr.bat' install latexmk synctex synctex.windows collection-langjapanese
```

```sh
sudo /Library/TeX/texbin/tlmgr update --self
sudo /Library/TeX/texbin/tlmgr install latexmk synctex collection-langjapanese
```

The standard MacTeX / BasicTeX installation location requires `sudo` for changes. If TeX Live is installed in your own user folder, clear **Use sudo for installation** in the app. If Windows reports a permission error, check the installation location and the account that installed TeX Live; run the same commands in an administrator PowerShell when that installation requires it.

For an error such as `File 'siunitx.sty' not found`, use `tlmgr search --global --file '/siunitx\.sty$'` to find the package that contains the file, then install the package shown in the result, for example `tlmgr install siunitx`. File names and package names can differ. The app's **Find a package from a missing file** section prepares this search command from a file name. The [tlmgr manual](https://tug.org/texlive/doc/tlmgr.html) documents both `search` and `install`.

For custom `.sty` or `.cls` files supplied with a document, obtain them from the document's publisher or author and place them in the project. After adding packages, reopen Settings and compile again. If a package is registered as installed but its executable is missing, select the option to download its files again, or use `tlmgr install --reinstall`. See [Add SyncTeX](#add-synctex) for an example.

### Check your TeX installation

In Windows PowerShell, adjust the year and path to match your installation:

```powershell
& 'C:\texlive\2025\bin\windows\latexmk.exe' -v
& 'C:\texlive\2025\bin\windows\synctex.exe' help
```

In Terminal on Mac:

```sh
/Library/TeX/texbin/latexmk -v
/Library/TeX/texbin/synctex help
```

When these commands display their version or usage information, select the same TeX folder in the app's Settings. To add these two programs to MacTeX / BasicTeX, use `sudo /Library/TeX/texbin/tlmgr install latexmk synctex`. For older TeX Live releases, see [Add SyncTeX](#add-synctex) for the repository to use.

## Download and launch

### Windows

1. Open [Releases](https://github.com/kodai-utsunomiya-mdl/local-tex-editor/releases) and select the latest version.
2. Under **Assets**, download `local-tex-editor-0.1.4-windows-x64.zip`. The **Source code** archives contain the files for development.
3. Extract the ZIP and double-click `local-tex-editor.exe`.
4. In the browser window, choose your project folder. You can also enter its path.
5. If TeX Live is not found automatically, open Settings and select the folder containing `latexmk.exe`, for example `C:\texlive\2025\bin\windows`.
6. Open the `.tex` document you want to compile and click **Compile**.

The Windows executable does not have a code signature. If SmartScreen displays **Windows protected your PC** when opening the file downloaded from this repository's release, select **More info**, check the app name, and choose **Run anyway**. See [Microsoft's guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/publish-first-app).

### macOS

1. Under **Assets** in [Releases](https://github.com/kodai-utsunomiya-mdl/local-tex-editor/releases), download `local-tex-editor-0.1.4-macos-universal.zip`. The same ZIP supports Apple Silicon and Intel.
2. Extract the ZIP and move `Local TeX Editor.app` to **Applications**.
3. Open **Local TeX Editor** from Finder or Spotlight. The editor opens in your browser.
4. Open your project folder. If TeX is not found automatically, select `/Library/TeX/texbin` in Settings.
5. Open the `.tex` document you want to compile and click **Compile**.

The macOS app does not have an Apple Developer ID signature or notarization. If macOS blocks the first launch, confirm that you downloaded it from this repository's release, then use **System Settings → Privacy & Security → Open Anyway**. See [Apple's instructions](https://support.apple.com/en-us/102445).

### Open a project and finish a session

To use a project from Overleaf, download its source as a ZIP, extract it, and open that folder. For a project obtained from GitHub or another source, select the folder containing the `.tex` and `.bib` files, images, `latexmkrc`, and other project files.

Closing the last browser tab connected to the editor stops the app and any running compilation after about five seconds. Reloading the page and reconnecting within that time, or keeping another editor browser tab open, lets the app continue running. The browser asks for confirmation when a document has unsaved edits. Drafts are also recorded on your computer while you edit, and are available when you next open the app.

You can also use the exit button at the top right. If there are unsaved edits, choose whether to save them to the project files or leave them as drafts. If the browser does not allow the tab to close automatically, the page shows that the app has stopped. Close the tab with `Ctrl + W` on Windows or `Cmd + W` on Mac.

### Update the app

On Windows, extract the new ZIP and launch its `.exe`. If another version is running, the app shows both the running version and the version you just launched. Save your documents and exit the old version to open the new one. Settings shows the app version and the path of the running executable.

On Mac, save your documents and exit the app, replace the old copy in **Applications** with the new `Local TeX Editor.app`, then open it. Settings and drafts are loaded from your user configuration folder.

Launching the same version again connects to the existing editor. A project lock also prevents multiple app processes from compiling the same project at the same time.

### Launch from the Start menu or desktop (Windows)

1. Open **Settings**.
2. Under **App shortcuts**, click **Add to Start menu** or **Create on desktop**.
3. Next time, find **Local TeX Editor** in the Start menu or open the desktop shortcut. The app and browser will open.

This places the app at `%LOCALAPPDATA%\Programs\LocalTeXEditor\local-tex-editor.exe`. The shortcut continues to work if you move the original download folder. All copies use the same settings and drafts.

The executable, shortcuts, and browser tab use a white TeX icon on a green background.

Launching the `.exe` from a new ZIP updates the installed copy and the Start menu or desktop shortcuts you have already created. The same shortcuts then launch the new version.

## Edit documents

The interface starts in **English**. Use **Settings → Language → 日本語** to switch to Japanese. Your language choice is saved for future sessions. This setting changes the app's controls and messages; documents, PDFs, and Markdown content are displayed as written.

Open `.tex`, `.bib`, and other files from the file list on the left. Each file opens in a tab. Drag the divider between the editor and preview to adjust their widths. Use the theme button at the top right to switch between light and dark mode. Settings lets you choose an editor font size from 8 to 40 px; the default is 14 px. The theme and font size are saved for future sessions.

Expand folders in the file list to browse their contents. Selecting an image or PDF opens it in the editor's tab area. Returning to a source tab restores the text and cursor position you were working with.

Selected text has a visible background in both themes, including selections on the current line and selections left in the editor after you move focus elsewhere.

| Action | How to use it |
| --- | --- |
| Find files or headings | Use the search field on the left. In the **Outline** tab, click a section or subsection to move to its source line |
| Insert citations | Inside `\citep{` or `\cite{`, completion offers keys from the project's `.bib` files, with author, year, and title information |
| Insert cross-references | Inside `\ref{`, `\eqref{`, `\cref{`, and similar commands, completion offers labels from the source |
| Open completion | Press `Ctrl + Space`. TeX commands are also available |
| Search and replace in source | Press `Ctrl + F` in the editor or click the **Find and replace** button. You can paste a selection containing multiple lines |
| Change the editor font size | Use `Ctrl + wheel` over the editor, pinch on a touchpad, or use two fingers on a touchscreen. Settings reflects the new size |
| Save | Press `Ctrl + S` for the current file or `Ctrl + Shift + S` for all open files |
| Compile | Press `Ctrl + Enter` or click **Compile**. The app saves the files and compiles the TeX document selected by the active editor tab |
| Go to an error | Click the file name and line number shown above the log |

On Mac, use `Cmd` in place of `Ctrl` for saving, searching, compiling, and the SyncTeX click action. Zoom with `Ctrl + wheel` or a trackpad pinch.

The search and replacement fields accept newlines and TeX backslashes as entered. Press `Enter` for the next match, `Shift + Enter` for the previous match, and `Ctrl + Enter` to insert a newline in a field. A checkbox enables regular expressions.

Changing the font size or theme leaves the document content and compiled PDF unchanged. The notice to recompile appears when source files or compilation settings have changed.

### Autosave and returning to your work

Autosave is enabled initially. The app saves the source file when typing pauses. You can continue editing while compilation runs; autosave waits until compilation finishes. Turn autosave off in Settings if you prefer to save manually.

Drafts are recorded on your computer in addition to saving the project files. If a draft is available when you reopen the app, choose **Review drafts**, compare it with the file, and select **Open draft in the editor**. If another application changes a source file, the app lets you compare the disk version with your edits and choose what to save.

The next session opens the previous project and restores source cursor positions, the PDF page, and the zoom level. The last successfully compiled PDF is available immediately for reading.

### Edit Markdown

With the preview type set to **Auto**, opening a `.md` or `.markdown` file displays its Markdown preview on the right. The preview updates as you type and supports headings, lists, tables, code blocks, task lists, links, images, and mathematics. Click **Preview** or press `Ctrl + Enter` to save and refresh it.

The preview toolbar offers **Auto**, **PDF**, and **Markdown**. Choose **PDF** to read the PDF while editing Markdown. Choose **Markdown** to keep the last edited Markdown document visible when you switch to a TeX tab. The chosen preview remains visible after saving or compiling. Return to **Auto** to follow the file being edited. The project remembers this choice for the next session.

Mathematics supports `$...$`, GitHub's dollar-and-backtick syntax, `$$...$$`, fenced `math` blocks, and `\(...\)`. Use paths relative to the Markdown file for images inside the project. External images appear as links that open their URLs in the browser.

Relative links in the preview can open other project documents. Double-click a paragraph or heading to move to its corresponding source line. Each Markdown document has its own saved scroll position. Returning to the PDF preview shows the last compiled PDF.

## Read the PDF and navigate to source

The PDF scrolls continuously across pages. The app prioritizes rendering the visible page and nearby pages, so a long document does not require rendering every page into an image at once. You can select and copy PDF text and follow links inside the PDF.

| Action | How to use it |
| --- | --- |
| Zoom | Use **＋** / **−**, choose a zoom level, or use `Ctrl + wheel`. Touchpad pinch is also supported |
| Fit the view | Choose **Fit width** or **Fit page** from the zoom menu |
| Go to a page | Enter a page number or use the left and right arrows |
| Search PDF text | Click **Find in PDF** or press `Ctrl + F` while the PDF has focus. Use `Enter` / `Shift + Enter` for the next / previous result |
| Go from PDF to source | Double-click text in the PDF. The corresponding `.tex` file opens and the destination line is briefly highlighted |
| Go from source to PDF | `Ctrl + click` a source line, or place the cursor and click the arrow button above the editor to show that position in the PDF. The corresponding PDF position is briefly highlighted |
| Export the PDF | Click **Save PDF** |

Source–PDF navigation uses TeX Live's `synctex`. The app generates SyncTeX data during compilation and stores it with the matching PDF. TeX macros and the layout of equations can map a clicked character to a nearby source line. Editing the source after compilation displays a notice that the PDF can be updated.

### Add SyncTeX

If `synctex.exe` is missing, use TeX Live Manager to add `synctex` and its Windows executable. For TeX Live 2025 installed at `C:\texlive\2025`, run these commands in PowerShell:

```powershell
& 'C:\texlive\2025\bin\windows\tlmgr.bat' --repository 'https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2025/tlnet-final' update --self

& 'C:\texlive\2025\bin\windows\tlmgr.bat' --repository 'https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2025/tlnet-final' install --reinstall synctex synctex.windows

& 'C:\texlive\2025\bin\windows\synctex.exe' help
```

When adding packages to an older TeX Live release, use that year's `tlnet-final`. The `--repository` option above selects the repository for each command. `--reinstall` downloads the files again even if the package is already registered as installed. See [TUG's download guidance](https://www.tug.org/texlive/acquire.html) and the [tlmgr manual](https://www.tug.org/texlive/doc/tlmgr.html).

Once `synctex.exe help` displays its usage information, compile once in the app before using source–PDF navigation. If your TeX Live installation is elsewhere, change both the command paths and the app's TeX Live folder setting.

After recompiling, the PDF stays near the page you were reading. If compilation fails or is stopped, the last successful PDF remains available while you edit.

Open **Log** at the top right when you need the compilation details. The log opens automatically after a failed compilation.

## Configure compilation

The active `.tex` tab selects the document to compile. If the open file contains `\documentclass` or `\begin{document}`, clicking **Compile** builds that document and displays its PDF. Switching TeX tabs alone leaves the displayed PDF unchanged. The top toolbar shows the next compilation target, and the PDF toolbar shows the document currently displayed.

When editing a chapter included with `\input`, a shared preamble, or another supporting file, compilation uses **Default main document** in Settings. To choose a parent document for an individual file, add a comment such as `% !TeX root = ../main.tex`. The path is relative to the folder containing that file.

The app records the PDF page and zoom for each document. If compilation of a different document fails, you can continue working with the previous successful PDF and its SyncTeX data.

For a project with an existing `latexmkrc`, choose **Use latexmkrc settings** as the compiler. The app uses the `uplatex`, `upbibtex`, `dvipdfmx`, and other commands configured in `latexmkrc` or `.latexmkrc`.

For projects without `latexmkrc`, you can select pdfLaTeX, upLaTeX, XeLaTeX, or LuaLaTeX. The app runs `latexmk`, which also handles the repeated runs needed for references and citations.

Intermediate files are stored for each document under `.local-tex-editor/build` inside the project. Later compilations reuse that document's intermediate files. If you manage the project with Git, you can add the following to its `.gitignore`:

```gitignore
.local-tex-editor/
```

The app does not impose a compilation time limit. Use the stop button to stop a running compilation.

## App files and storage

The executable includes the JavaScript, PDF.js worker, fonts, and other files needed by the editor. These resources are available locally when the app starts.

Settings, drafts, previous view positions, and copies of the PDF and SyncTeX data are stored in `%APPDATA%\LocalTeXEditor` on Windows or `~/Library/Application Support/LocalTeXEditor` on Mac. Source files are saved in the project folder you selected. Using a copy of the PDF lets you keep reading while TeX writes the next version.

The server listens only on a loopback address such as `127.0.0.1`. File and compilation APIs use a token generated when the app starts.

## Development

These instructions are for building and developing the app. The distributed `.exe` and `.app` include their runtime and can be launched directly.

Development requires Node.js 22.13 or later and Go 1.25 or later. Tests also use TeX Live / TinyTeX and Chromium. Building the macOS `.app` requires Xcode Command Line Tools.

Build on Windows:

```sh
npm ci
npm run test:unit
npm run build
npm run build:windows-resources
go test ./...
go build -o bin/local-tex-editor.exe ./cmd/local-tex-editor
```

Build a Windows distribution executable:

```sh
go build -trimpath -ldflags="-s -w -H=windowsgui -X main.version=0.1.4" -o dist/local-tex-editor.exe ./cmd/local-tex-editor
```

`build:windows-resources` generates Windows x64 resources from the bundled ICO. The executable embeds nine icon sizes from 16 to 256 px.

Build on macOS:

```sh
npm ci
npm run test:unit
npm run build
go test ./...
npx playwright install chromium
node scripts/build-macos.mjs
```

This creates `dist/local-tex-editor-0.1.4-macos-universal.zip` with an app supporting Apple Silicon and Intel, the English and Japanese READMEs, and license files.

Command-line options:

```text
--project PATH       Project folder to open
--tex-bin PATH       Folder containing TeX Live executables
--no-browser         Do not open the browser automatically
--listen ADDRESS     Loopback address and port (default: 127.0.0.1:0)
--config-dir PATH    Folder for settings and cache
--ready-file PATH    File to receive the server URL and token
--version            Print the app version
```

`--ready-file` is used by automated tests and similar tools. It contains the token needed to operate the app and is removed when the app exits.

GitHub Actions builds the app and checks it on Windows and on macOS with Apple Silicon and Intel. Windows tests cover TeX in folders containing Japanese characters and spaces, bibliographies, PDF scrolling, zoom and search, SyncTeX in both directions, autosave, draft recovery, and navigation to errors. The macOS jobs extract the same distribution ZIP on both CPU architectures and check app launch, Japanese TeX, SyncTeX, document switching, Markdown, and exit. Everyday document compilation uses TeX Live on your computer.

When the Windows and both macOS test jobs on `main` succeed, and no release exists for the version in `package.json`, that run publishes the tested app archives to Releases. To release a new version, update `package.json` and add `release-notes/v<version>.md`. You can also download the archives from the Actions artifacts named `local-tex-editor-windows-x64` and `local-tex-editor-macos-universal`. The release's `SHA256SUMS.txt` lists the SHA-256 hash of each ZIP.

## Libraries

- [CodeMirror](https://codemirror.net/): editor (MIT)
- [PDF.js](https://mozilla.github.io/pdf.js/): PDF display (Apache-2.0)
- [markdown-it](https://github.com/markdown-it/markdown-it): Markdown rendering (MIT)
- [KaTeX](https://katex.org/): mathematics in Markdown (MIT)
- [DOMPurify](https://github.com/cure53/DOMPurify): preview HTML processing (Apache-2.0 or MPL-2.0)
- [Go](https://go.dev/): HTTP server and TeX execution

JavaScript dependency versions are recorded in `package-lock.json`. The bundled libraries' license texts are available at the app's `/THIRD_PARTY_LICENSES.txt`. Local TeX Editor itself is licensed under [MIT](LICENSE).
