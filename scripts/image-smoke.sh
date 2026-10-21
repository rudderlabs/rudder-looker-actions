#!/bin/sh
# Smoke test for a built image: prints the Node version and checks the trust store.
# Both eMudhra test hosts must fail with a certificate error. The control host must answer.
# A DNS or network error fails the test, so a missing network never passes as a rejection.
# Usage: scripts/image-smoke.sh <image>
set -eu
image=${1:?usage: $0 <image>}

docker run --rm "$image" node -e '
const https = require("https");
const certErrors = new Set(["CERT_REVOKED", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN", "CERT_UNTRUSTED"]);
const checks = [
  ["dv-g3b-emudhra.we-have-a-problem.com", false],
  ["dv-g3b-aaa-emudhra.we-have-a-problem.com", false],
  ["api.github.com", true],
];
console.log(`node ${process.version} openssl ${process.versions.openssl}`);
const probe = ([host, trusted]) => new Promise((resolve) => {
  const req = https.get({ host, path: "/", timeout: 15000, headers: { "user-agent": "image-smoke" } }, (res) => {
    res.resume();
    console.log(`${host}: HTTP ${res.statusCode} (${trusted ? "OK" : "EXPOSED"})`);
    resolve(trusted);
  });
  req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
  req.on("error", (e) => {
    const rejected = certErrors.has(e.code);
    console.log(`${host}: ${e.code} (${!trusted && rejected ? "SAFE" : "FAIL"})`);
    resolve(!trusted && rejected);
  });
});
Promise.all(checks.map(probe)).then((ok) => process.exit(ok.every(Boolean) ? 0 : 1));
'
