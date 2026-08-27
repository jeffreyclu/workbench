/** Version snapshots live under the artifact's stable URL, so `…/<id>/v2/`. */
export function versionUrl(artifactUrl: string, version: number): string {
  return `${artifactUrl.replace(/\/?$/, '/')}v${version}/`;
}
