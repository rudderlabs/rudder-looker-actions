#!/bin/sh
# Fails when the Node version in .nvmrc, a Dockerfile FROM node tag, engines.node or devEngines disagree.
# engines.node must be ">=<.nvmrc> <<major+1>", so yarn 1 accepts later patches of the same major.
set -eu
cd "$(dirname "$0")/.."

# One line, with an optional trailing newline or CRLF and nothing else.
want=$(tr -d '\r' < .nvmrc)
printf '%s' "$want" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo ".nvmrc must hold one exact version such as 24.22.1, got '$want'" >&2; exit 1; }
major=${want%%.*}
range=">=$want <$((major + 1))"

status=0
fail() { echo "$1" >&2; status=1; }

# Every FROM line that names a node image, in any case and with any separator.
# A line continuation in a FROM instruction is not supported and fails.
grep -Eiq '^[[:space:]]*FROM[[:space:]].*\\$' Dockerfile && fail "Dockerfile: a FROM line continues on the next line"
grep -Ei '^[[:space:]]*FROM[[:space:]]' Dockerfile | grep -Eiq '(^|[[:space:]/])node([[:space:]@]|$)' && fail "Dockerfile: a FROM node line has no version tag"
froms=$(grep -Ei '^[[:space:]]*FROM[[:space:]]' Dockerfile | grep -Eio '(^|[[:space:]/])node:[^[:space:]]*' | sed -E 's#^[[:space:]/]*##; s#^[Nn][Oo][Dd][Ee]:##; s#[-@].*##') || true
[ -n "$froms" ] || fail "Dockerfile: no 'FROM node:<version>' line"
for v in $froms; do
  [ "$v" = "$want" ] || fail "Dockerfile FROM node:$v, .nvmrc is $want"
done

engines=$(node -p 'require("./package.json").engines?.node ?? ""')
[ "$engines" = "$range" ] || fail "engines.node is '$engines', want '$range'"
dev=$(node -p 'require("./package.json").devEngines?.runtime?.version ?? ""')
[ "$dev" = "$want" ] || fail "devEngines.runtime.version is '$dev', .nvmrc is $want"

[ "$status" -eq 0 ] && echo "Node $want everywhere"
exit "$status"
