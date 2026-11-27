# Publishing application updates

The release workflow creates `app-update.json`, `app-update.json.sig`, and `appcast.xml` alongside the tested Windows and macOS ZIP archives. The Windows updater verifies the manifest and archive hash. Sparkle verifies the signed appcast and the macOS archive.

## Signing key

The app embeds the base64 Ed25519 public key in `internal/updater/public-key.txt`. Configure the corresponding base64 32-byte seed as the repository Actions secret `APP_UPDATE_PRIVATE_KEY`. The release workflow reads this secret only in its publication job on `main`. The signing script refuses a missing key or a key that does not match the embedded public key.

Keep the private seed in a secure backup. Replacing the embedded public key requires an update that existing installations can verify with their existing key.

## Release

1. Update `package.json` and `package-lock.json`, and add `release-notes/v<version>.md`.
2. Run the Windows and macOS checks. The branch workflow builds the app without access to the signing seed.
3. Merge the tested changes. The release job signs the update information and macOS archive, then publishes the archives and update information together.
4. Microsoft Store publication follows the Store submission workflow. Store installations discover availability through Windows after publication.

Automatic checks start after the local editor is served. All connected editors must finish their update preparation before installation. Download failures leave the current editor available. A Windows update that fails to start is recorded so that the app can offer a manual retry instead of repeatedly restarting into that version.
