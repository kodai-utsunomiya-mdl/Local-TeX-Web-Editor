# Privacy policy for Local TeX Web Editor

Last updated: 21 November 2026

[日本語](privacy.ja.md)

Local TeX Web Editor edits documents stored on your computer and uses your local TeX installation to compile them. The app has no document-upload service, advertising, usage analytics or automatic crash-report uploads. It does not require an app account.

## Documents and local app data

The app reads and writes documents in the project folder you select. It also reads project files to show the file list, document outline, citation and reference suggestions, images and PDF previews. TeX compilation runs against files on your computer.

To support saving and resuming work, the app stores the following on your computer:

- Project and TeX installation paths, recent projects and compilation settings.
- Interface language, theme, font size and autosave preferences.
- Local drafts, including text that has not yet been saved to a project file.
- Compressed versions of earlier document text for edit history, with any version names you enter.
- Custom templates containing the project files you select, and their names and descriptions.
- Open documents, cursor positions and preview positions.
- Copies of compiled PDFs, SyncTeX data and information about the corresponding source files.
- When you use TeX setup or management, installation paths and records, package information and logs; setup also stores the downloaded TeX programs and packages.

These files are used to operate the editor and resume your previous session. The developer does not receive their contents through the app.

Settings, drafts, edit history, custom templates and preview copies are stored in the app's user-data folder. Edit history uses its `history` subfolder, and custom templates use its `templates` subfolder. On Windows, the Microsoft Store edition uses its package's `LocalState` folder; the ZIP edition uses `%APPDATA%\LocalTeXEditor`. On Mac, the default location is `~/Library/Application Support/LocalTeXEditor`. Compilation files and logs are also written within the project's `.local-tex-editor/build` folder or the output location selected by the project's TeX configuration.

TeX installed through the app uses `%LOCALAPPDATA%\LocalTeXEditor\tex` in the Windows ZIP edition, `LocalState\LocalTeXEditor\tex` in the Store package, or `~/Library/Application Support/LocalTeXEditor/tex` on Mac by default. Each installation uses its own folder. You can choose another destination in your user folder before starting setup.

On its first launch, the Store edition can copy settings, drafts and view preferences from an existing ZIP installation into its own user-data folder. The original files remain in the ZIP edition's folder. Project source files remain where you placed them.

The browser stores a copy of the appearance settings locally. While a draft is being written to the app's data folder, it may also store a temporary draft backup. That backup is removed after the app confirms the save. The local connection token is stored in the browser tab's session storage.

## Local communication

Launching the app starts a server on a loopback address such as `127.0.0.1` and opens the browser on the same computer. Editing, saving, compiling and previewing use this local connection. Access to the file and compilation APIs requires a token generated when the app starts.

The editor's scripts, fonts and PDF-viewing resources are included with the app. Editing and previewing do not require loading these resources from an external service.

## TeX setup and package downloads

TeX setup starts after you review the download source, destination and packages and choose **Download and install**. The app downloads the official TinyTeX archive from GitHub, checks its SHA-256, and obtains additional TeX packages from a CTAN mirror or the archive repository for that TeX Live year. Adding packages later also requires your confirmation. For an existing TeX Live, MacTeX or TinyTeX installation, package additions use the repository configured in that installation's `tlmgr`. If `tlmgr` reports that the installed year differs from CTAN's current year, the app retries with the official `tlnet-final` repository for the installed year; the installation's saved repository setting stays as configured. Custom, local and multiple-repository configurations use their own settings. These operations use an internet connection when downloading from an online repository; ordinary document editing continues to use the local connection described above.

