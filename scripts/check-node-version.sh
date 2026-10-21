#!/bin/sh
# Fails when the Node version in .nvmrc, the Dockerfile FROM tag, engines and devEngines disagree.
set -eu
cd "$(dirname "$0")/.."

want=$(tr -d '[:space:]' < .nvmrc)
from=$(sed -n 's/^FROM node:\([0-9][0-9.]*\)-.*/\1/p' Dockerfile)
engines=$(node -p 'require("./package.json").engines.node')
dev=$(node -p 'require("./package.json").devEngines.runtime.version')

status=0
[ -n "$from" ] || { echo "Dockerfile: no 'FROM node:<version>-' line" >&2; status=1; }
for pair in "Dockerfile FROM:$from" "engines.node:$engines" "devEngines.runtime.version:$dev"; do
  name=${pair%%:*}
  got=${pair#*:}
  for v in $got; do
    [ "$v" = "$want" ] || { echo "$name is $v, .nvmrc is $want" >&2; status=1; }
  done
done
[ "$status" -eq 0 ] && echo "Node $want everywhere"
exit "$status"
