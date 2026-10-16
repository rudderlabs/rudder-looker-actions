import * as express from "express"
import * as oboe from "oboe"
import * as httpRequest from "request"
import * as semver from "semver"
import { PassThrough, Readable } from "stream"
import * as winston from "winston"
import { formatToFileExtension, truncateString } from "./utils"

const sanitizeFilename = require("sanitize-filename")

import {
  DataWebhookPayload,
  DataWebhookPayloadType as ActionType,
} from "../api_types/data_webhook_payload"
import { DataWebhookPayloadScheduledPlanType } from "../api_types/data_webhook_payload_scheduled_plan"
import {
  IntegrationSupportedDownloadSettings as ActionDownloadSettings,
  IntegrationSupportedFormats as ActionFormat,
  IntegrationSupportedFormattings as ActionFormatting,
  IntegrationSupportedVisualizationFormattings as ActionVisualizationFormatting,
} from "../api_types/integration"
import { Query } from "../api_types/query"
import { Fieldset } from "./index"
import { Row as JsonDetailRow } from "./json_detail"

export {
  ActionType,
  ActionFormat,
  ActionFormatting,
  ActionVisualizationFormatting,
  ActionDownloadSettings,
}

export interface ParamMap {
  [name: string]: string | undefined
}

/**
 * Lets an action slow down the incoming data stream when it cannot keep up,
 * e.g. while it waits for outbound requests to complete.
 */
export interface StreamFlowControl {
  pause(): void
  resume(): void
  /** Stops reading the stream; the streaming call rejects with `reason`. */
  abort(reason: Error): void
}

// Attachment data is written to the stream in slices of this size so that a
// paused stream takes effect between slices rather than after the whole payload.
const ATTACHMENT_STREAM_CHUNK_BYTES = 64 * 1024
const JSON_DETAIL_PARSE_ERROR_MESSAGE = "Failed to parse the json_detail data stream."

export interface ActionAttachment {
  dataBuffer?: Buffer
  encoding?: BufferEncoding
  dataJSON?: any
  mime?: string
  fileExtension?: string
}

export interface ActionScheduledPlan {
  /** ID of the scheduled plan */
  scheduledPlanId?: number | null
  /** Title of the scheduled plan. */
  title?: string | null
  /** Type of content of the scheduled plan. Valid values are: "Look", "Dashboard". */
  type?: DataWebhookPayloadScheduledPlanType
  /** URL of the content item in Looker. */
  url?: string | null
  /** ID of the query that the data payload represents. */
  queryId?: number | null
  /** Query that was run (not available for dashboards) */
  query?: Query | null
  /** A boolean representing whether this schedule payload has customized the filter values. */
  filtersDifferFromLook?: boolean
  /** A string to be included in scheduled integrations if this scheduled plan is a download query */
  downloadUrl?: string | null
  /** A string to be included in scheduled integrations if this scheduled plan is an async action */
  asyncCallbackUrl?: string | null
}

export class ActionRequest {

  static fromRequest(request: express.Request) {
    const actionRequest = this.fromJSON(request.body)
    actionRequest.instanceId = request.header("x-looker-instance")
    actionRequest.webhookId = request.header("x-looker-webhook-id")
    const userAgent = request.header("user-agent")
    if (userAgent) {
      const version = userAgent.split("LookerOutgoingWebhook/")[1]
      actionRequest.lookerVersion = semver.valid(version, true)
    }
    return actionRequest
  }

  // Used to turn json back into an actionRequest
  static fromIPC(json: any) {
    const actionRequest = new ActionRequest()
    Object.assign(actionRequest, json)
    if (actionRequest.attachment && actionRequest.attachment.dataBuffer) {
        actionRequest.attachment.dataBuffer = Buffer.from(json.attachment.dataBuffer)
    }
    return actionRequest
  }

