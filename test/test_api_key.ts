import * as chai from "chai"

import * as apiKey from "../src/server/api_key"

describe("api_key.validate", () => {

  const previousSecret = process.env.ACTION_HUB_SECRET

  before(() => {
    process.env.ACTION_HUB_SECRET = "test-secret"
  })

  after(() => {
    process.env.ACTION_HUB_SECRET = previousSecret
  })

  it("accepts a token minted from the current secret", () => {
    const key = apiKey.fromNonce("nonce-1")
    chai.expect(apiKey.validate(key)).to.equal(true)
  })

  it("rejects a wrong-length digest without throwing (RUD-2680 Finding A)", () => {
    // "b" is 1 byte against the 128-hex-char HMAC. Before the length guard this
    // reached crypto.timingSafeEqual and threw a RangeError that crashed the
    // process. It must now return false instead.
    chai.expect(() => apiKey.validate("a/b")).to.not.throw()
    chai.expect(apiKey.validate("a/b")).to.equal(false)
  })

  it("rejects a token with no digest separator", () => {
    chai.expect(apiKey.validate("no-separator")).to.equal(false)
  })

  it("rejects an empty key", () => {
    chai.expect(apiKey.validate("")).to.equal(false)
  })

  it("rejects a correct-length but wrong digest", () => {
    const wrong = `nonce-1/${"0".repeat(128)}`
    chai.expect(apiKey.validate(wrong)).to.equal(false)
  })

})
