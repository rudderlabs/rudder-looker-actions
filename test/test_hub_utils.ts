import * as chai from "chai"
import * as sinon from "sinon"
import * as winston from "winston"

import { readPositiveInteger } from "../src/hub"
import { ExecuteProcessQueue, parseExecuteProcessTimeoutMs } from "../src/xpc/execute_process_queue"

const NAME = "TEST_SETTING"
const SETTING = { fallback: 100, maximum: 1000, minimum: 10, logPrefix: "[Test]" }
const ONE_HOUR_MS = 60 * 60 * 1000

describe("positive integer settings", () => {
  let warn: sinon.SinonStub

  beforeEach(() => {
    warn = sinon.stub(winston, "warn")
  })

  afterEach(() => {
    warn.restore()
  })

  describe("readPositiveInteger", () => {
    it("returns the fallback when the variable is unset or blank", () => {
      chai.expect(readPositiveInteger({}, NAME, SETTING)).to.equal(100)
      chai.expect(readPositiveInteger({ [NAME]: "  " }, NAME, SETTING)).to.equal(100)
      chai.expect(warn.called).to.equal(false)
    })

    it("returns a value within the range", () => {
      chai.expect(readPositiveInteger({ [NAME]: "500" }, NAME, SETTING)).to.equal(500)
      chai.expect(readPositiveInteger({ [NAME]: "1000" }, NAME, SETTING)).to.equal(1000)
      chai.expect(readPositiveInteger({ [NAME]: "10" }, NAME, SETTING)).to.equal(10)
      chai.expect(warn.called).to.equal(false)
    })

    for (const invalid of ["abc", "0", "-5", "1.5"]) {
      it(`warns and returns the fallback for "${invalid}"`, () => {
        chai.expect(readPositiveInteger({ [NAME]: invalid }, NAME, SETTING)).to.equal(100)
        chai.expect(warn.calledOnceWith(`[Test] ignoring invalid ${NAME}="${invalid}", using 100`)).to.equal(true)
      })
    }

    it("warns and clamps a value above the maximum", () => {
      chai.expect(readPositiveInteger({ [NAME]: "5000" }, NAME, SETTING)).to.equal(1000)
      chai.expect(warn.calledOnceWith(`[Test] ${NAME}=5000 is above the maximum 1000, using 1000`)).to.equal(true)
    })

    it("warns and clamps a value below the minimum", () => {
      chai.expect(readPositiveInteger({ [NAME]: "5" }, NAME, SETTING)).to.equal(10)
      chai.expect(warn.calledOnceWith(`[Test] ${NAME}=5 is below the minimum 10, using 10`)).to.equal(true)
    })

    it("defaults the minimum to 1 and omits the prefix when none is given", () => {
      const setting = { fallback: 100, maximum: 1000 }
      chai.expect(readPositiveInteger({ [NAME]: "1" }, NAME, setting)).to.equal(1)
      chai.expect(readPositiveInteger({ [NAME]: "abc" }, NAME, setting)).to.equal(100)
      chai.expect(warn.calledOnceWith(`ignoring invalid ${NAME}="abc", using 100`)).to.equal(true)
    })
  })

  describe("parseExecuteProcessTimeoutMs", () => {
    it("defaults to one hour", () => {
      chai.expect(parseExecuteProcessTimeoutMs({})).to.equal(ONE_HOUR_MS)
    })

    it("reads ACTION_HUB_EXECUTE_PROCESS_TIMEOUT_MS", () => {
      chai.expect(parseExecuteProcessTimeoutMs({ ACTION_HUB_EXECUTE_PROCESS_TIMEOUT_MS: "7200000" }))
        .to.equal(2 * ONE_HOUR_MS)
    })

    it("falls back to one hour for an invalid value", () => {
      chai.expect(parseExecuteProcessTimeoutMs({ ACTION_HUB_EXECUTE_PROCESS_TIMEOUT_MS: "2h" }))
        .to.equal(ONE_HOUR_MS)
      chai.expect(warn.calledOnce).to.equal(true)
    })

    it("caps the timeout at 24 hours, below Node's timer limit", () => {
      chai.expect(parseExecuteProcessTimeoutMs({ ACTION_HUB_EXECUTE_PROCESS_TIMEOUT_MS: "2592000000" }))
        .to.equal(24 * ONE_HOUR_MS)
      chai.expect(warn.calledOnce).to.equal(true)
    })

    it("applies the configured timeout to the execute queue", () => {
      chai.expect(new ExecuteProcessQueue().PROCESS_TIMEOUT).to.equal(parseExecuteProcessTimeoutMs(process.env))
    })
  })
})
