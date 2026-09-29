import * as chai from "chai"
import * as express from "express"
import * as http from "http"
import * as sinon from "sinon"

import "../src/actions/index"
import * as apiKey from "../src/server/api_key"
import Server from "../src/server/server"

interface TestResponse {
  status: number
  body: any
}

// Drives the app over a real loopback socket. chai-http cannot be used here: the
// pinned git version is ESM-only and cannot be require()d under ts-node, which is
// why the repo's HTTP-level server tests are disabled.
async function send(
  app: express.Application,
  opts: {method: string, path: string, headers?: {[key: string]: string}, body?: string},
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const address = server.address()
      let port = 0
      if (address !== null && typeof address !== "string") {
        port = address.port
      }
      const req = http.request(
        {host: "127.0.0.1", port, method: opts.method, path: opts.path,
         headers: opts.headers === undefined ? {} : opts.headers},
        (res) => {
          let data = ""
          res.on("data", (chunk) => { data += chunk })
          res.on("end", () => {
            server.close()
            let body: any
            try {
              body = JSON.parse(data)
            } catch (_e) {
              body = undefined
            }
            resolve({status: res.statusCode === undefined ? 0 : res.statusCode, body})
          })
        },
      )
      req.on("error", (e) => { server.close(); reject(e) })
      if (opts.body) {
        req.write(opts.body)
      }
      req.end()
    })
  })
}

describe("action hub request security", () => {

  const previousSecret = process.env.ACTION_HUB_SECRET

  before(() => {
    // digest() dereferences ACTION_HUB_SECRET; boot guarantees it is set in prod.
    process.env.ACTION_HUB_SECRET = "test-secret"
  })

  after(() => {
    process.env.ACTION_HUB_SECRET = previousSecret
  })

  it("rejects an unauthenticated POST before parsing its body (SEC-515)", async () => {
    // Body is invalid JSON. With auth running before the body parser, the request
    // is rejected with 403 and the parser never runs. If the parser ran first (the
    // old app-wide mount) this invalid body would produce a 400 parse error.
    const res = await send(new Server().app, {
      method: "POST",
      path: "/",
      headers: {"content-type": "application/json"},
      body: "{ this is not valid json",
    })
    chai.expect(res.status).to.equal(403)
    chai.expect(res.body.error).to.equal("Invalid 'Authorization' header.")
  })

  it("rejects a malformed token without crashing (RUD-2680 Finding A)", async () => {
    // token="a/b" yields a 1-byte digest; before the length guard this threw a
    // RangeError from timingSafeEqual and killed the process. It must 403.
    const res = await send(new Server().app, {
      method: "POST",
      path: "/",
      headers: {authorization: 'Token token="a/b"'},
    })
    chai.expect(res.status).to.equal(403)
    chai.expect(res.body.error).to.equal("Invalid 'Authorization' header.")
  })

  it("does not crash on an OAuth GET for an unknown action (RUD-2680 Finding B)", async () => {
    // Previously the thrown value escaped as an unhandled rejection and killed the
    // process. It must now become an HTTP error response instead.
    const res = await send(new Server().app, {
      method: "GET",
      path: "/actions/does-not-exist/oauth",
    })
    chai.expect(res.status).to.be.within(400, 499)
  })

  it("still serves an authenticated POST to the root url", async () => {
    const stub = sinon.stub(apiKey, "validate").callsFake((k: string) => k === "foo")
    try {
      const res = await send(new Server().app, {
        method: "POST",
        path: "/",
        headers: {authorization: 'Token token="foo"'},
      })
      chai.expect(res.status).to.equal(200)
      chai.expect(res.body.integrations.length).to.be.greaterThan(0)
    } finally {
      stub.restore()
    }
  })

})