  static fromJSON(json?: DataWebhookPayload) {

    if (!json) {
      throw "Request body must be valid JSON."
    }

    const request = new ActionRequest()

    if (json.type === null) {
      throw `Action did not specify a "type".`
    } else {
      request.type = json.type
    }

    if (json.attachment) {
      request.attachment = {}
      request.attachment.mime = json.attachment.mimetype!
      request.attachment.fileExtension = json.attachment.extension!
      if (request.attachment.mime && json.attachment.data) {
        if (json.attachment.data) {
          request.attachment.encoding = request.attachment.mime.endsWith(";base64") ? "base64" : "utf8"
          request.attachment.dataBuffer = Buffer.from(json.attachment.data, request.attachment.encoding)

          if (request.attachment.mime === "application/json") {
            request.attachment.dataJSON = JSON.parse(json.attachment.data)
          }
        }
      }
    }

    if (json.scheduled_plan) {
      request.scheduledPlan = {
        filtersDifferFromLook: json.scheduled_plan.filters_differ_from_look,
        queryId: json.scheduled_plan.query_id,
        query: json.scheduled_plan.query,
        scheduledPlanId: json.scheduled_plan.scheduled_plan_id,
        title: json.scheduled_plan.title,
        type: json.scheduled_plan.type,
        url: json.scheduled_plan.url,
        downloadUrl: json.scheduled_plan.download_url,
        asyncCallbackUrl: json.scheduled_plan.async_callback_url,
      }
    }

    if (json.data) {
      request.params = json.data
    }

    if (json.form_params) {
      request.formParams = json.form_params
    }

    return request
  }

  attachment?: ActionAttachment
  formParams: ParamMap = {}
  params: ParamMap = {}
  scheduledPlan?: ActionScheduledPlan
  type!: ActionType
  actionId?: string
  instanceId?: string
  webhookId?: string
  lookerVersion: string | null = null

  empty(): boolean {
    const url = !this.scheduledPlan || !this.scheduledPlan.downloadUrl
    const buffer = !this.attachment || !this.attachment.dataBuffer
    return url && buffer
  }

  /** `stream` creates and manages a stream of the request data
   *
   * ```ts
   * let prom = await request.stream(async (readable) => {
   *    return myService.uploadStreaming(readable).promise()
   * })
   * ```
   *
   * Streaming generally occurs only if Looker sends the data in a streaming fashion via a push url,
   * however it will also wrap non-streaming attachment data so that actions only need a single implementation.
   *
   * @returns A promise returning the same value as the callback's return value.
   * This promise will resolve after the stream has completed and the callback's promise
   * has also resolved.
   * @param callback A function will be caled with a Node.js `Readable` object.
   * The readable object represents the streaming data.
   */
  async stream<T>(callback: (readable: Readable) => Promise<T>): Promise<T> {

    const stream = new PassThrough()
    const returnPromise = callback(stream)
    const timeout = process.env.ACTION_HUB_STREAM_REQUEST_TIMEOUT ?
        parseInt(process.env.ACTION_HUB_STREAM_REQUEST_TIMEOUT, 10)
      :
        13 * 60 * 1000

    const url = this.scheduledPlan && this.scheduledPlan.downloadUrl

    const streamPromise = new Promise<void>((resolve, reject) => {
      if (url) {
        winston.info(`[stream] beginning stream via download url`, this.logInfo)
        let hasResolved = false
        const download = httpRequest.get(url, {timeout})
        download
          .on("error", (err) => {
            if (hasResolved && (err as any).code === "ECONNRESET") {
              winston.info(`[stream] ignoring ECONNRESET that occured after streaming finished`, this.logInfo)
            } else {
              winston.error(`[stream] request stream error`, {
                ...this.logInfo,
                error: err.message,
                stack: err.stack,
              })
              reject(err)
            }
          })
          .on("finish", () => {
            winston.info(`[stream] streaming via download url finished`, this.logInfo)
          })
          .on("socket", (socket) => {
            winston.info(`[stream] setting keepalive on socket`, this.logInfo)
            socket.setKeepAlive(true)
          })
          .on("abort", () => {
            winston.info(`[stream] streaming via download url aborted`, this.logInfo)
          })
          .on("response", () => {
            winston.info(`[stream] got response from download url`, this.logInfo)
          })
          .on("close", () => {
            winston.info(`[stream] request stream closed`, this.logInfo)
          })
          .pipe(stream)
          .on("error", (err) => {
            winston.error(`[stream] PassThrough stream error`, {
              ...this.logInfo,
            })
            reject(err)
          })
          .on("finish", () => {
            winston.info(`[stream] PassThrough stream finished`, this.logInfo)
            resolve()
            hasResolved = true
          })
          .on("close", () => {
            winston.info(`[stream] PassThrough stream closed`, this.logInfo)
            // Closed before the download finished: the consumer destroyed the stream
            // (e.g. an action aborted it), so cancel the download to release its
            // connection and buffers.
            if (!hasResolved) {
              winston.info(`[stream] cancelling download url request`, this.logInfo)
              download.abort()
            }
          })
      } else {
        if (this.attachment && this.attachment.dataBuffer) {
          winston.info(`Using "fake" streaming because request contained attachment data.`, this.logInfo)
          const dataBuffer = this.attachment.dataBuffer
          winston.info(`DataBuffer: ${dataBuffer.length}`)
          for (let offset = 0; offset < dataBuffer.length; offset += ATTACHMENT_STREAM_CHUNK_BYTES) {
            stream.write(dataBuffer.subarray(offset, offset + ATTACHMENT_STREAM_CHUNK_BYTES))
          }
          stream.end()
          resolve()
        } else {
          stream.end()
          reject(
            "startStream was called on an ActionRequest that does not have" +
            "a streaming download url or an attachment. Ensure usesStreaming is set properly on the action.")
        }
      }
    })

    const results = await Promise.all([returnPromise, streamPromise])
        .catch((err: any) => {
          winston.error(`Error caught awaiting for results. Error: ${err.toString()}`, this.logInfo)
          throw err
        })
    return results[0]
  }

