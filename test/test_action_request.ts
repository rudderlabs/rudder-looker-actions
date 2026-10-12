import * as chai from "chai"
import * as semver from "semver"
import {mockReq} from "sinon-express-mock"

import { ActionRequest, StreamFlowControl } from "../src/hub"

describe("ActionRequest", () => {
  it("fromRequest", () => {

    const req = mockReq({
      headers: {
        "user-agent": "LookerOutgoingWebhook/7.3.0",
        "x-looker-webhook-id": "123",
        "x-looker-instance": "instanceId1",
      },
    })

    // @ts-ignore
    req.header = (name: string): string | string[] | undefined => req.headers[name]

    const result = ActionRequest.fromRequest(req)
    chai.expect(result.webhookId).to.equal("123")
    chai.expect(result.instanceId).to.equal("instanceId1")
    chai.expect(result.lookerVersion).to.equal(semver.valid("7.3.0"))
    chai.expect(result.lookerVersion).to.not.be.null
  })

  it("fromRequest doesn't skip ", () => {

    const req = mockReq({
      headers: {
        // our internal version scheme including trailing 0s
        "user-agent": "LookerOutgoingWebhook/7.3.00004561",
        "x-looker-webhook-id": "123",
        "x-looker-instance": "instanceId1",
      },
    })

    // @ts-ignore
    req.header = (name: string): string | string[] | undefined => req.headers[name]

    const result = ActionRequest.fromRequest(req)
    chai.expect(result.webhookId).to.equal("123")
    chai.expect(result.instanceId).to.equal("instanceId1")
    chai.expect(result.lookerVersion).to.not.be.null
    chai.expect(result.lookerVersion).to.equal(semver.valid("7.3.4561"))
  })

  it("ActionRequest.suggestedFilename parses formParams if there's no attachment", () => {
    const formats = ["csv", "xlsx", "html", "txt", "json", "json_label", "inline_json", "json_detail"]
    const expectedExtensions = [".csv", ".xlsx", ".html", ".txt", ".json", ".json", ".json", ".json"]

    formats.map((format, i) => {
      const req = mockReq({
        headers: {
          "user-agent": "LookerOutgoingWebhook/7.3.0",
          "x-looker-webhook-id": "123",
          "x-looker-instance": "instanceId1",
        },
        body: {
          form_params: {format},
          scheduled_plan: {title: "Orders by County"},
        },
      })

      // @ts-ignore
      req.header = (name: string): string | string[] | undefined => req.headers[name]

      const result = ActionRequest.fromRequest(req)
      chai.expect(result.suggestedFilename()).to.equal(`Orders by County${expectedExtensions[i]}`)
    })
  })

  it("ActionRequest.completeFilename removes whitespace and adds extension to filename", () => {
    const formats = ["csv", "xlsx", "html", "txt", "pdf"]

    formats.map((format) => {
      const req = mockReq({
        headers: {
          "user-agent": "LookerOutgoingWebhook/7.3.0",
          "x-looker-webhook-id": "123",
          "x-looker-instance": "instanceId1",
        },
        body: {
          form_params: {format, filename: " foo baz bar "},
          scheduled_plan: {title: "Orders by County"},
          attachment: {extension: format},
        },
      })

      // @ts-ignore
      req.header = (name: string): string | string[] | undefined => req.headers[name]

      const result = ActionRequest.fromRequest(req)

      chai.expect(result.completeFilename()).to.equal(`foo_baz_bar.${format}`)
    })

    formats.map((format) => {
      const req = mockReq({
        headers: {
          "user-agent": "LookerOutgoingWebhook/7.3.0",
          "x-looker-webhook-id": "123",
          "x-looker-instance": "instanceId1",
        },
        body: {
          form_params: {format, filename: ` foo baz bar.${format}`},
          scheduled_plan: {title: "Orders by County"},
          attachment: {extension: format},
        },
      })

      // @ts-ignore
      req.header = (name: string): string | string[] | undefined => req.headers[name]

      const result = ActionRequest.fromRequest(req)

      chai.expect(result.completeFilename()).to.equal(`foo_baz_bar.${format}`)
    })

    formats.map((format) => {
      const req = mockReq({
        headers: {
          "user-agent": "LookerOutgoingWebhook/7.3.0",
          "x-looker-webhook-id": "123",
          "x-looker-instance": "instanceId1",
        },
        body: {
          form_params: {format, filename: ` foo baz bar .docx`},
          scheduled_plan: {title: "Orders by County"},
          attachment: {extension: format},
        },
      })

      // @ts-ignore
      req.header = (name: string): string | string[] | undefined => req.headers[name]

      const result = ActionRequest.fromRequest(req)

      chai.expect(result.completeFilename()).to.equal(result.suggestedFilename())
    })
  })

  describe("streamJsonDetail flow control", () => {
    // ~300 KB of rows, so the attachment is streamed in several 64 KB slices.
    const totalRows = 5000
    function largeAttachmentRequest() {
      const request = new ActionRequest()
      const data = []
      for (let i = 0; i < totalRows; i++) {
        data.push({ field: { value: `row-${i}-${"x".repeat(40)}` } })
      }
      request.attachment = {
        dataBuffer: Buffer.from(JSON.stringify({ fields: { dimensions: [] }, data })),
      }
      return request
    }

    it("rejects a malformed payload instead of resolving", async () => {
      const request = new ActionRequest()
      request.attachment = { dataBuffer: Buffer.from('{"fields": {"dimensions": []}, "data": [{"a": ') }
      let rejected: unknown
      try {
        await request.streamJsonDetail({ onRow: () => undefined })
      } catch (e) {
        rejected = e
      }
      chai.expect(rejected).to.be.instanceOf(Error)
      chai.expect((rejected instanceof Error) && rejected.message).to.equal(
        "Failed to parse the json_detail data stream.",
      )
    })

    it("rejects with the abort reason and stops delivering rows", async () => {
      let rows = 0
      let control: StreamFlowControl | undefined
      const streamed = largeAttachmentRequest().streamJsonDetail({
        onFlowControl: (flowControl) => { control = flowControl },
        onRow: () => {
          rows++
          if (rows === 1 && control) {
            control.pause()
          }
        },
      })

      await new Promise((resolve) => setTimeout(resolve, 20))
      const rowsAtAbort = rows
      if (control) {
        control.abort(new Error("stalled"))
      }
      let rejected: unknown
      try {
        await streamed
      } catch (e) {
        rejected = e
      }
      chai.expect((rejected instanceof Error) && rejected.message).to.equal("stalled")
      chai.expect(rows).to.equal(rowsAtAbort)
      chai.expect(rows).to.be.lessThan(totalRows)
    })

    it("streams every row when no flow control is requested", async () => {
      let rows = 0
      await largeAttachmentRequest().streamJsonDetail({ onRow: () => { rows++ } })
      chai.expect(rows).to.equal(totalRows)
    })

    it("stops delivering rows while paused and resumes on request", async () => {
      let rows = 0
      let control: StreamFlowControl | undefined
      const streamed = largeAttachmentRequest().streamJsonDetail({
        onFlowControl: (flowControl) => { control = flowControl },
        onRow: () => {
          rows++
          if (rows === 1 && control) {
            control.pause()
          }
        },
      })

      await new Promise((resolve) => setTimeout(resolve, 50))
      const rowsWhilePaused = rows
      chai.expect(rowsWhilePaused).to.be.greaterThan(0)
      chai.expect(rowsWhilePaused).to.be.lessThan(totalRows)

      await new Promise((resolve) => setTimeout(resolve, 50))
      chai.expect(rows).to.equal(rowsWhilePaused)

      if (control) {
        control.resume()
      }
      await streamed
      chai.expect(rows).to.equal(totalRows)
    })
  })
})
