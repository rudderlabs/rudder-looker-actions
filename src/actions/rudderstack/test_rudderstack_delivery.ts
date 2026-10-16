import * as chai from "chai"
import * as sinon from "sinon"
import * as winston from "winston"

import * as Hub from "../../hub"
import {
  DEFAULT_RUDDER_SDK_SETTINGS,
  DeliveryCallback,
  normalizeDataPlaneUrl,
  parseRudderSdkSettings,
  rudderClientOptions,
} from "./rudderstack"
import { RudderDeliveryTracker } from "./rudderstack_delivery_tracker"
import { ackingRudderClient, fakeRudderClient, TestRudderIdentifyAction } from "./test_rudderstack_helpers"

function identifyRequest(rows: number, serverUrl = "https://localhost:8080") {
  const request = new Hub.ActionRequest()
  request.type = Hub.ActionType.Query
  request.params = { rudder_write_key: "mykey", rudder_server_url: serverUrl }
  const data = []
  for (let i = 0; i < rows; i++) {
    data.push({ coolfield: { value: `user${i}` } })
  }
  request.attachment = {
    dataBuffer: Buffer.from(
      JSON.stringify({
        fields: { dimensions: [{ name: "coolfield", tags: ["user_id"] }] },
        data,
      }),
    ),
  }
  return request
}

function flowControlSpy() {
  return { pause: sinon.spy(), resume: sinon.spy(), abort: sinon.spy() }
}

