import * as chai from "chai"
import * as sinon from "sinon"

import * as Hub from "../../hub"
import { RudderAction } from "./rudderstack"

const action = new RudderAction()
action.executeInOwnProcess = false

function expectRudderMatch(request: Hub.ActionRequest, match: any) {
  // The action invokes `identify(payload, doneCb)` and reconciles completion
  // counts before resolving, so the stub must call `doneCb` for each event.
  const rudderCallSpy = sinon.spy((_payload: any, done?: () => void) => {
    if (done) { done() }
  })
  const stubClient = sinon.stub(action as any, "rudderClientFromRequest")
    .callsFake(() => {
      return {identify: rudderCallSpy, flush: (cb: () => void) => cb()}
     })
  const stubAnon = sinon.stub(action as any, "generateAnonymousId").callsFake(() => "stubanon")

  const now = new Date()
  // shouldAdvanceTime lets the action's setInterval reconciliation loop fire
  // while Date stays pinned to `now` for the timestamp assertions below.
  const clock = sinon.useFakeTimers({now: now.getTime(), shouldAdvanceTime: true})

  const baseMatch = {
    traits: {},
    context: {
      app: {
        name: "looker/actions",
        version: "dev",
      },
    },
    timestamp: now,
  }
  const merged = {...baseMatch, ...match}
  return chai.expect(action.validateAndExecute(request)).to.be.fulfilled.then(() => {
    // identify is invoked as (payload, doneCb); assert only on the payload arg.
    chai.expect(rudderCallSpy).to.have.been.calledWith(merged)
    stubClient.restore()
    stubAnon.restore()
    clock.restore()
  })
}