  /**
   * A streaming helper for the "json" data format. It handles automatically parsing
   * the JSON in a streaming fashion. You just need to implement a function that will
   * be called for each row.
   *
   * ```ts
   * await request.streamJson((row) => {
   *   // This will be called for each row of data
   * })
   * ```
   *
   * @returns A promise that will be resolved when streaming is complete.
   * @param onRow A function that will be called for each streamed row, with the row as the first argument.
   */
  async streamJson(onRow: (row: { [fieldName: string]: any }) => void) {
    return new Promise<void>((resolve, reject) => {
      let rows = 0
      this.stream(async (readable) => {
        // Decode as UTF-8 here, so a multibyte character split across chunks is
        // reassembled rather than turned into replacement characters.
        readable.setEncoding("utf8")
        oboe(readable)
          .node("![*]", this.safeOboe(readable, reject, (row) => {
            rows++
            onRow(row)
          }))
          .done(() => {
            winston.info(`[streamJson] oboe reports done`, {...this.logInfo, rows})
          })
      }).then(() => {
        winston.info(`[streamJson] complete`, {...this.logInfo, rows})
        resolve()
      }).catch((error) => {
        // This error should not be logged as it could come from an action
        // which might decide to include user information in the error message
        winston.info(`[streamJson] reported an error`, {...this.logInfo, rows})
        reject(error)
      })
    })
  }

  /**
   * A streaming helper for the "json_detail" data format. It handles automatically parsing
   * the JSON in a streaming fashion. You can implement an `onFields` callback to get
   * the field metadata, and an `onRow` callback for each row of data.
   *
   * ```ts
   * await request.streamJsonDetail({
   *   onFields: (fields) => {
   *     // This will be called when fields are available
   *   },
   *   onRow: (row) => {
   *     // This will be called for each row of data
   *   },
   * })
   * ```
   *
   * @returns A promise that will be resolved when streaming is complete.
   * @param callbacks An object consisting of several callbacks that will be called
   * when various parts of the data are parsed. `onFlowControl`, if provided, is called
   * once before parsing starts with controls to pause and resume the incoming stream;
   * rows already parsed from the current chunk may still arrive after a pause.
   */
  async streamJsonDetail(callbacks: {
    onRow: (row: JsonDetailRow) => void,
    onFields?: (fields: Fieldset) => void,
    onRanAt?: (iso8601string: string) => void,
    onFlowControl?: (control: StreamFlowControl) => void,
  }) {
    return new Promise<void>((resolve, reject) => {
      let rows = 0
      this.stream(async (readable) => {
        // Decode as UTF-8 here, so a multibyte character split across chunks is
        // reassembled rather than turned into replacement characters.
        readable.setEncoding("utf8")
        // Resolve only once oboe has parsed the whole document and the stream has
        // ended. The stream can finish while parsed-but-undelivered data is still
        // buffered (e.g. while paused), so waiting on the stream alone could resolve
        // before every row reached onRow; and oboe reports the root value done before
        // it sees any invalid data after it, so waiting on that alone could miss it.
        await new Promise<void>((resolveParsed, rejectParsed) => {
          const parser = oboe(readable)
          let rootParsed = false
          let streamEnded = false
          const resolveIfComplete = () => {
            if (rootParsed && streamEnded) {
              resolveParsed()
            }
          }
          readable.on("end", () => {
            streamEnded = true
            resolveIfComplete()
          })
          if (callbacks.onFlowControl) {
            callbacks.onFlowControl({
              pause: () => { readable.pause() },
              resume: () => { readable.resume() },
              abort: (reason: Error) => {
                winston.info(`[streamJsonDetail] aborted by action`, {...this.logInfo, rows})
                parser.abort()
                readable.destroy()
                rejectParsed(reason)
              },
            })
          }
          parser
            .node("!.data.*", this.safeOboe(readable, reject, (row) => {
              rows++
              callbacks.onRow(row)
            }))
            .node("!.fields", this.safeOboe(readable, reject, (fields) => {
              if (callbacks.onFields) {
                callbacks.onFields(fields)
              }
            }))
            .node("!.ran_at", this.safeOboe(readable, reject, (ranAt) => {
              if (callbacks.onRanAt) {
                callbacks.onRanAt(ranAt)
              }
            }))
            .done(() => {
              winston.info(`[streamJsonDetail] oboe reports done`, {...this.logInfo, rows})
              rootParsed = true
              // No rows can follow the root value, so a stream paused by the caller is
              // resumed to read the rest and reach its end.
              readable.resume()
              resolveIfComplete()
            })
            .fail(() => {
              // oboe's failure report can quote the payload, which may contain user
              // data, so it is replaced with a generic error.
              winston.info(`[streamJsonDetail] oboe reports failure`, {...this.logInfo, rows})
              // Stop reading, as the abort path does, so an unfinished download is
              // cancelled rather than left open (or paused).
              parser.abort()
              readable.destroy()
              rejectParsed(new Error(JSON_DETAIL_PARSE_ERROR_MESSAGE))
            })
        })
      }).then(() => {
        winston.info(`[streamJsonDetail] complete`, {...this.logInfo, rows})
        resolve()
      }).catch((error) => {
        // This error should not be logged as it could come from an action
        // which might decide to include user information in the error message
        winston.info(`[streamJsonDetail] reported an error`, {...this.logInfo, rows})
        reject(error)
      })
    })
  }

