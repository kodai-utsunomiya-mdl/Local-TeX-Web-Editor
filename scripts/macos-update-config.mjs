export const sparkleRelease = Object.freeze({
  version: '2.10.1',
  url: 'https://github.com/sparkle-project/Sparkle/releases/download/2.10.1/Sparkle-2.10.1.tar.xz',
  sha256: '1a856d2a9edb8e628de88121d7be04cf0e2167f8641650b78fca00b14244cf27',
});

export function macOSUpdateConfiguration(publicKey) {
  const encoded = String(publicKey || '').trim();
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== encoded) {
    throw new Error('The application update public key must be a base64-encoded 32-byte Ed25519 public key.');
  }
  return {
    SUFeedURL: 'https://github.com/kodai-utsunomiya-mdl/Local-TeX-Web-Editor/releases/latest/download/appcast.xml',
    SUPublicEDKey: encoded,
    SUEnableAutomaticChecks: true,
    SUAutomaticallyUpdate: true,
    SUScheduledCheckInterval: 86400,
    SUEnableSystemProfiling: false,
    SUVerifyUpdateBeforeExtraction: true,
    SURequireSignedFeed: true,
    SUShowReleaseNotes: false,
  };
}
