#!/usr/bin/env bash
# Push this package's own history to its public mirror, github.com/yumankind/sponsoredtokens-cli.
#
# The CLI is developed inside the monorepo, where its release script, its R2 upload and the tests
# that compare its copied constants against the site and the worker all live. The mirror is the
# public face of the same code: `git subtree split` rewrites the package's commits with the
# package directory as the root, deterministically (the same history produces the same commit
# ids), so every push is a fast-forward of the last one. Run by `release.sh` after the binaries
# are up, or by hand. `MIRROR_REMOTE` and `MIRROR_BRANCH` override the destination.
set -euo pipefail
cd "$(dirname "$0")/../../.."
PREFIX=packages/sponsoredtokens-cli
REMOTE="${MIRROR_REMOTE:-https://github.com/Yumankind/sponsoredtokens-cli.git}"
BRANCH="${MIRROR_BRANCH:-main}"
if [ -n "$(git status --porcelain -- "$PREFIX")" ]; then
  echo "mirror: $PREFIX has uncommitted changes; commit them first" >&2
  exit 1
fi
SPLIT="$(git subtree split --prefix="$PREFIX" HEAD 2>/dev/null)"
echo "mirror: $SPLIT -> $REMOTE $BRANCH"
git push "$REMOTE" "$SPLIT:refs/heads/$BRANCH"
