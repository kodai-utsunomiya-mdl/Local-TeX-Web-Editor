# Microsoft Store distribution

Local TeX Web Editor is available for free in [Microsoft Store](https://apps.microsoft.com/detail/9P6QF32N19HG) (Store ID: `9P6QF32N19HG`). The Windows application is packaged as MSIX for Store distribution. It opens the browser editor and uses either an existing TeX installation or TinyTeX installed from the app after the user confirms setup. Store installation requires Windows 10 version 2004 (build 19041) or later, or Windows 11, on an x64 PC.

## Product identity

For initial developer registration, start the free individual registration flow at [storedeveloper.microsoft.com](https://storedeveloper.microsoft.com/). The account owner completes Microsoft's identity verification and reserves the app name **Local TeX Web Editor** in Partner Center. [Microsoft's registration instructions](https://learn.microsoft.com/en-us/windows/apps/publish/whats-new-individual-developer)

The published app uses the identity configured in [store-identity.json](../packaging/windows/store-identity.json). When preparing a new product, copy these values from its **Product identity** page in Partner Center:

| Partner Center value | JSON key |
| --- | --- |
| Package/Identity/Name | `identityName` |
| Package/Identity/Publisher | `publisher` |
| Package/Properties/PublisherDisplayName | `publisherDisplayName` |

Use the complete Publisher value, including `CN=`. These are public product identifiers. The account password, identity documents and account access tokens belong in the Microsoft account flow.

The build also accepts `MSIX_IDENTITY_NAME`, `MSIX_PUBLISHER` and `MSIX_PUBLISHER_DISPLAY_NAME` as environment variables. An environment variable takes precedence over the corresponding JSON field. All three values are required for a submission package.

## Build and check the package

The **Build Microsoft Store package** workflow builds the editor, creates a package with a test identity, installs a signed copy on a disposable Windows runner, and exercises the installed application. It checks the process's Windows package identity, project saving, TeX compilation, bibliography, SyncTeX, PDF and Markdown previews, the folder dialog and app exit. It also captures the Store screenshots from the installed app.

The workflow runs the Windows App Certification Kit (WACK) when it is installed on the runner and writes its result to `certification.json`. WACK is deprecated and provides optional checks before submission; `not-run` means those checks were skipped. Microsoft performs the official certification automatically when the package is submitted to Partner Center. [Microsoft's package validation guide](https://learn.microsoft.com/en-us/windows/msix/package/packaging-uwp-apps#validate-your-app-package-locally)

WACK's XML report and `certification.json` record the result returned by the kit. The DPI test can report `WARNING` with “Failed to process the binary”. The workflow records that warning and requires independent checks of the installed executable's manifest and SHA-256, together with the native folder dialog's DPI context. A failing check, an unknown result or an incomplete report stops the workflow.

When all three Product identity values are configured and the installation tests pass, the workflow creates these artifacts:

- `microsoft-store-submission`: the unsigned `.msix` for upload and its version, identity and SHA-256 record.
- `microsoft-store-listing`: the app icon, screenshots of TeX/PDF, Markdown, TeX package management and the five setup stages, English/Japanese listing text, privacy policy text and `store-review-sample.zip` containing the reviewer's TeX and Markdown sample files.
- `microsoft-store-test-results`: test output, screenshots and the certification-kit result.

Listing files and test results are also collected when a later check fails. The workflow copies the installed-app screenshots after package creation, including when the final package uses the Product identity. If those captures are unavailable, the listing artifact contains the repository's screenshots; `screenshot-source.json` and the job summary identify their source. Use images from a successful installed-package run for submission. The `editor-tex-management.png` capture shows the selected installation and installed packages filtered by `math` after the real setup completes.

The package submitted to Store is unsigned. Microsoft signs it for Store distribution. The signing material used for the installation test exists only on the temporary runner. [Microsoft's MSIX preparation guide](https://learn.microsoft.com/en-us/windows/apps/publish/store-readiness-checklist)

For a local build, use Windows with the Windows SDK, Node.js and Go installed. From the repository root:

```powershell
npm ci
npm run build
npm run build:windows-resources
npx playwright install chromium
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
go build -trimpath -ldflags="-s -w -H=windowsgui -X main.version=$version" `
  -o bin/local-tex-web-editor.exe ./cmd/local-tex-editor
npm run build:msix
```

The output is `dist/local-tex-web-editor-<version>-windows-x64.msix`. `MakePri` creates the icon resource index and `MakeAppx` validates and packs the files. A test build uses `node scripts/build-msix.mjs --test-identity`; its identity is reserved for the CI test and cannot be submitted as this Store product.

## Version numbers

The app keeps its normal three-part version. The MSIX version adds one to the first part and uses `0` for the fourth part. For example, app `0.1.13` produces package `1.1.13.0`, and app `1.0.0` produces package `2.0.0.0`.

Microsoft requires a nonzero first part and reserves the last part for Store use. This rule gives each subsequent app version a larger Store package version. [Package version requirements](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/package-version-numbering)

## Installation and data

Windows creates the Start menu entry and manages Store updates. The Store edition does not create an extra copy of the executable for desktop shortcuts. It stores its settings, drafts, edit history, and custom templates at:

```text
%LOCALAPPDATA%\Packages\KodaiUtsunomiya.LocalTeXWebEditor_q701qfpryzpqc\LocalState\LocalTeXEditor
```

On the first launch, existing ZIP-edition settings, drafts and view preferences are copied from `%APPDATA%\LocalTeXEditor` when those files are available and valid. The original data remains in place. Store updates use the same package family and user-data folder. Project documents stay in their existing folders.

The package uses `runFullTrust` so the editor can read and save the chosen project, run `latexmk`, TeX engines, bibliography tools and SyncTeX, open its loopback page in the browser, and carry out the TeX setup and package operations confirmed by the user. It runs with the user's normal Windows permissions. The listing's reviewer notes explain these operations.

### TeX setup and management

From version 0.1.12, **Home → Set up TeX…** and **Settings → Set up TeX…** offer installation inside the app. The confirmation shows the official TinyTeX v2026.11 download, destination and package selection. **Download and install** starts the operation. The app checks the downloaded archive against its expected SHA-256 before extracting it. Additional packages come from CTAN or the TeX Live archive for the installed year.

The Store edition creates an installation folder under `LocalState\LocalTeXEditor\tex` by default. It sets the TeX search path for its child processes and runs with normal user permissions. Successful setup selects the environment automatically. Existing TeX installations remain selectable in Settings; failed or stopped setup leaves the previous selection available.

The standard packages provide pdfLaTeX, upLaTeX, XeLaTeX, LuaLaTeX, `latexmk`, SyncTeX, Japanese classes and Harano Aji fonts, bibliography and index tools, and common mathematics and drawing packages. Allow about 250 MB of downloads, about 1 GB installed, and about 2 GB of free space during setup on Windows. These are estimates that can change as packages are updated.

**Settings → Manage TeX…** lists packages in the selected installation, including TeX created by the app and existing TeX Live or TinyTeX. User-writable installations support package additions and removal after review. Removal shows the proposed changes and dependency information before execution. For a shared installation that needs administrator permission, the Store edition opens its existing official `tlshell` GUI; the GUI owns the approval and package operation. The app itself continues to run with normal user permissions.

Starting removal of an entire environment inside the app has its own confirmation with the actual folder, contents, shared use and exact folder-name entry. The app checks its recorded installation files before removing app-installed TeX. Existing user-owned TinyTeX can be moved to Recycle Bin; existing TeX Live uses its verified official uninstaller when it can run with normal user permissions. For an installation requiring administrator rights, **Uninstall in Windows Settings…** opens the operating system's app settings without a folder-name entry in the app. The user selects removal in Windows; opening that screen alone does not start deletion or report the environment as removed. An official uninstaller can leave configuration files; the app checks that the tools and package database were removed and logs the remaining folder and files. Project documents in their own folders remain available.

The listing opens with the TeX dependency and the choice of in-app setup or an existing installation. The privacy policy describes the user-initiated downloads and their destinations. [Microsoft Store policies](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies) address consent for components acquired after installation in 10.1.5, software dependencies in 10.2.4, and removal in 10.2.7. Use the reviewer notes to demonstrate setup, package management and removal alongside compilation. Store updates continue to manage the app package.

## Submit the app

Use [the prepared listing and reviewer notes](microsoft-store-listing.md) for the English and Japanese pages. They include a simple TeX/Markdown sample, requirements, feature descriptions, support URLs and the reason for `runFullTrust`.

The reviewer notes link to [the published sample ZIP](https://kodai-utsunomiya-mdl.github.io/Local-TeX-Web-Editor/downloads/store-review-sample.zip). Check that it downloads and contains the expected `main.tex` and `notes.md` before submitting. If the sample files have changed, update that download with `store-review-sample.zip` from the listing artifact.

In Partner Center, set the price to Free, complete the product properties and age-rating questionnaire, upload the MSIX and listing images, and review the completed submission before sending it to Microsoft. The privacy-policy URLs are:

- [English](https://kodai-utsunomiya-mdl.github.io/Local-TeX-Web-Editor/privacy/)
- [日本語](https://kodai-utsunomiya-mdl.github.io/Local-TeX-Web-Editor/ja/privacy/)

The public download page is [Local TeX Web Editor in Microsoft Store](https://apps.microsoft.com/detail/9P6QF32N19HG). Use this product URL in the website and README when directing users to the Store edition. [Microsoft's submission instructions](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/create-app-submission)

## Reset settings and remembered information

Version 0.1.13 adds **Settings → Reset settings and remembered information…**. The dialog shows the data location, file counts and sizes. Settings are selected initially; drafts, history, custom templates and PDF/SyncTeX caches are optional. Confirming the selection resets those items and reloads the app. Project files and installed TeX remain available.

Use a disposable test profile to review the reset. Change the appearance, open a project, make an unsaved edit with autosave off, then reset settings while leaving drafts unchecked. The app returns to Home with default preferences, and the draft is available when the project is reopened. A second tab with an unsaved document offers a download before reloading. Selecting drafts for deletion also clears their earlier browser backups.