  suggestedFilename() {
    if (this.attachment) {
      if (this.scheduledPlan && this.scheduledPlan.title) {
        return sanitizeFilename(`${this.scheduledPlan.title}.${this.attachment.fileExtension}`)
      } else {
        return sanitizeFilename(`looker_file_${Date.now()}.${this.attachment.fileExtension}`)
      }
    } else if (this.formParams.format) {
      if (this.scheduledPlan && this.scheduledPlan.title) {
        return sanitizeFilename(`${this.scheduledPlan.title}.${formatToFileExtension(this.formParams.format)}`)
      } else {
        return sanitizeFilename(`looker_file_${Date.now()}.${formatToFileExtension(this.formParams.format)}`)
      }
    }
    winston.warn("Couldn't infer file extension from action request, using default filename scheme")
    return sanitizeFilename(`looker_file_${Date.now()}`)
  }

  /** Returns filename with whitespace removed and the file extension included
   */
  completeFilename() {
    if (this.attachment && this.formParams.filename) {
      if (this.formParams.filename.endsWith(this.attachment.fileExtension!)) {
        return this.formParams.filename.trim().replace(/\s/g, "_")
      } else if (this.formParams.filename.indexOf(".") !== -1) {
        return this.suggestedFilename()
      } else {
        return `${this.formParams.filename.trim().replace(/\s/g, "_")}.${this.attachment.fileExtension}`
      }
    }
    return this.formParams.filename
  }

  /** creates a truncated message with a max number of lines and max number of characters with Title, Url,
   * and truncated Body of payload
   * @param {number} maxLines - maximum number of lines to truncate message
   * @param {number} maxCharacters - maximum character to truncate
   */
  suggestedTruncatedMessage(maxLines: number, maxCharacters: number)  {
    if (this.attachment && this.attachment.dataBuffer) {
      let title = ""
      let url = ""

      if (this.scheduledPlan) {
        if (this.scheduledPlan.title) {
          title = `${this.scheduledPlan.title}:\n`
        }
        if (this.scheduledPlan.url) {
          url = this.scheduledPlan.url
          title = title + url + "\n"
        }
      }

      const truncatedLines = this.attachment.dataBuffer
          .toString("utf8")
          .split("\n")
          .slice(0, maxLines)
      if (truncatedLines.length === maxLines) {
        truncatedLines.push("")
      }
      const newMessage = truncatedLines.join("\n")
      let body = title + newMessage
      body = truncateString(body, maxCharacters)

      return body
    }
  }

  private get logInfo() {
    return {webhookId: this.webhookId}
  }

  private safeOboe(
    stream: Readable,
    reject: (reason?: any) => void,
    callback: (node: any) => void,
  ) {
    const logInfo = this.logInfo
    return function(this: oboe.Oboe, node: any) {
      try {
        callback(node)
        return oboe.drop
      } catch (e: any) {
        winston.info(`safeOboe callback produced an error, aborting stream`, logInfo)
        this.abort()
        stream.destroy()
        reject(e)
      }
    }
  }

}
