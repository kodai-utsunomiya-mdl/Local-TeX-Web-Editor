# Privacy policy for Local TeX Web Editor

Last updated: 18 November 2026

[日本語](privacy.ja.md)

Local TeX Web Editor edits documents stored on your computer and uses your local TeX installation to compile them. The app has no document-upload service, advertising, usage analytics or automatic crash-report uploads. It does not require an app account.

## Documents and local app data

The app reads and writes documents in the project folder you select. It also reads project files to show the file list, document outline, citation and reference suggestions, images and PDF previews. TeX compilation runs against files on your computer.

To support saving and resuming work, the app stores the following on your computer:

- Project and TeX installation paths, recent projects and compilation settings.
- Interface language, theme, font size and autosave preferences.
- Local drafts, including text that has not yet been saved to a project file.
- Open documents, cursor positions and preview positions.
- Copies of compiled PDFs, SyncTeX data and information about the corresponding source files.

These files are used to operate the editor and resume your previous session. The developer does not receive their contents through the app.

Settings, drafts and preview copies are stored in the app's user-data folder. On Windows, the Microsoft Store edition uses its package's `LocalState` folder; the ZIP edition uses `%APPDATA%\LocalTeXEditor`. On Mac, the default location is `~/Library/Application Support/LocalTeXEditor`. Compilation files and logs are also written within the project's `.local-tex-editor/build` folder or the output location selected by the project's TeX configuration.

On its first launch, the Store edition can copy settings, drafts and view preferences from an existing ZIP installation into its own user-data folder. The original files remain in the ZIP edition's folder. Project source files remain where you placed them.

The browser stores the selected theme locally. While a draft is being written to the app's data folder, it may also store a temporary draft backup. That backup is removed after the app confirms the save. The local connection token is stored in the browser tab's session storage.

## Local communication

Launching the app starts a server on a loopback address such as `127.0.0.1` and opens the browser on the same computer. Editing, saving, compiling and previewing use this local connection. Access to the file and compilation APIs requires a token generated when the app starts.

The editor's scripts, fonts and PDF-viewing resources are included with the app. Editing and previewing do not require loading these resources from an external service.

## External links and other software

When you choose an external link in a document or in the app's help, your browser opens the linked website. That website handles the resulting request under its own privacy policy. External images in Markdown are shown as links; the preview does not download them automatically. Images inside your project are read locally.

TeX engines, bibliography programs and commands specified by your project run as separate programs. Their access to files and the network depends on their own configuration. The TeX package help prepares commands for you to run in a terminal. When you run an installation command, the package manager connects to its configured repository.

If you place a project or app-data folder in a location managed by OneDrive, iCloud or another synchronization or backup service, that service can copy the files according to your settings.

If you install the app through Microsoft Store, Microsoft handles Store installation and updates under the [Microsoft Privacy Statement](https://www.microsoft.com/en-us/privacy/privacystatement). Your browser and operating system also have their own privacy settings. The app does not ask for or receive your Microsoft account credentials.

## Managing your data

You can edit, copy and delete project files using your normal file tools. The app's draft-recovery dialog offers an option to delete a saved draft. Settings lets you turn autosave on or off; local drafts are recorded independently of that setting.

To remove the app's saved settings, drafts and preview copies, first save the documents you want to keep and close the app, then remove its user-data folder. Browser site-data controls can remove the saved theme and any remaining browser draft backups. Project files and files in a previous ZIP installation's data folder are managed separately.

## Support and the project website

The project website, downloads and issue tracker are hosted on GitHub. If you open these pages, GitHub processes the visit under its [General Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

Issues, comments and attachments that you choose to post to the public repository are stored on GitHub and are visible to other people. You control which excerpts, screenshots and files you include in a report.

For questions about the app's handling of data, use the project's [issue tracker](https://github.com/kodai-utsunomiya-mdl/Local-TeX-Web-Editor/issues). The app's [source code](https://github.com/kodai-utsunomiya-mdl/Local-TeX-Web-Editor) is available in the same repository.
