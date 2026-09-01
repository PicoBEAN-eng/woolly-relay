#!/usr/bin/env bash
# Publish a new plugin release to GitHub for BRAT distribution.
# Usage: ./release.sh <version>   (e.g. ./release.sh 0.7.13)
# Expects a fresh build in ~/projects/Relay (main.js/manifest.json/styles.css),
# built with `npm run release` under the env in build.env — WITHOUT those vars
# esbuild bakes upstream System 3 URLs and the plugin talks to the wrong
# backend entirely (releases 0.2.4/0.2.5 shipped that way; every device that
# updated silently lost the hub). The guard below refuses such a build.
set -euo pipefail
V="${1:?usage: release.sh <version>}"
DIR="$(cd "$(dirname "$0")" && pwd)"
T=$(cat ~/.config/relay-server/github-token)
REPO="PicoBEAN-eng/woolly-relay"

grep -q "woolly.08d5743r4qj3w.com" ~/projects/Relay/main.js ||
  { echo "REFUSED: main.js has no woolly hub URL — rebuild with build.env (see that file)"; exit 1; }
grep -qE "api\.system3\.md|auth\.system3\.md" ~/projects/Relay/main.js &&
  { echo "REFUSED: main.js points at upstream System 3 — rebuild with build.env"; exit 1; }

cp ~/projects/Relay/{main.js,styles.css} "$DIR/"
# stamp the version into the manifest
sed -E "s/\"version\": \"[^\"]+\"/\"version\": \"$V\"/" ~/projects/Relay/manifest.json > "$DIR/manifest.json"

cd "$DIR"
git add -A && git commit -m "release $V" || true
git push "https://x-access-token:$T@github.com/$REPO.git" main

RID=$(curl -sf -X POST "https://api.github.com/repos/$REPO/releases" \
  -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d "{\"tag_name\":\"$V\",\"name\":\"$V\",\"target_commitish\":\"main\"}" | grep -o '"id": [0-9]*' | head -1 | grep -o '[0-9]*')
for f in main.js manifest.json styles.css; do
  curl -sf -X POST "https://uploads.github.com/repos/$REPO/releases/$RID/assets?name=$f" \
    -H "Authorization: Bearer $T" -H "Content-Type: application/octet-stream" \
    --data-binary @"$f" > /dev/null && echo "uploaded $f"
done
echo "release $V published"
