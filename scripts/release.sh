#!/usr/bin/env bash
# Release the CLI FROM THIS MACHINE (Bruno's ruling, 2026-09-05: no GitHub Action).
#
# Builds the five single-file binaries with Bun, writes one SHA256SUMS per target in the plain
# `<hex>  <name>` form both installers parse, and uploads everything to the `sponsoredtokens-cli` R2
# bucket with the wrangler login already on this computer. `install.sh` and `install.ps1` download
# from `https://sponsoredtokens.com/cli/<target>/…`, which the API worker serves from that bucket
# (worker/src/routes/sponsored-cli-assets.ts).
#
#   pnpm release            build, checksum, upload
#   pnpm release --dry-run  build and checksum only
#   pnpm publish:npm        the npm package, separately (needs `npm login` once)
#
# Needs: bun (`brew install oven-sh/bun/bun`), node 20+, wrangler (via npx).
set -euo pipefail
cd "$(dirname "$0")/.."

DRY_RUN=0
for arg in "$@"; do [ "$arg" = "--dry-run" ] && DRY_RUN=1; done

command -v bun >/dev/null || { echo "bun is not installed — run: brew install oven-sh/bun/bun" >&2; exit 1; }

VERSION="$(node -p "require('./package.json').version")"
echo "sponsoredtokens $VERSION"

npm run --silent typecheck
npm test --silent
npm run --silent build

rm -rf out
for target in darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64; do
  if [ "$target" = "windows-x64" ]; then out="out/$target/sponsoredtokens.exe"; else out="out/$target/sponsoredtokens"; fi
  echo "building $target"
  bun build --compile --minify --target="bun-$target" src/cli.ts --outfile "$out" >/dev/null
  ( cd "out/$target" && shasum -a 256 ./* | sed 's|\./||' > SHA256SUMS && cat SHA256SUMS )
done

if [ "$DRY_RUN" = 1 ]; then echo "dry run — nothing uploaded"; exit 0; fi

for dir in out/*/; do
  target="$(basename "$dir")"
  for file in "$dir"*; do
    name="$(basename "$file")"
    echo "uploading $target/$name"
    npx --yes wrangler r2 object put "sponsoredtokens-cli/$target/$name" --file="$file" --remote --content-type=application/octet-stream >/dev/null
  done
done
echo "published $VERSION to R2 — try: curl -fsSL https://sponsoredtokens.com/cli/install.sh | bash"
