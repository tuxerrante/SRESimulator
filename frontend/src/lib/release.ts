export const APP_VERSION = "v0.5.0";

const GITHUB_RELEASES_URL = "https://github.com/tuxerrante/SRESimulator/releases";

export function getReleaseUrl(version: string): string {
  return `${GITHUB_RELEASES_URL}/tag/${encodeURIComponent(version)}`;
}

export const APP_RELEASE_URL = getReleaseUrl(APP_VERSION);
