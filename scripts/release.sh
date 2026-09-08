#!/usr/bin/env bash
# Release the CLI FROM THIS MACHINE (Bruno's ruling, 2026-09-05: no GitHub Action).
#
# Builds the five single-file binaries with Bun, writes one SHA256SUMS per target in the plain
# `<hex>  <name>` form both installers parse, and uploads everything to the `sponsoredtokens-cli` R2
# bucket with the wrangler login already on this computer. `install.sh` and `install.ps1` download
# from `https://sponsoredtokens.com/cli/<target>/…`, which the API worker serves from that bucket
# (worker/src/routes/sponsored-cli-assets.ts).
#
#   pnpm release                     build, checksum, upload
#   pnpm release --dry-run           build and checksum only
#   pnpm release --note "one line"   the same, with a line for the update notice to carry
#   pnpm publish:npm                 the npm package, separately (needs `npm login` once)
#
# ── THE LATEST FILE ─────────────────────────────────────────────────────────────────────────────
#
# `latest.json` sits at the bucket root beside the per-target folders and is what an installed CLI
# polls (`src/update-check.ts`, served at `/cli/latest.json`). It is uploaded LAST, after every
# binary and every checksum, because the alternative is a window in which a poller is told 0.4.1 is
# out and the download for its own platform 404s. Nothing else in the layout moves: the binaries are
# still one `sponsoredtokens` per target and their `SHA256SUMS`, and the short name `stok` is made
# by the installer on the machine it installs to.
#
# Needs: bun (`brew install oven-sh/bun/bun`), node 20+, wrangler (via npx).
set -euo pipefail
cd "$(dirname "$0")/.."

DRY_RUN=0
NOTE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --note) shift; NOTE="${1:-}" ;;
    --note=*) NOTE="${1#--note=}" ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

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

# The note defaults to the package description, so a release that forgets `--note` still says
# something true rather than an empty string.
if [ -z "$NOTE" ]; then NOTE="$(node -p "require('./package.json').description")"; fi

# Built with node rather than a heredoc so the note is JSON-escaped by something that knows how:
# a quote or a backslash in a release line must not be able to write a broken object into the bucket.
node -e '
  const [version, note] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({
    version,
    publishedAt: new Date().toISOString(),
    note,
    install: {
      sh: "curl -fsSL https://sponsoredtokens.com/cli/install.sh | bash",
      ps1: "irm https://sponsoredtokens.com/cli/install.ps1 | iex",
      npm: "npm i -g sponsoredtokens",
    },
  }, null, 2) + "\n");
' "$VERSION" "$NOTE" > out/latest.json
cat out/latest.json

if [ "$DRY_RUN" = 1 ]; then echo "dry run — nothing uploaded"; exit 0; fi

for dir in out/*/; do
  target="$(basename "$dir")"
  for file in "$dir"*; do
    name="$(basename "$file")"
    echo "uploading $target/$name"
    npx --yes wrangler r2 object put "sponsoredtokens-cli/$target/$name" --file="$file" --remote --content-type=application/octet-stream >/dev/null
  done
done

# Last, and only once every download above is in place. Until this line runs, an installed CLI still
# sees the previous release and says nothing.
echo "uploading latest.json"
npx --yes wrangler r2 object put "sponsoredtokens-cli/latest.json" --file=out/latest.json --remote --content-type=application/json >/dev/null

echo "published $VERSION to R2 — try: curl -fsSL https://sponsoredtokens.com/cli/install.sh | bash"