Download services receive the network requests needed to serve files, including your IP address and the requested archive or package paths. The app sends no project documents, draft text, PDFs or bibliography contents to those services for setup or package management. GitHub handles its requests under its [General Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement); package repositories and mirrors have their own operators and privacy policies. The [TinyTeX release page](https://github.com/rstudio/tinytex-releases/releases/tag/v2026.11) and [CTAN mirror list](https://ctan.org/mirrors) identify the distribution services.

Package additions use the app's review and progress dialogs. You review the package names and selected installation before starting the download. Viewing installed packages and reviewing package removal use information in the local installation. If you open an official TeX management tool from the app, that tool uses its own repository and network settings.

Changes to a shared TeX installation can require operating system authorization. Windows and macOS present their own approval screens; the app does not ask for or receive your administrator password. In the Store edition, operations requiring administrator rights open the existing official TeX management tool or Windows app settings.

## External links and other software

When you choose an external link in a document or in the app's help, your browser opens the linked website. That website handles the resulting request under its own privacy policy. External images in Markdown are shown as links; the preview does not download them automatically. Images inside your project are read locally.

TeX engines, bibliography programs and commands specified by your project run as separate programs. Their access to files and the network depends on their own configuration.

If you place a project or app-data folder in a location managed by OneDrive, iCloud or another synchronization or backup service, that service can copy the files according to your settings.

If you install the app through Microsoft Store, Microsoft handles Store installation and updates under the [Microsoft Privacy Statement](https://www.microsoft.com/en-us/privacy/privacystatement). Your browser and operating system also have their own privacy settings. The app does not ask for or receive your Microsoft account credentials.

## Managing your data

You can edit, copy and delete project files using your normal file tools. The app's draft-recovery dialog offers an option to delete a saved draft. Settings lets you turn autosave on or off; local drafts are recorded independently of that setting.

Open **Editing tools → Document history → History settings** to change the history period and capacity, or stop recording new versions. The defaults are 30 days and 50 MiB across all projects, with at most 50 versions per file and 2000 versions overall. Documents larger than 2 MiB are omitted from history. Older versions are removed when these limits are reached, including named versions. Turning recording off leaves existing history subject to the same limits. To delete all stored history from the app, open **Settings → Reset settings and remembered information…** and select **Edit history**.

You choose which files to register as a custom template. Open **Editing tools → Manage templates → Edit the selected template** to change its name or description or delete its registration. Deleting a template leaves the original project files and projects previously created from it in their own folders.

Open **Settings → Information saved by the app → Reset settings and remembered information…** to choose what to reset. The dialog shows the app-data location and the file count and size for each category. **Settings and remembered actions** is selected initially. **Unsaved drafts**, **Edit history**, **Your templates**, and **PDF and SyncTeX cache** are initially unchecked. Choose the categories, check the confirmation, then click **Reset selected information**.

The settings choice restores appearance, editing preferences, recent projects, tabs and editing positions, and the selected TeX installation to their defaults. Other categories delete their corresponding saved copies. The reset applies to the data folder shown in the dialog. In the Store edition, the ZIP edition's original data from a previous migration remains at its own location. Your project files and installed TeX remain available, including TeX installed inside the app-data folder.

Before resetting, the app offers to save unsaved documents to their project files or leave them as drafts. If you selected drafts for deletion, it offers to save or discard those changes. After a successful reset, the page reloads. Other open tabs ask to reload when they next connect and offer downloads of their unsaved documents first. When drafts were deleted, older browser draft backups are also removed when a tab reconnects or reads its drafts.

Browser site-data controls can remove the saved appearance and any remaining browser draft backups. Project files can be managed in their original folders.

**Settings → Manage TeX…** shows the selected TeX installation and its packages. This includes TeX installed by the app and existing TeX Live, MacTeX and TinyTeX installations. Package removal shows the proposed changes before you confirm. Starting removal of an entire environment inside the app requires reviewing its actual location and contents, acknowledging the effect on other applications, and entering its folder name. The confirmation explains whether the action deletes app-managed files, runs the official Windows uninstaller, or moves the selected folder to Trash or Recycle Bin. For a shared installation in the Store edition, opening Windows app settings leaves the removal decision to Windows; opening the settings screen does not start deletion or require entering the folder name in the app. TinyTeX removal also removes path registrations that point to that installation. An official uninstaller can leave settings or other files, which the app reports. Project documents in their own folders remain available.

## Support and the project website

The project website, downloads and issue tracker are hosted on GitHub. If you open these pages, GitHub processes the visit under its [General Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

Issues, comments and attachments that you choose to post to the public repository are stored on GitHub and are visible to other people. You control which excerpts, screenshots and files you include in a report.

For questions about the app's handling of data, use the project's [issue tracker](https://github.com/kodai-utsunomiya-mdl/Local-TeX-Web-Editor/issues). The app's [source code](https://github.com/kodai-utsunomiya-mdl/Local-TeX-Web-Editor) is available in the same repository.
