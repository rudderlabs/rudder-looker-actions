#!/bin/sh
# Fails when the Node version in .nvmrc, a Dockerfile FROM node tag, engines.node or devEngines disagree.
# engines.node must be ">=<.nvmrc> <<major+1>", so yarn 1 accepts later patches of the same major.
set -eu
cd "$(dirname "$0")/.."

# One line, with an optional trailing newline or CRLF and nothing else.
want=$(tr -d '\r' < .nvmrc)
bad_nvmrc() { echo ".nvmrc must hold one exact version such as 24.22.1, got '$want'" >&2; exit 1; }
case "$want" in ''|*[!0-9.]*|.*|*.|*..*|0[0-9]*|*.0[0-9]*) bad_nvmrc ;; esac
[ "$(printf '%s' "$want" | tr -cd . | wc -c)" -eq 2 ] || bad_nvmrc
major=${want%%.*}
range=">=$want <$((major + 1))"

status=0
fail() { echo "$1" >&2; status=1; }

# The image field of every FROM instruction: the first word after FROM that is not a --flag.
# A line continuation in a FROM instruction is not supported and fails.
[ -f Dockerfile ] || { echo "Dockerfile not found" >&2; exit 1; }
grep -Eiq '^[[:space:]]*FROM[[:space:]].*\\$' Dockerfile && fail "Dockerfile: a FROM line continues on the next line"
images=$(awk 'toupper($1) == "FROM" { for (i = 2; i <= NF; i++) if ($i !~ /^--/) { print $i; break } }' Dockerfile)
froms=""
for img in $images; do
  case "$img" in
    node|*/node|node@*|*/node@*) fail "Dockerfile: FROM $img has no version tag" ;;
    node:*|*/node:*) v=${img#*node:}; froms="$froms ${v%%[-@]*}" ;;
  esac
done
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
