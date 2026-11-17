const browserPlatform = typeof navigator === 'undefined' ? '' : navigator.userAgentData?.platform || navigator.platform || '';

export const isMac = /mac/i.test(browserPlatform);
export const shortcutModifier = isMac ? 'Cmd' : 'Ctrl';
