import * as chai from "chai"
import * as sinon from "sinon"
import * as winston from "winston"

import * as Hub from "../../hub"
import {
  DEFAULT_RUDDER_SDK_SETTINGS,
  DeliveryCallback,
  normalizeDataPlaneUrl,
  parseRudderSdkSettings,
  pickClientIndex,
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
    ]
    cases.forEach(([raw, expected]) => {
      it(`normalizes "${raw}"`, () => {
        chai.expect(normalizeDataPlaneUrl(raw)).to.equal(expected)
      })
    })

    const invalid: (string | undefined)[] = [
      undefined, "", "   ", "not a url", "ftp://dp.example.com", "/v1/batch",
      "http://dp.example.com", "http://dp.example.com/v1/batch",
    ]
    invalid.forEach((raw) => {
      it(`rejects ${JSON.stringify(raw)}`, () => {
        chai.expect(() => normalizeDataPlaneUrl(raw)).to.throw(
          "Rudder Data Plane URL must be a valid https URL.",
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
        RUDDER_SDK_FLUSH_AT: "50",
        RUDDER_SDK_CLIENT_POOL_SIZE: "4",
        RUDDER_SDK_MAX_PENDING_EVENTS: "1000",
        RUDDER_SDK_REQUEST_TIMEOUT_MS: "10000",
      })).to.deep.equal({ flushAt: 50, clientPoolSize: 4, maxPendingEvents: 1000, requestTimeoutMs: 10000 })
    })

    it("falls back to the default request timeout for an invalid value", () => {
      chai.expect(parseRudderSdkSettings({ RUDDER_SDK_REQUEST_TIMEOUT_MS: "soon" }).requestTimeoutMs)
        .to.equal(DEFAULT_RUDDER_SDK_SETTINGS.requestTimeoutMs)
    })

    it("falls back to defaults for invalid values", () => {
      chai.expect(parseRudderSdkSettings({
        RUDDER_SDK_FLUSH_AT: "abc",
        RUDDER_SDK_CLIENT_POOL_SIZE: "0",
        RUDDER_SDK_MAX_PENDING_EVENTS: "-5",
      })).to.deep.equal(DEFAULT_RUDDER_SDK_SETTINGS)
    })

    it("falls back for non-integer values", () => {
      chai.expect(parseRudderSdkSettings({ RUDDER_SDK_FLUSH_AT: "1.5" }).flushAt)
        .to.equal(DEFAULT_RUDDER_SDK_SETTINGS.flushAt)
    })

    it("raises max pending events so every client can fill a batch", () => {
      chai.expect(parseRudderSdkSettings({
        RUDDER_SDK_FLUSH_AT: "100",
        RUDDER_SDK_CLIENT_POOL_SIZE: "8",
        RUDDER_SDK_MAX_PENDING_EVENTS: "500",
      }).maxPendingEvents).to.equal(1600)
    })

    it("logs one warning with the value actually used when both adjustments apply", () => {
      const warn = sinon.stub(winston, "warn")
      try {
        const settings = parseRudderSdkSettings({
          RUDDER_SDK_FLUSH_AT: "5000",
          RUDDER_SDK_CLIENT_POOL_SIZE: "8",
        })
        chai.expect(settings.maxPendingEvents).to.equal(10000)
        chai.expect(warn.callCount).to.equal(1)
        chai.expect(warn.firstCall.args[0]).to.equal(
          "[Rudder] RUDDER_SDK_MAX_PENDING_EVENTS=1600 adjusted to 10000: " +
            "below flushAt x clientPoolSize (40000); " +
            "capped at 10000 to leave headroom below the SDK queue limit (20000)",
        )
      } finally {
        warn.restore()
      }
    })

    it("caps max pending events at half the SDK drop threshold", () => {
      chai.expect(parseRudderSdkSettings({ RUDDER_SDK_MAX_PENDING_EVENTS: "15000" }).maxPendingEvents)
        .to.equal(10000)
    })

    it("accepts max pending events at the cap", () => {
      chai.expect(parseRudderSdkSettings({ RUDDER_SDK_MAX_PENDING_EVENTS: "10000" }).maxPendingEvents)
        .to.equal(10000)
    })
  })

  describe("pickClientIndex", () => {
    it("routes the same key to the same client", () => {
      chai.expect(pickClientIndex("user-42", 8)).to.equal(pickClientIndex("user-42", 8))
    })

    it("always returns an index within the pool", () => {
      for (let i = 0; i < 1000; i++) {
        const index = pickClientIndex(`user-${i}`, 8)
        chai.expect(index).to.be.within(0, 7)
      }
    })

    it("spreads keys across the pool", () => {
      const used = new Set<number>()
      for (let i = 0; i < 1000; i++) {
        used.add(pickClientIndex(`user-${i}`, 8))
      }
      chai.expect(used.size).to.equal(8)
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
      tracker.stop()
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
        sdkSettings: { maxPendingEvents: 2, clientPoolSize: 1 },
      })
      const warn = sandbox.stub(winston, "warn")

      // Several attachment slices, so the stream is genuinely waiting when it pauses.
      const response = await stalledAction.validateAndExecute(identifyRequest(5000))
      chai.expect(response.success).to.equal(true)
      chai.expect(warn.calledWithMatch(
        "[Rudder] delivery stalled: no delivery result for 30ms while paused; stopped streaming after",
      )).to.equal(true)
    })

    it("does not stack timer flushes while a flush is still in flight", async () => {
      let releaseFlush: () => void = () => undefined
      const flushHeld = new Promise<void>((resolve) => { releaseFlush = resolve })
      const pendingCallbacks: DeliveryCallback[] = []
      const flush = sandbox.spy(async () => flushHeld)
      const action = new TestRudderIdentifyAction(() => fakeRudderClient({
        identify: (_message: unknown, done: DeliveryCallback) => {
          pendingCallbacks.push(done)
        },
        flush,
      }))

      const execution = action.validateAndExecute(identifyRequest(1))
      // Several 500ms ticks pass while the first flush is held open.
      await new Promise((resolve) => setTimeout(resolve, 1200))
      const poolSize = DEFAULT_RUDDER_SDK_SETTINGS.clientPoolSize
      // One post-stream drain flush per client plus at most one timer flush per client.
      chai.expect(flush.callCount).to.be.at.most(poolSize * 2)

      releaseFlush()
      pendingCallbacks.forEach((done) => done())
      const response = await execution
      chai.expect(response.success).to.equal(true)
    })

    it("creates clients with the normalized data plane URL", async () => {
      const createClient = sandbox.spy(() => ackingRudderClient())
      const action = new TestRudderIdentifyAction(createClient)

      await action.validateAndExecute(identifyRequest(1, "https://dp.example.com/v1/batch/"))
      chai.expect(createClient.callCount).to.equal(DEFAULT_RUDDER_SDK_SETTINGS.clientPoolSize)
      chai.expect(createClient.alwaysCalledWithExactly("mykey", "https://dp.example.com")).to.equal(true)
    })

    it("fails without sending when the data plane URL is invalid", async () => {
      const createClient = sandbox.spy(() => ackingRudderClient())
      const action = new TestRudderIdentifyAction(createClient)

      const response = await action.validateAndExecute(identifyRequest(1, "ftp://dp.example.com"))
      chai.expect(response.success).to.equal(false)
      chai.expect(response.message).to.equal("Rudder Data Plane URL must be a valid https URL.")
      chai.expect(createClient.called).to.equal(false)
    })

    it("spreads numeric user ids across clients and keeps each on one client", async () => {
      const clientIdsByUser = new Map<string, Set<number>>()
      let clientId = 0
      const action = new TestRudderIdentifyAction(() => {
        const id = clientId++
        return fakeRudderClient({
          identify: (message: { userId?: unknown }, done: DeliveryCallback) => {
            const userId = String(message.userId)
            const ids = clientIdsByUser.get(userId)
            if (ids) {
              ids.add(id)
            } else {
              clientIdsByUser.set(userId, new Set([id]))
            }
            done()
          },
        })
      })

      const request = identifyRequest(0)
      const data = []
      for (let i = 0; i < 100; i++) {
        data.push({ coolfield: { value: (i % 50) + 1 } })
      }
      request.attachment = {
        dataBuffer: Buffer.from(JSON.stringify({
          fields: { dimensions: [{ name: "coolfield", tags: ["user_id"] }] },
          data,
        })),
      }

      await action.validateAndExecute(request)
      const clientsUsed = new Set<number>()
      clientIdsByUser.forEach((ids) => {
        chai.expect(ids.size).to.equal(1)
        ids.forEach((id) => clientsUsed.add(id))
      })
      chai.expect(clientIdsByUser.size).to.equal(50)
      chai.expect(clientsUsed.size).to.be.greaterThan(1)
    })

    it("routes every event for a user to the same client", async () => {
      const clientIdsByUser = new Map<string, Set<number>>()
      let clientId = 0
      const action = new TestRudderIdentifyAction(() => {
        const id = clientId++
        return fakeRudderClient({
          identify: (message: { userId?: string }, done: DeliveryCallback) => {
            const userId = message.userId === undefined ? "" : message.userId
            const ids = clientIdsByUser.get(userId)
            if (ids) {
              ids.add(id)
            } else {
              clientIdsByUser.set(userId, new Set([id]))
            }
            done()
          },
        })
      })

      const request = identifyRequest(0)
      const data = []
      for (let i = 0; i < 50; i++) {
        data.push({ coolfield: { value: `user${i % 5}` } })
      }
      request.attachment = {
        dataBuffer: Buffer.from(JSON.stringify({
          fields: { dimensions: [{ name: "coolfield", tags: ["user_id"] }] },
          data,
        })),
      }

      await action.validateAndExecute(request)
      chai.expect(clientIdsByUser.size).to.equal(5)
      clientIdsByUser.forEach((ids) => chai.expect(ids.size).to.equal(1))
    })
  })
})
