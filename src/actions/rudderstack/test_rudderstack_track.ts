import * as chai from "chai"
import * as sinon from "sinon"

import * as Hub from "../../hub"
import { DeliveryCallback } from "./rudderstack"
import { RudderTrackAction } from "./rudderstack_track"
import { fakeRudderClient } from "./test_rudderstack_helpers"
import { TestRudderTrackAction } from "./test_rudderstack_track_action"

const action = new RudderTrackAction()
action.executeInOwnProcess = false

describe(`${action.constructor.name} unit tests`, () => {

  describe("action", () => {

    it ("calls track", () => {
      const rudderCallSpy = sinon.spy((_message: unknown, done: DeliveryCallback) => done())
      const testAction = new TestRudderTrackAction(() => fakeRudderClient({ track: rudderCallSpy }))

      const now = new Date()
      const clock = sinon.useFakeTimers(now.getTime())

      const request = new Hub.ActionRequest()
      request.formParams = {
        event: "funevent",
      }
      request.type = Hub.ActionType.Query
      request.params = {
        rudder_write_key: "mykey", rudder_server_url: "https://localhost:8080",
      }
      request.attachment = {dataBuffer: Buffer.from(JSON.stringify({
          fields: {dimensions: [{name: "coolfield", tags: ["user_id"]}]},
          data: [{coolfield: {value: "funvalue"}}],
        }))}

      return chai.expect(testAction.validateAndExecute(request)).to.be.fulfilled.then(() => {
        chai.expect(rudderCallSpy).to.have.been.calledWithExactly({
          userId: "funvalue",
          anonymousId: null,
          event: "funevent",
          properties: {},
          context: {
            app: {
              name: "looker/actions",
              version: "dev",
            },
          },
          timestamp: now,
        }, sinon.match.func)
        clock.restore()
      })
    })
  })

  describe("form", () => {
    it("has form", () => {
      chai.expect(action.hasForm).equals(true)
    })
  })

})
