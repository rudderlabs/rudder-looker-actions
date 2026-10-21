#!/bin/sh
# Smoke test for a built image. It fails closed:
# - the image must run the Node version in .nvmrc;
# - both eMudhra test hosts must fail with a certificate-chain error;
# - the control host must complete a TLS handshake, so a missing CA bundle cannot pass as a rejection.
# Any other result fails, including an HTTP answer from a test host and every DNS, network or other TLS error.
# Usage: scripts/image-smoke.sh <image>
set -eu
image=${1:?usage: $0 <image>}
want=$(tr -d '[:space:]' < "$(dirname "$0")/../.nvmrc")

docker run --rm -e WANT_NODE="v$want" "$image" node -e '
const https = require("https");
const certErrors = new Set(["CERT_REVOKED", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_UNTRUSTED", "SELF_SIGNED_CERT_IN_CHAIN"]);
const checks = [
  ["dv-g3b-emudhra.we-have-a-problem.com", false],
  ["dv-g3b-aaa-emudhra.we-have-a-problem.com", false],
  ["api.stripe.com", true],
];
const versionOk = process.version === process.env.WANT_NODE;
console.log(`node ${process.version} openssl ${process.versions.openssl} (.nvmrc ${process.env.WANT_NODE}: ${versionOk ? "OK" : "FAIL"})`);
const probe = ([host, trusted]) => new Promise((resolve) => {
  const req = https.get({ host, path: "/", timeout: 15000, headers: { "user-agent": "image-smoke" } }, (res) => {
    res.resume();
    console.log(`${host}: HTTP ${res.statusCode} (${trusted ? "OK" : "FAIL: the image trusts the chain"})`);
    resolve(trusted);
  });
  req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
  req.on("error", (e) => {
    const code = e.code || (e.cause && e.cause.code) || String(e);
    const ok = !trusted && certErrors.has(code);
    console.log(`${host}: ${code} (${ok ? "SAFE" : "FAIL"})`);
    resolve(ok);
  });
});
Promise.all(checks.map(probe)).then((ok) => process.exit(versionOk && ok.every(Boolean) ? 0 : 1));
'