describe(`${action.constructor.name} unit tests`, () => {

  describe("action", () => {

    it("works with user_id", () => {
      const request = new Hub.ActionRequest()
      request.type = Hub.ActionType.Query
      request.params = {
        rudder_write_key: "mykey",
        rudder_server_url: "https://myrudder.com",
      }
      request.attachment = {dataBuffer: Buffer.from(JSON.stringify({
          fields: {dimensions: [{name: "coolfield", tags: ["user_id"]}]},
          data: [{coolfield: {value: "funvalue"}}],
        }))}
      return expectRudderMatch(request, {
        userId: "funvalue",
        anonymousId: null,
      })
    })

    it("works with email", () => {
      const request = new Hub.ActionRequest()
      request.type = Hub.ActionType.Query
      request.params = {
        rudder_write_key: "mykey",
        rudder_server_url: "https://myrudder.com",
      }
      request.attachment = {dataBuffer: Buffer.from(JSON.stringify({
        fields: {dimensions: [{name: "coolfield", tags: ["email"]}]},
        data: [{coolfield: {value: "funvalue"}}],
      }))}
      return expectRudderMatch(request, {
        anonymousId: "stubanon",
        userId: null,
        traits: {email: "funvalue"},
       })
    })

    it("works with pivoted values", () => {
      const request = new Hub.ActionRequest()
      request.type = Hub.ActionType.Query
      request.params = {
        rudder_write_key: "mykey",
        rudder_server_url: "https://myrudder.com",
      }
      request.attachment = {dataBuffer: Buffer.from(JSON.stringify({
          fields: {dimensions: [{name: "coolfield", tags: ["user_id"]}],
                   measures: [{name: "users.count"}]},
          data: [{"coolfield": {value: "funvalue"}, "users.count": {f: {value: 1}, z: {value: 3}}}],
        }))}
      return expectRudderMatch(request, {
        userId: "funvalue",
        anonymousId: null,
        traits: { "users.count": [{ f: 1 }, { z: 3 }] },
      })
    })

    it("works with email and user id", () => {
      const request = new Hub.ActionRequest()
      request.type = Hub.ActionType.Query
      request.params = {
        rudder_write_key: "mykey",
        rudder_server_url: "https://myrudder.com",
      }
      request.attachment = {dataBuffer: Buffer.from(JSON.stringify({
        fields: {dimensions: [{name: "coolemail", tags: ["email"]}, {name: "coolid", tags: ["user_id"]}]},
        data: [{coolemail: {value: "email@email.email"}, coolid: {value: "id"}}],
      }))}
      return expectRudderMatch(request, {
        userId: "id",
        traits: {email: "email@email.email"},
        anonymousId: null,
      })
    })

    it("works with email, user id and anonymous id", () => {
      const request = new Hub.ActionRequest()
      request.type = Hub.ActionType.Query
      request.params = {
        rudder_write_key: "mykey",
        rudder_server_url: "https://myrudder.com",
      }
      request.attachment = {dataBuffer: Buffer.from(JSON.stringify({
        fields: {dimensions: [
          {name: "coolemail", tags: ["email"]},
          {name: "coolid", tags: ["user_id"]},
          {name: "coolanonymousid", tags: ["rudder_anonymous_id"]}]},
        data: [{coolemail: {value: "email@email.email"}, coolid: {value: "id"}, coolanonymousid: {value: "anon_id"}}],
      }))}
      return expectRudderMatch(request, {
        userId: "id",
        traits: {email: "email@email.email"},
        anonymousId: "anon_id",
      })
    })

    it("works with email, user id and anonymous id and trait", () => {
      const request = new Hub.ActionRequest()
      request.type = Hub.ActionType.Query
      request.params = {
        rudder_write_key: "mykey",
        rudder_server_url: "https://myrudder.com",
      }
      request.attachment = {dataBuffer: Buffer.from(JSON.stringify({
        fields: {dimensions: [
          {name: "coolemail", tags: ["email"]},
          {name: "coolid", tags: ["user_id"]},
          {name: "coolanonymousid", tags: ["rudder_anonymous_id"]},
          {name: "cooltrait", tags: []},
        ]},
        data: [{
          coolemail: {value: "emailemail"},
          coolid: {value: "id"},
          coolanonymousid: {value: "anon_id"},
          cooltrait: {value: "funtrait"},
        }],
      }))}
      return expectRudderMatch(request, {
        userId: "id",
        traits: {
          email: "emailemail",
          cooltrait: "funtrait",
        },
        anonymousId: "anon_id",
      })
    })

    it("works with user id and anonymous id", () => {
      const request = new Hub.ActionRequest()
      request.type = Hub.ActionType.Query
      request.params = {
        rudder_write_key: "mykey",
        rudder_server_url: "https://myrudder.com",
      }
      request.attachment = {dataBuffer: Buffer.from(JSON.stringify({
        fields: {dimensions: [
          {name: "coolid", tags: ["user_id"]}, {name: "coolanonymousid", tags: ["rudder_anonymous_id"]},
        ]},
        data: [
            {coolid: {value: "id"}, coolanonymousid: {value: "anon_id"}}],
      }))}
      return expectRudderMatch(request, {
        userId: "id",
        anonymousId: "anon_id",
      })
    })

    it("works with anonymous id", () => {
      const request = new Hub.ActionRequest()
      request.type = Hub.ActionType.Query
      request.params = {
        rudder_write_key: "mykey",
        rudder_server_url: "https://myrudder.com",
      }
      request.attachment = {dataBuffer: Buffer.from(JSON.stringify({
        fields: {dimensions: [
            {name: "coolanonymousid", tags: ["rudder_anonymous_id"]},
        ]},
        data: [{coolanonymousid: {value: "anon_id"}}],
      }))}
      return expectRudderMatch(request, {
        userId: null,
        anonymousId: "anon_id",
      })
    })

    it("doesn't send hidden fields", () => {
      const request = new Hub.ActionRequest()
      request.type = Hub.ActionType.Query
      request.params = {
        rudder_write_key: "mykey",
        rudder_server_url: "https://myrudder.com",
      }
      request.attachment = {dataBuffer: Buffer.from(JSON.stringify({
        fields: {
          dimensions: [
            {name: "coolfield", tags: ["email"]},
            {name: "hiddenfield"},
            {name: "nonhiddenfield"},
          ]},
        data: [{
          coolfield: {value: "funvalue"},
          hiddenfield: {value: "hiddenvalue"},
          nonhiddenfield: {value: "nonhiddenvalue"},
        }],
      }))}
      request.scheduledPlan = {
        query: {
          vis_config: {
            hidden_fields: [
              "hiddenfield",
            ],
          },
        },
      } as any
      return expectRudderMatch(request, {
        anonymousId: "stubanon",
        userId: null,
        traits: {
          email: "funvalue",
          nonhiddenfield: "nonhiddenvalue",
        },
      })
    })

    it("works with null user_ids", () => {
      const request = new Hub.ActionRequest()
      request.type = Hub.ActionType.Query
      request.params = {
        rudder_write_key: "mykey",
        rudder_server_url: "https://myrudder.com",
      }
      request.attachment = {dataBuffer: Buffer.from(JSON.stringify({
        fields: {dimensions: [{name: "coolfield", tags: ["user_id"]}]},
        data: [{coolfield: {value: null}}],
      }))}
      return expectRudderMatch(request, {
        userId: null,
        anonymousId: "stubanon",
      })
    })

    it("works with ran_at", () => {
      const request = new Hub.ActionRequest()
      request.type = Hub.ActionType.Query
      request.params = {
        rudder_write_key: "mykey",
        rudder_server_url: "https://myrudder.com",
      }
      request.attachment = {dataBuffer: Buffer.from(JSON.stringify({
        fields: {dimensions: [{name: "coolfield", tags: ["email"]}]},
        ran_at: "2017-07-28T02:25:19+00:00",
        data: [{coolfield: {value: "funvalue"}}],
      }))}
      return expectRudderMatch(request, {
        anonymousId: "stubanon",
        userId: null,
        timestamp: new Date("2017-07-28T02:25:19+00:00"),
        traits: {email: "funvalue"},
       })
    })

    it("errors if the input has no attachment", () => {
      const request = new Hub.ActionRequest()
      request.type = Hub.ActionType.Query
      request.params = {
        rudder_write_key: "mykey",
        rudder_server_url: "https://myrudder.com",
      }
      return chai.expect(action.validateAndExecute(request)).to.eventually
        .be.rejectedWith(
          "A streaming action was sent incompatible data. The action must have a download url or an attachment.")
    })

    it("errors if the query response has no fields", (done) => {
      const request = new Hub.ActionRequest()
      request.type = Hub.ActionType.Query
      request.params = {
        rudder_write_key: "mykey",
        rudder_server_url: "https://myrudder.com",
      }
      request.attachment = {dataBuffer: Buffer.from(JSON.stringify({
        data: [{coolfield: {value: "funvalue"}}],
      }))}
      chai.expect(action.validateAndExecute(request)).to.eventually
        .deep.equal({
          message: "Query requires a field tagged email or user_id or rudder_anonymous_id.",
          success: false,
          refreshQuery: false,
          validationErrors: [],
        })
        .and.notify(done)
    })

    it("errors if there is no tagged field", (done) => {
      const request = new Hub.ActionRequest()
      request.type = Hub.ActionType.Query
      request.params = {
        rudder_write_key: "mykey",
        rudder_server_url: "https://myrudder.com",
      }
      request.attachment = {dataBuffer: Buffer.from(JSON.stringify({
        fields: {dimensions: [{name: "coolfield", tags: []}]},
        data: [{coolfield: {value: "funvalue"}}],
      }))}
      chai.expect(action.validateAndExecute(request)).to.eventually
        .deep.equal({
          message: "Query requires a field tagged email or user_id or rudder_anonymous_id.",
          success: false,
          refreshQuery: false,
          validationErrors: [],
        })
        .and.notify(done)
    })

    it("errors if there is no write key", () => {
      const request = new Hub.ActionRequest()
      request.type = Hub.ActionType.Query
      request.attachment = {dataBuffer: Buffer.from(JSON.stringify({
        fields: {dimensions: [{name: "coolfield", tags: ["user_id"]}]},
        data: [],
      }))}
      return chai.expect(action.validateAndExecute(request)).to.eventually
        .be.rejectedWith(`Required setting "Rudder Write Key" not specified in action settings.`)
    })

  })

  describe("form", () => {
    it("has no form", () => {
      chai.expect(action.hasForm).equals(false)
    })
  })
})
