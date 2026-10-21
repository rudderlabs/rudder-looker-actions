#!/bin/sh
# Fails when the Node version in .nvmrc, the Dockerfile FROM tag, the engines.node lower bound and devEngines disagree.
set -eu
cd "$(dirname "$0")/.."

want=$(tr -d '[:space:]' < .nvmrc)
[ -n "$want" ] || { echo ".nvmrc is empty" >&2; exit 1; }
from=$(sed -n 's/^FROM \(--platform=[^ ]* \)\{0,1\}node:\([0-9][0-9.]*\)[-@ ].*/\2/p' Dockerfile)
# engines.node is a range such as ">=24.22.1 <25", so yarn 1 accepts later 24.x patches. Its lower bound must match.
engines=$(node -p 'require("./package.json").engines.node' | sed -n 's/^>=\([0-9][0-9.]*\) <[0-9][0-9]*$/\1/p')
dev=$(node -p 'require("./package.json").devEngines.runtime.version')

status=0
[ -n "$from" ] || { echo "Dockerfile: no 'FROM node:<version>-' line" >&2; status=1; }
for pair in "Dockerfile FROM:$from" "engines.node lower bound:$engines" "devEngines.runtime.version:$dev"; do
  name=${pair%%:*}
  got=${pair#*:}
  [ -n "$(printf '%s' "$got" | tr -d '[:space:]')" ] || { echo "$name is empty, .nvmrc is $want" >&2; status=1; continue; }
  for v in $got; do
    [ "$v" = "$want" ] || { echo "$name is $v, .nvmrc is $want" >&2; status=1; }
  done
done
[ "$status" -eq 0 ] && echo "Node $want everywhere"
exit "$status"