describe("RudderStack delivery", () => {
  describe("normalizeDataPlaneUrl", () => {
    const cases: [string, string][] = [
      ["https://dp.example.com", "https://dp.example.com"],
      ["https://dp.example.com/", "https://dp.example.com"],
      ["https://dp.example.com/v1/batch", "https://dp.example.com"],
      ["https://dp.example.com/v1/batch/", "https://dp.example.com"],
      ["  https://dp.example.com/v1/batch  ", "https://dp.example.com"],
      ["https://localhost:8080//v1/batch", "https://localhost:8080"],
      ["https://dp.example.com/prefix/v1/batch", "https://dp.example.com/prefix"],
      ["https://dp.example.com?x=1", "https://dp.example.com"],
      ["https://dp.example.com/v1/batch?x=1", "https://dp.example.com"],
      ["https://dp.example.com#frag", "https://dp.example.com"],
      ["https://user@dp.example.com/v1/batch", "https://dp.example.com"],
    ]
    cases.forEach(([raw, expected]) => {
      it(`normalizes "${raw}"`, () => {
        chai.expect(normalizeDataPlaneUrl(raw)).to.equal(expected)
      })
    })

    const notUrls: (string | undefined)[] = [undefined, "", "   ", "not a url", "/v1/batch"]
    notUrls.forEach((raw) => {
      it(`rejects ${JSON.stringify(raw)} as not a URL`, () => {
        chai.expect(() => normalizeDataPlaneUrl(raw)).to.throw(
          "Rudder Data Plane URL validation failed: not a valid URL.",
        )
      })
    })

    const notHttps = ["ftp://dp.example.com", "http://dp.example.com", "http://dp.example.com/v1/batch"]
    notHttps.forEach((raw) => {
      it(`rejects ${JSON.stringify(raw)} as not https`, () => {
        chai.expect(() => normalizeDataPlaneUrl(raw)).to.throw(
          "Rudder Data Plane URL validation failed: must use https.",
        )
      })
    })
  })

  describe("parseRudderSdkSettings", () => {
    it("uses defaults when nothing is set", () => {
      chai.expect(parseRudderSdkSettings({})).to.deep.equal(DEFAULT_RUDDER_SDK_SETTINGS)
    })

    it("reads valid overrides", () => {
      chai.expect(parseRudderSdkSettings({
        RUDDER_SDK_FLUSH_AT: "500",
        RUDDER_SDK_MAX_BATCH_BYTES: "1048576",
        RUDDER_SDK_MAX_INTERNAL_QUEUE_SIZE: "12000",
        RUDDER_SDK_MAX_PENDING_EVENTS: "3000",
        RUDDER_SDK_FLUSH_INTERVAL_MS: "1000",
        RUDDER_SDK_REQUEST_TIMEOUT_MS: "10000",
      })).to.deep.equal({
        flushAt: 500,
        maxBatchBytes: 1048576,
        maxInternalQueueSize: 12000,
        maxPendingEvents: 3000,
        flushIntervalMs: 1000,
        requestTimeoutMs: 10000,
      })
    })

    it("falls back to the default request timeout for an invalid value", () => {
      chai.expect(parseRudderSdkSettings({ RUDDER_SDK_REQUEST_TIMEOUT_MS: "soon" }).requestTimeoutMs)
        .to.equal(DEFAULT_RUDDER_SDK_SETTINGS.requestTimeoutMs)
    })

    it("falls back to defaults for invalid values", () => {
      chai.expect(parseRudderSdkSettings({
        RUDDER_SDK_FLUSH_AT: "abc",
        RUDDER_SDK_MAX_BATCH_BYTES: "0",
        RUDDER_SDK_MAX_INTERNAL_QUEUE_SIZE: "lots",
        RUDDER_SDK_MAX_PENDING_EVENTS: "-5",
        RUDDER_SDK_FLUSH_INTERVAL_MS: "",
      })).to.deep.equal(DEFAULT_RUDDER_SDK_SETTINGS)
    })

    it("falls back for non-integer values", () => {
      chai.expect(parseRudderSdkSettings({ RUDDER_SDK_FLUSH_AT: "1.5" }).flushAt)
        .to.equal(DEFAULT_RUDDER_SDK_SETTINGS.flushAt)
    })

    it("raises max pending events so a batch can fill while another is in flight", () => {
      chai.expect(parseRudderSdkSettings({
        RUDDER_SDK_FLUSH_AT: "5000",
        RUDDER_SDK_MAX_PENDING_EVENTS: "4000",
      }).maxPendingEvents).to.equal(10000)
    })

    it("logs one warning with the value actually used when both adjustments apply", () => {
      const warn = sinon.stub(winston, "warn")
      try {
        const settings = parseRudderSdkSettings({
          RUDDER_SDK_FLUSH_AT: "20000",
          RUDDER_SDK_MAX_PENDING_EVENTS: "1000",
        })
        chai.expect(settings.maxPendingEvents).to.equal(25000)
        chai.expect(warn.callCount).to.equal(1)
        chai.expect(warn.firstCall.args[0]).to.equal(
          "[Rudder] RUDDER_SDK_MAX_PENDING_EVENTS=1000 adjusted to 25000: " +
            "below 2 x flushAt (40000); " +
            "capped at 25000 to leave headroom below the SDK queue limit (50000)",
        )
      } finally {
        warn.restore()
      }
    })

    it("clamps settings to their maximums", () => {
      const warn = sinon.stub(winston, "warn")
      try {
        const settings = parseRudderSdkSettings({
          RUDDER_SDK_FLUSH_AT: "50000",
          RUDDER_SDK_MAX_BATCH_BYTES: "4194304",
          RUDDER_SDK_MAX_INTERNAL_QUEUE_SIZE: "4294967296",
          RUDDER_SDK_FLUSH_INTERVAL_MS: "60000",
          RUDDER_SDK_REQUEST_TIMEOUT_MS: "3000000000",
        })
        chai.expect(settings.flushAt).to.equal(20000)
        chai.expect(settings.maxBatchBytes).to.equal(3900000)
        chai.expect(settings.maxInternalQueueSize).to.equal(200000)
        chai.expect(settings.flushIntervalMs).to.equal(10000)
        chai.expect(settings.requestTimeoutMs).to.equal(300000)
        chai.expect(warn.calledWithMatch(
          "[Rudder] RUDDER_SDK_MAX_BATCH_BYTES=4194304 is above the maximum 3900000, using 3900000",
        )).to.equal(true)
      } finally {
        warn.restore()
      }
    })

    it("accepts settings exactly at their maximums", () => {
      const settings = parseRudderSdkSettings({
        RUDDER_SDK_FLUSH_AT: "20000",
        RUDDER_SDK_MAX_BATCH_BYTES: "3900000",
        RUDDER_SDK_MAX_INTERNAL_QUEUE_SIZE: "200000",
        RUDDER_SDK_FLUSH_INTERVAL_MS: "10000",
        RUDDER_SDK_REQUEST_TIMEOUT_MS: "300000",
      })
      chai.expect(settings.flushAt).to.equal(20000)
      chai.expect(settings.maxBatchBytes).to.equal(3900000)
      chai.expect(settings.maxInternalQueueSize).to.equal(200000)
      chai.expect(settings.flushIntervalMs).to.equal(10000)
      chai.expect(settings.requestTimeoutMs).to.equal(300000)
    })

    it("caps max pending events at half the SDK drop threshold", () => {
      chai.expect(parseRudderSdkSettings({ RUDDER_SDK_MAX_PENDING_EVENTS: "30000" }).maxPendingEvents)
        .to.equal(25000)
    })

    it("derives the max pending events cap from the configured SDK queue size", () => {
      chai.expect(parseRudderSdkSettings({
        RUDDER_SDK_MAX_INTERNAL_QUEUE_SIZE: "100000",
        RUDDER_SDK_MAX_PENDING_EVENTS: "60000",
      }).maxPendingEvents).to.equal(50000)
    })

    it("raises the SDK queue size to its minimum and caps pending events at half of it", () => {
      const warn = sinon.stub(winston, "warn")
      try {
        const settings = parseRudderSdkSettings({ RUDDER_SDK_MAX_INTERNAL_QUEUE_SIZE: "1000" })
        chai.expect(settings.maxInternalQueueSize).to.equal(10000)
        chai.expect(settings.maxPendingEvents).to.equal(5000)
        chai.expect(warn.calledWithMatch(
          "[Rudder] RUDDER_SDK_MAX_INTERNAL_QUEUE_SIZE=1000 is below the minimum 10000, using 10000",
        )).to.equal(true)
      } finally {
        warn.restore()
      }
    })

    it("accepts max pending events at the cap", () => {
      chai.expect(parseRudderSdkSettings({ RUDDER_SDK_MAX_PENDING_EVENTS: "25000" }).maxPendingEvents)
        .to.equal(25000)
    })
  })

  describe("rudderClientOptions", () => {
    it("passes every setting to the SDK", () => {
      const options = rudderClientOptions("https://dp.example.com", DEFAULT_RUDDER_SDK_SETTINGS)
      chai.expect(options).to.include({
        dataPlaneUrl: "https://dp.example.com",
        flushAt: 10000,
        maxQueueSize: 3670016,
        maxInternalQueueSize: 50000,
        flushInterval: 500,
        timeout: 30000,
      })
    })

    it("logs failed batches through the error handler", () => {
      const warn = sinon.stub(winston, "warn")
      try {
        const options = rudderClientOptions("https://dp.example.com", DEFAULT_RUDDER_SDK_SETTINGS)
        chai.expect(options.errorHandler).to.be.a("function")
        if (options.errorHandler) {
          options.errorHandler(new Error("Request failed with status code 502"))
        }
        chai.expect(warn.calledWithExactly(
          "[Rudder] batch delivery failed: Request failed with status code 502",
        )).to.equal(true)
      } finally {
        warn.restore()
      }
    })
  })

  describe("RudderDeliveryTracker", () => {
    it("pauses at the pending limit and resumes at half of it", () => {
      const control = flowControlSpy()
      const tracker = new RudderDeliveryTracker(4, 1000)
      tracker.setFlowControl(control)

      for (let i = 0; i < 4; i++) {
        tracker.markSent()
      }
      chai.expect(control.pause.callCount).to.equal(1)

      tracker.onEventDone()
      chai.expect(control.resume.callCount).to.equal(0)
      tracker.onEventDone()
      chai.expect(control.resume.callCount).to.equal(1)
    })

    it("does not pause again while already paused", () => {
      const control = flowControlSpy()
      const tracker = new RudderDeliveryTracker(2, 1000)
      tracker.setFlowControl(control)
      for (let i = 0; i < 5; i++) {
        tracker.markSent()
      }
      chai.expect(control.pause.callCount).to.equal(1)
      tracker.endStreaming()
    })

    it("counts failures and keeps the first error messages", () => {
      const tracker = new RudderDeliveryTracker(100, 1000)
      for (let i = 0; i < 5; i++) {
        tracker.markSent()
        tracker.onEventDone(new Error(`failure ${i}`))
      }
      chai.expect(tracker.failed).to.equal(5)
      chai.expect(tracker.errorMessages).to.deep.equal(["failure 0", "failure 1", "failure 2"])
    })

    it("reports each distinct error message once", () => {
      const tracker = new RudderDeliveryTracker(100, 1000)
      const messages = ["status 400", "status 400", "status 502", "status 400"]
      messages.forEach((message) => {
        tracker.markSent()
        tracker.onEventDone(new Error(message))
      })
      chai.expect(tracker.failed).to.equal(4)
      chai.expect(tracker.errorMessages).to.deep.equal(["status 400", "status 502"])
    })

    it("aborts the stream when paused with no delivery result for the stall timeout", async () => {
      const control = flowControlSpy()
      const tracker = new RudderDeliveryTracker(2, 20)
      tracker.setFlowControl(control)
      tracker.markSent()
      tracker.markSent()

      await new Promise((resolve) => setTimeout(resolve, 60))
      chai.expect(control.abort.calledOnce).to.equal(true)
      chai.expect(tracker.stalled).to.equal(true)
    })

    it("stops watching for a stall once streaming has ended", async () => {
      const control = flowControlSpy()
      const tracker = new RudderDeliveryTracker(2, 20)
      tracker.setFlowControl(control)
      tracker.markSent()
      tracker.markSent()
      tracker.endStreaming()

      await new Promise((resolve) => setTimeout(resolve, 60))
      tracker.onEventDone()
      tracker.onEventDone()
      chai.expect(control.abort.called).to.equal(false)
      chai.expect(control.resume.called).to.equal(false)
      chai.expect(tracker.stalled).to.equal(false)
    })

    it("does not abort while delivery keeps progressing", async () => {
      const control = flowControlSpy()
      const tracker = new RudderDeliveryTracker(4, 40)
      tracker.setFlowControl(control)
      for (let i = 0; i < 4; i++) {
        tracker.markSent()
      }

      // Each callback inside the stall window restarts it; the second one resumes.
      await new Promise((resolve) => setTimeout(resolve, 25))
      tracker.onEventDone()
      await new Promise((resolve) => setTimeout(resolve, 25))
      tracker.onEventDone()
      await new Promise((resolve) => setTimeout(resolve, 60))

      chai.expect(control.resume.calledOnce).to.equal(true)
      chai.expect(control.abort.called).to.equal(false)
      chai.expect(tracker.stalled).to.equal(false)
    })

    it("does not count an event the SDK rejected before queueing", () => {
      const tracker = new RudderDeliveryTracker(100, 1000)
      tracker.markSent()
      tracker.revertSent()
      chai.expect(tracker.sent).to.equal(0)
      chai.expect(tracker.pending).to.equal(0)
    })

    it("resolves the drain only once every event has a callback", async () => {
      const tracker = new RudderDeliveryTracker(100, 1000)
      tracker.markSent()
      tracker.markSent()
      let drained = false
      const drain = tracker.waitForDrain(1000).then((result) => { drained = result })

      tracker.onEventDone()
      await Promise.resolve()
      chai.expect(drained).to.equal(false)

      tracker.onEventDone(new Error("boom"))
      await drain
      chai.expect(drained).to.equal(true)
    })

    it("gives up on the drain after the timeout", async () => {
      const tracker = new RudderDeliveryTracker(100, 1000)
      tracker.markSent()
      chai.expect(await tracker.waitForDrain(20)).to.equal(false)
      chai.expect(tracker.pending).to.equal(1)
    })
  })

  describe("RudderAction delivery", () => {
    // A dedicated sandbox, so restoring it doesn't undo other suites' global stubs.
    const sandbox = sinon.createSandbox()

    afterEach(() => {
      sandbox.restore()
    })

    it("logs failed events with counts without failing the action", async () => {
      let call = 0
      const action = new TestRudderIdentifyAction(() => fakeRudderClient({
        identify: (_message: unknown, done: DeliveryCallback) => {
          call++
          done(call === 2 ? new Error("Request failed with status code 502") : undefined)
        },
      }))
      const warn = sandbox.stub(winston, "warn")

      const response = await action.validateAndExecute(identifyRequest(3))
      chai.expect(response.success).to.equal(true)
      chai.expect(warn.calledWithMatch(
        "[Rudder] 2 of 3 events sent to RudderStack; 1 failed (first errors: Request failed with status code 502)",
      )).to.equal(true)
    })

    it("waits for delayed callbacks before responding", async () => {
      const pendingCallbacks: DeliveryCallback[] = []
      let releasedAt = 0
      const action = new TestRudderIdentifyAction(() => fakeRudderClient({
        identify: (_message: unknown, done: DeliveryCallback) => {
          pendingCallbacks.push(done)
          if (pendingCallbacks.length === 5) {
            // All events are queued; deliver them a little later, as a slow data plane would.
            setTimeout(() => {
              releasedAt = Date.now()
              pendingCallbacks.forEach((callback) => callback())
            }, 50)
          }
        },
      }))

      const response = await action.validateAndExecute(identifyRequest(5))
      chai.expect(response.success).to.equal(true)
      // Non-zero only if the action waited for the release before responding.
      chai.expect(releasedAt).to.be.greaterThan(0)
    })

    it("responds after the drain timeout when callbacks never arrive", async () => {
      // Calls are accepted but never acknowledged.
      const stalledAction = new TestRudderIdentifyAction(() => fakeRudderClient(), { drainTimeoutMs: 30 })
      const warn = sandbox.stub(winston, "warn")

      const response = await stalledAction.validateAndExecute(identifyRequest(3))
      chai.expect(response.success).to.equal(true)
      chai.expect(warn.calledWithMatch("[Rudder] 3 of 3 events had no delivery result")).to.equal(true)
    })

    it("responds within the drain timeout when a flush never settles", async () => {
      const stalledAction = new TestRudderIdentifyAction(
        () => fakeRudderClient({ flush: async () => new Promise<void>(() => undefined) }),
        { drainTimeoutMs: 30 },
      )
      const warn = sandbox.stub(winston, "warn")

      const response = await stalledAction.validateAndExecute(identifyRequest(3))
      chai.expect(response.success).to.equal(true)
      chai.expect(warn.calledWithMatch("[Rudder] 3 of 3 events had no delivery result")).to.equal(true)
    })

    it("stops streaming and still responds when delivery stalls while paused", async () => {
      // Calls are accepted but never acknowledged, and the stream pauses after 2 events.
      const stalledAction = new TestRudderIdentifyAction(() => fakeRudderClient(), {
        drainTimeoutMs: 30,
        sdkSettings: { maxPendingEvents: 2 },
      })
      const warn = sandbox.stub(winston, "warn")

      // Several attachment slices, so the stream is genuinely waiting when it pauses.
      const response = await stalledAction.validateAndExecute(identifyRequest(5000))
      chai.expect(response.success).to.equal(true)
      chai.expect(warn.calledWithMatch(
        "[Rudder] delivery stalled: no delivery result for 30ms while paused; stopped streaming after",
      )).to.equal(true)
    })

    it("does not report a stall when the stream was fully read before pausing took effect", async () => {
      // The stream pauses at the second row, but the third row is in the same slice,
      // so parsing completes; the callbacks never arrive.
      const action = new TestRudderIdentifyAction(() => fakeRudderClient(), {
        drainTimeoutMs: 30,
        sdkSettings: { maxPendingEvents: 2 },
      })
      const info = sandbox.stub(winston, "info")
      const warn = sandbox.stub(winston, "warn")

      const response = await action.validateAndExecute(identifyRequest(3))
      chai.expect(response.success).to.equal(true)
      chai.expect(info.calledWithMatch(
        "[Rudder] execute summary",
        { rows: 3, sent: 3, unconfirmed: 3, streamStopped: false },
      )).to.equal(true)
      chai.expect(warn.calledWithMatch("[Rudder] delivery stalled")).to.equal(false)
      chai.expect(warn.calledWithMatch("[Rudder] 3 of 3 events had no delivery result")).to.equal(true)
    })

    it("flushes the client once after streaming and leaves partial batches to the SDK timer", async () => {
      const flush = sandbox.spy(async () => Promise.resolve())
      const action = new TestRudderIdentifyAction(() => ackingRudderClient({ flush }))

      const response = await action.validateAndExecute(identifyRequest(3))
      chai.expect(response.success).to.equal(true)
      chai.expect(flush.callCount).to.equal(1)
    })

    it("creates one client with the normalized data plane URL", async () => {
      const createClient = sandbox.spy(() => ackingRudderClient())
      const action = new TestRudderIdentifyAction(createClient)

      await action.validateAndExecute(identifyRequest(1, "https://dp.example.com/v1/batch/"))
      chai.expect(createClient.callCount).to.equal(1)
      chai.expect(createClient.calledWithExactly("mykey", "https://dp.example.com")).to.equal(true)
    })

    it("fails without sending when the data plane URL is invalid", async () => {
      const createClient = sandbox.spy(() => ackingRudderClient())
      const action = new TestRudderIdentifyAction(createClient)

      const response = await action.validateAndExecute(identifyRequest(1, "ftp://dp.example.com"))
      chai.expect(response.success).to.equal(false)
      chai.expect(response.message).to.equal("Rudder Data Plane URL validation failed: must use https.")
      chai.expect(createClient.called).to.equal(false)
    })

    it("never overflows the SDK queue with a small configured queue and compact rows", async () => {
      const warn = sandbox.stub(winston, "warn")
      // A queue of 1,000 is raised to the minimum; the pending limit follows it.
      const sdkSettings = parseRudderSdkSettings({ RUDDER_SDK_MAX_INTERNAL_QUEUE_SIZE: "1000" })
      chai.expect(warn.called).to.equal(true)
      // Like the SDK, the fake client drops events beyond its queue size without a
      // callback. It delivers queued events in batches, a little later.
      const queue: DeliveryCallback[] = []
      let dropped = 0
      let peakQueue = 0
      let delivering = false
      const deliverBatch = () => {
        queue.splice(0, 1000).forEach((callback) => callback())
        if (queue.length > 0) {
          setTimeout(deliverBatch, 1)
        } else {
          delivering = false
        }
      }
      const enqueue = (_message: unknown, done: DeliveryCallback) => {
        if (queue.length >= sdkSettings.maxInternalQueueSize) {
          dropped++
          return
        }
        queue.push(done)
        peakQueue = Math.max(peakQueue, queue.length)
        if (!delivering) {
          delivering = true
          setTimeout(deliverBatch, 1)
        }
      }
      const action = new TestRudderIdentifyAction(
        () => fakeRudderClient({ identify: enqueue }),
        // Dropped events never get a callback; a short drain lets the test report them.
        { sdkSettings, drainTimeoutMs: 1000 },
      )

      // Rows of ~20 bytes, so one 64 KB slice holds several thousand.
      const request = identifyRequest(0)
      const data = []
      for (let i = 0; i < 30000; i++) {
        data.push({ f: { value: i } })
      }
      request.attachment = {
        dataBuffer: Buffer.from(JSON.stringify({
          fields: { dimensions: [{ name: "f", tags: ["user_id"] }] },
          data,
        })),
      }

      const response = await action.validateAndExecute(request)
      chai.expect(response.success).to.equal(true)
      chai.expect(dropped).to.equal(0)
      chai.expect(peakQueue).to.be.at.most(sdkSettings.maxInternalQueueSize)
    }).timeout(10000)

    it("sends every row through the one client, in row order", async () => {
      const userIds: unknown[] = []
      const action = new TestRudderIdentifyAction(() => fakeRudderClient({
        identify: (message: { userId?: unknown }, done: DeliveryCallback) => {
          userIds.push(message.userId)
          done()
        },
      }))

      const response = await action.validateAndExecute(identifyRequest(50))
      chai.expect(response.success).to.equal(true)
      chai.expect(userIds).to.deep.equal(Array.from({ length: 50 }, (_v, i) => `user${i}`))
    })
  })
})
