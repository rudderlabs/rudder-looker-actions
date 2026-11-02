import * as chai from "chai"
import * as express from "express"
import * as http from "http"
import * as sinon from "sinon"

import "../src/actions/index"
import * as sources from "../src/hub/sources"
import Server, {MAX_CACHED_ACTION_LISTS, POST_BODY_LIMIT_BYTES} from "../src/server/server"

// A valid JSON object of exactly `bytes` bytes: {"pad":"aaa…"}.
function jsonBodyOfSize(bytes: number): string {
  const prefix = '{"pad":"'
  const suffix = '"}'
  return prefix + "a".repeat(bytes - prefix.length - suffix.length) + suffix
}

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

  it("lists the actions on a POST without an Authorization header (SEC-480)", async () => {
    const res = await send(new Server().app, {
      method: "POST",
      path: "/",
    })
    chai.expect(res.status).to.equal(200)
    chai.expect(res.body.integrations.length).to.be.greaterThan(0)
  })

  it("ignores the token header Looker sends when one is configured", async () => {
    // A hub registered with a token keeps sending it. The value, even a malformed
    // one, must not change the response.
    const res = await send(new Server().app, {
      method: "POST",
      path: "/",
      headers: {authorization: 'Token token="a/b"'},
    })
    chai.expect(res.status).to.equal(200)
    chai.expect(res.body.integrations.length).to.be.greaterThan(0)
  })

  it("answers an invalid JSON body with a 400 instead of crashing", async () => {
    const res = await send(new Server().app, {
      method: "POST",
      path: "/",
      headers: {"content-type": "application/json"},
      body: "{ this is not valid json",
    })
    chai.expect(res.status).to.equal(400)
    chai.expect(res.body.success).to.equal(false)
  })

  it("rejects a POST body over the limit before it reaches the handler (SEC-515)", async () => {
    const allActions = sinon.stub(sources, "allActions")
    try {
      const body = jsonBodyOfSize(POST_BODY_LIMIT_BYTES + 1)
      const res = await send(new Server().app, {
        method: "POST",
        path: "/",
        headers: {"content-type": "application/json", "content-length": String(Buffer.byteLength(body))},
        body,
      })
      chai.expect(res.status).to.equal(413)
      chai.expect(res.body.success).to.equal(false)
      chai.expect(allActions.called).to.equal(false)
    } finally {
      allActions.restore()
    }
  })

  it("accepts a POST body at the limit", async () => {
    const body = jsonBodyOfSize(POST_BODY_LIMIT_BYTES)
    const res = await send(new Server().app, {
      method: "POST",
      path: "/",
      headers: {"content-type": "application/json", "content-length": String(Buffer.byteLength(body))},
      body,
    })
    chai.expect(res.status).to.equal(200)
    chai.expect(res.body.integrations.length).to.be.greaterThan(0)
  })

  it("caps the action-list cache so new User-Agent versions cannot grow it", async () => {
    const app = new Server().app
    const versionsSent = MAX_CACHED_ACTION_LISTS + 5
    const userAgentFor = (patch: number) => ({"user-agent": `LookerOutgoingWebhook/7.0.${patch}`})
    const allActions = sinon.spy(sources, "allActions")
    try {
      for (let patch = 0; patch < versionsSent; patch++) {
        const listed = await send(app, {method: "POST", path: "/", headers: userAgentFor(patch)})
        chai.expect(listed.status).to.equal(200)
      }
      chai.expect(allActions.callCount).to.equal(versionsSent)

      // A version cached before the cap is served without rebuilding the list.
      await send(app, {method: "POST", path: "/", headers: userAgentFor(0)})
      chai.expect(allActions.callCount).to.equal(versionsSent)

      // A version past the cap was never stored, so it is rebuilt on every request.
      const res = await send(app, {method: "POST", path: "/", headers: userAgentFor(versionsSent - 1)})
      chai.expect(res.status).to.equal(200)
      chai.expect(res.body.integrations.length).to.be.greaterThan(0)
      chai.expect(allActions.callCount).to.equal(versionsSent + 1)
    } finally {
      allActions.restore()
    }
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

})
