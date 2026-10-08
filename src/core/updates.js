// Checks GitHub for a newer release of the app.

export const RELEASES_API = 'https://api.github.com/repos/nbantle/roku-tv-manager/releases/latest';

/** Compare "1.2.0" style versions (a leading "v" is ignored). Returns -1, 0 or 1. */
export function compareVersions(a, b) {
  const parts = (v) => String(v).replace(/^v/i, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** {version, url} of a newer release, or null. fetchJson(url) must return the parsed JSON. */
export async function checkForUpdate(current, fetchJson) {
  const r = await fetchJson(RELEASES_API);
  if (!r?.tag_name || r.draft || r.prerelease) return null;
  if (compareVersions(r.tag_name, current) <= 0) return null;
  return { version: r.tag_name.replace(/^v/i, ''), url: r.html_url };
}
