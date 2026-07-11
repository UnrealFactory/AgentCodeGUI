/* Shared, dependency-free constants. */

/**
 * Fallback app version shown in the branding subtitle until the real version loads.
 * The UI prefers the live value from `app.getVersion()` (package.json `version`, what
 * auto-update compares against) via `useAppVersion()` — this is just the pre-IPC
 * placeholder, so keep it roughly in sync with package.json to avoid a visible flash.
 */
export const APP_VERSION = '1.7.7'
