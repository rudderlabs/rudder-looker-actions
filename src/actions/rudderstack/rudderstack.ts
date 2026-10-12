import Analytics = require("@rudderstack/rudder-sdk-node")
import * as semver from "semver"
import * as util from "util"
import * as uuid from "uuid"
import * as winston from "winston"
import * as Hub from "../../hub"
import {
  describeDeliveryError,
  RudderDeliveryTracker,
} from "./rudderstack_delivery_tracker"
import { RudderActionError } from "./rudderstack_error"

const DATA_PLANE_BATCH_PATH = "/v1/batch"
const INVALID_DATA_PLANE_URL_MESSAGE =
  "Rudder Data Plane URL must be a valid https URL."
// The SDK silently drops events once this many are queued in a single client.
const SDK_MAX_INTERNAL_QUEUE_SIZE = 20000
// Upper bound for RUDDER_SDK_MAX_PENDING_EVENTS. Pausing the stream takes effect
// between chunks, so rows already parsed from the current chunk (at most ~64 KB,
// i.e. a few thousand of the smallest possible rows) still arrive after a pause.
// Keeping the limit at half the SDK's drop threshold leaves room for that overshoot
// even with a single client.
const MAX_PENDING_EVENTS_CAP = SDK_MAX_INTERNAL_QUEUE_SIZE / 2
// While events are pending, queued events are flushed at this interval so batches
// smaller than flushAt don't wait for the SDK's own 10s flush timer.
const PENDING_FLUSH_INTERVAL_MS = 500
// Hash modulus for client routing; keeps the running hash within safe integers.
const ROUTING_HASH_MODULUS = 2147483647
// Backstop for waiting on delivery callbacks once streaming has ended. Requests
// already time out on their own; this guarantees the action always responds.
const DRAIN_TIMEOUT_MS = 5 * 60 * 1000

// The SDK reads `timeout` (ms, per request) at runtime, but its type declarations
// omit it.
interface RudderClientOptions extends Analytics.constructorOptions {
  timeout?: number
}

export type DeliveryCallback = (error?: Error) => void

/** The subset of the SDK client the action uses. */
export interface RudderClient {
  identify(message: Analytics.IdentifyParams, callback: DeliveryCallback): unknown
  track(message: Analytics.TrackParams, callback: DeliveryCallback): unknown
  group(message: Analytics.GroupParams, callback: DeliveryCallback): unknown
  flush(): Promise<void>
}

export interface RudderSdkSettings {
  flushAt: number
  clientPoolSize: number
  maxPendingEvents: number
  requestTimeoutMs: number
}

export const DEFAULT_RUDDER_SDK_SETTINGS: RudderSdkSettings = {
  flushAt: 100,
  clientPoolSize: 8,
  maxPendingEvents: 1600,
  requestTimeoutMs: 30000,
}

function readPositiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name]
  if (raw === undefined || raw.trim() === "") {
    return fallback
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    winston.warn(`[Rudder] ignoring invalid ${name}="${raw}", using ${fallback}`)
    return fallback
  }
  return value
}

/**
 * Reads SDK delivery settings from the environment. Invalid values are logged
 * and replaced with safe values rather than failing the action.
 */
export function parseRudderSdkSettings(
  env: NodeJS.ProcessEnv,
): RudderSdkSettings {
  const flushAt = readPositiveInteger(
    env,
    "RUDDER_SDK_FLUSH_AT",
    DEFAULT_RUDDER_SDK_SETTINGS.flushAt,
  )
  const clientPoolSize = readPositiveInteger(
    env,
    "RUDDER_SDK_CLIENT_POOL_SIZE",
    DEFAULT_RUDDER_SDK_SETTINGS.clientPoolSize,
  )
  let maxPendingEvents = readPositiveInteger(
    env,
    "RUDDER_SDK_MAX_PENDING_EVENTS",
    DEFAULT_RUDDER_SDK_SETTINGS.maxPendingEvents,
  )
  const requestedMaxPendingEvents = maxPendingEvents
  const adjustmentReasons: string[] = []
  // Each client should be able to fill a batch before the stream pauses.
  const fullBatchesPending = flushAt * clientPoolSize
  if (maxPendingEvents < fullBatchesPending) {
    maxPendingEvents = fullBatchesPending * 2
    adjustmentReasons.push(
      `below flushAt x clientPoolSize (${fullBatchesPending})`,
    )
  }
  // A client's queue only holds pending events, so keeping the total pending (plus
  // the post-pause overshoot) below the SDK's silent-drop threshold guarantees no
  // client ever drops an event without calling its callback.
  if (maxPendingEvents > MAX_PENDING_EVENTS_CAP) {
    maxPendingEvents = MAX_PENDING_EVENTS_CAP
    adjustmentReasons.push(
      `capped at ${MAX_PENDING_EVENTS_CAP} to leave headroom below ` +
        `the SDK queue limit (${SDK_MAX_INTERNAL_QUEUE_SIZE})`,
    )
  }
  if (adjustmentReasons.length > 0) {
    winston.warn(
      `[Rudder] RUDDER_SDK_MAX_PENDING_EVENTS=${requestedMaxPendingEvents} adjusted to ` +
        `${maxPendingEvents}: ${adjustmentReasons.join("; ")}`,
    )
  }
  const requestTimeoutMs = readPositiveInteger(
    env,
    "RUDDER_SDK_REQUEST_TIMEOUT_MS",
    DEFAULT_RUDDER_SDK_SETTINGS.requestTimeoutMs,
  )
  return { flushAt, clientPoolSize, maxPendingEvents, requestTimeoutMs }
}

const RUDDER_SDK_SETTINGS = parseRudderSdkSettings(process.env)

/**
 * Returns the data plane base URL the SDK expects. The SDK appends `/v1/batch`
 * itself, so a configured URL that already ends with it is trimmed.
 */
export function normalizeDataPlaneUrl(raw: string | undefined): string {
  let normalized = (raw === undefined ? "" : raw).trim().replace(/\/+$/, "")
  if (normalized.endsWith(DATA_PLANE_BATCH_PATH)) {
    normalized = normalized
      .slice(0, -DATA_PLANE_BATCH_PATH.length)
      .replace(/\/+$/, "")
  }
  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch (_e) {
    throw new RudderActionError(INVALID_DATA_PLANE_URL_MESSAGE)
  }
  // The write key travels as Basic auth on every request, so plain http is refused.
  if (parsed.protocol !== "https:") {
    throw new RudderActionError(INVALID_DATA_PLANE_URL_MESSAGE)
  }
  return normalized
}

/**
 * Picks the pool client for an event. The same routing key always maps to the
 * same client, so one user's events go through one client's queue, as they did
 * with a single client. Arrival order is not guaranteed: a client can have
 * several batches in flight at once.
 */
export function pickClientIndex(routingKey: string, poolSize: number): number {
  let hash = 5381
  for (let i = 0; i < routingKey.length; i++) {
    hash = (hash * 33 + routingKey.charCodeAt(i)) % ROUTING_HASH_MODULUS
  }
  return hash % poolSize
}

/**
 * Waits for `work` to settle or for `timeoutMs` to pass, whichever is first.
 * Work that runs past the timeout carries on in the background.
 */
async function settlesWithin(work: Promise<void>, timeoutMs: number) {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
  })
  try {
    await Promise.race([work, timeout])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

interface RudderFields {
  idFieldNames: string[]
  idField?: Hub.Field
  userIdField?: Hub.Field
  groupIdField?: Hub.Field
  emailField?: Hub.Field
  anonymousIdField?: Hub.Field
}

export enum RudderTags {
  UserId = "user_id",
  RudderAnonymousId = "rudder_anonymous_id",
  Email = "email",
  RudderGroupId = "rudder_group_id",
}

export enum RudderCalls {
  Identify = "identify",
  Track = "track",
  Group = "group",
}

export class RudderAction extends Hub.Action {
  allowedTags = [
    RudderTags.Email,
    RudderTags.UserId,
    RudderTags.RudderAnonymousId,
  ]

  name = "rudder_event"
  label = "Rudder Identify"
  iconName = "rudderstack/rudderstack.svg"
  description = "Add traits via identify to your Rudder users."
  params = [
    {
      description: "Looker source write key for Rudder.",
      label: "Rudder Write Key",
      name: "rudder_write_key",
      required: true,
      sensitive: true,
    },
    {
      description: "Give your Rudder server URL",
      label: "Rudder Data Plane URL",
      name: "rudder_server_url",
      required: true,
      sensitive: false,
    },
  ]
  minimumSupportedLookerVersion = "4.20.0"
  supportedActionTypes = [Hub.ActionType.Query]
  usesStreaming = true
  supportedFormattings = [Hub.ActionFormatting.Unformatted]
  supportedVisualizationFormattings = [
    Hub.ActionVisualizationFormatting.Noapply,
  ]
  requiredFields = [{ any_tag: this.allowedTags }]
  executeInOwnProcess = true
  protected drainTimeoutMs = DRAIN_TIMEOUT_MS
  protected sdkSettings: RudderSdkSettings = RUDDER_SDK_SETTINGS
  supportedFormats = (request: Hub.ActionRequest) => {
    if (request.lookerVersion && semver.gte(request.lookerVersion, "6.2.0")) {
      return [Hub.ActionFormat.JsonDetailLiteStream]
    } else {
      return [Hub.ActionFormat.JsonDetail]
    }
  }

  async execute(request: Hub.ActionRequest) {
    return this.executeRudder(request, RudderCalls.Identify)
  }

  protected async executeRudder(
    request: Hub.ActionRequest,
    rudderCall: RudderCalls,
  ) {
    const writeKey = request.params.rudder_write_key
    if (!writeKey) {
      return this.buildResponse([
        new RudderActionError("Rudder Write Key is required."),
      ])
    }
    let dataPlaneUrl: string
    try {
      dataPlaneUrl = normalizeDataPlaneUrl(request.params.rudder_server_url)
    } catch (e) {
      return this.buildResponse([toError(e)])
    }

    const clients = Array.from(
      { length: this.sdkSettings.clientPoolSize },
      () => this.createRudderClient(writeKey, dataPlaneUrl),
    )
    // A stream paused with no delivery progress for the drain timeout is aborted.
    const tracker = new RudderDeliveryTracker(
      this.sdkSettings.maxPendingEvents,
      this.drainTimeoutMs,
    )

    let hiddenFields: string[] = []
    if (
      request.scheduledPlan &&
      request.scheduledPlan.query &&
      request.scheduledPlan.query.vis_config &&
      request.scheduledPlan.query.vis_config.hidden_fields
    ) {
      hiddenFields = request.scheduledPlan.query.vis_config.hidden_fields
    }

    let rudderFields: RudderFields | undefined
    let fieldset: Hub.Field[] = []
    const errors: Error[] = []

    let timestamp = new Date()
    const context = {
      app: {
        name: "looker/actions",
        version: process.env.APP_VERSION ? process.env.APP_VERSION : "dev",
      },
    }
    const event = request.formParams.event

    const startedAt = Date.now()
    let totalRows = 0
    // Skips a tick while the previous timer flush is still waiting on a slow
    // request, so ticks don't pile up flush calls that all fire at once.
    let flushInProgress = false
    const pendingFlushTimer = setInterval(async () => {
      if (flushInProgress || tracker.pending === 0) {
        return
      }
      flushInProgress = true
      try {
        await this.flushClients(clients)
      } finally {
        flushInProgress = false
      }
    }, PENDING_FLUSH_INTERVAL_MS)

    try {
      await request.streamJsonDetail({
        onFlowControl: (control) => {
          tracker.setFlowControl(control)
        },
        onFields: (fields) => {
          fieldset = Hub.allFields(fields)
          rudderFields = this.rudderFields(fieldset)
          winston.debug(`[Rudder] fieldset :  ${JSON.stringify(fieldset)}`)
          winston.debug(
            `[Rudder] RudderFields : ${JSON.stringify(rudderFields)}`,
          )
          this.unassignedRudderFieldsCheck(rudderFields)
        },
        onRanAt: (iso8601string) => {
          if (iso8601string) {
            timestamp = new Date(iso8601string)
          }
        },
        onRow: (row) => {
          totalRows = totalRows + 1
          winston.debug(`[Rudder] row : ${JSON.stringify(row)}`)
          this.unassignedRudderFieldsCheck(rudderFields)
          const payload = {
            ...this.prepareRudderTraitsFromRow(
              row,
              fieldset,
              rudderFields!,
              hiddenFields,
              rudderCall === RudderCalls.Track,
            ),
            ...{ event, context, timestamp },
          }
          if (payload.groupId === null) {
            delete payload.groupId
          }
          if (!payload.event) {
            delete payload.event
          }
          const client =
            clients[
              pickClientIndex(
                this.routingKey(payload.userId, payload.anonymousId),
                clients.length,
              )
            ]
          tracker.markSent()
          try {
            client[rudderCall](payload, tracker.onEventDone)
          } catch (e) {
            tracker.revertSent()
            errors.push(toError(e))
          }
        },
      })
    } catch (e) {
      if (tracker.stalled) {
        // Like delivery failures, a stall doesn't fail the action: a rerun would
        // resend every row. Rows not yet read are never sent, so it is logged.
        winston.warn(
          `[Rudder] delivery stalled: no delivery result for ${this.drainTimeoutMs}ms ` +
            `while paused; stopped streaming after ${totalRows} rows`,
          { webhookId: request.webhookId },
        )
      } else {
        winston.error(`[Rudder] error in Rudder action execution : ${e}`)
        errors.push(toError(e))
      }
    }

    // Events already handed to the SDK are delivered (or fail) even if streaming
    // stopped early, so wait for every callback before responding, up to a limit.
    let unconfirmed = 0
    try {
      // One deadline covers both the final flush and the wait for callbacks, so a
      // slow or stuck flush can't push the response past the drain timeout.
      const deadline = Date.now() + this.drainTimeoutMs
      await settlesWithin(this.flushClients(clients), this.drainTimeoutMs)
      const drained = await tracker.waitForDrain(
        Math.max(0, deadline - Date.now()),
      )
      if (!drained) {
        unconfirmed = tracker.pending
      }
    } finally {
      clearInterval(pendingFlushTimer)
      tracker.stop()
    }

    winston.info("[Rudder] execute summary", {
      webhookId: request.webhookId,
      rows: totalRows,
      sent: tracker.sent,
      acked: tracker.acked,
      failed: tracker.failed,
      unconfirmed,
      streamStopped: tracker.stalled,
      durationMs: Date.now() - startedAt,
      ...this.sdkSettings,
    })

    if (unconfirmed > 0) {
      winston.warn(
        `[Rudder] ${unconfirmed} of ${tracker.sent} events had no delivery result ` +
          `${this.drainTimeoutMs}ms after streaming ended; reported as unconfirmed`,
        { webhookId: request.webhookId },
      )
    }

    // Delivery failures don't fail the action, matching the previous behaviour;
    // they are logged so they can be alerted on.
    if (tracker.failed > 0) {
      winston.warn(
        `[Rudder] ${tracker.acked} of ${tracker.sent} events sent to RudderStack; ` +
          `${tracker.failed} failed (first errors: ${tracker.errorMessages.join("; ")})`,
        { webhookId: request.webhookId },
      )
    }
    return this.buildResponse(errors)
  }

  protected buildResponse(errors: Error[]) {
    if (errors.length > 0) {
      let msg = errors.map((e) => (e.message ? e.message : e)).join(", ")
      if (msg.length === 0) {
        msg = "An unknown error occurred while processing the Rudder action."
        winston.warn(
          `[Rudder] Can't format Rudder errors: ${util.inspect(errors)}`,
        )
      }
      winston.error(`[Rudder] total errors : ${msg}`)
      return new Hub.ActionResponse({ success: false, message: msg })
    } else {
      winston.debug("[Rudder] no errors in Rudder action execution")
      return new Hub.ActionResponse({ success: true })
    }
  }

  protected unassignedRudderFieldsCheck(
    rudderFields: RudderFields | undefined,
  ) {
    if (!(rudderFields && rudderFields.idFieldNames.length > 0)) {
      throw new RudderActionError(
        `Query requires a field tagged ${this.allowedTags.join(" or ")}.`,
      )
    }
  }

  protected taggedFields(fields: Hub.Field[], tags: string[]) {
    return fields.filter(
      (f) =>
        f.tags &&
        f.tags.length > 0 &&
        f.tags.some((t: string) => tags.indexOf(t) !== -1),
    )
  }

  protected taggedField(fields: any[], tags: string[]): Hub.Field | undefined {
    return this.taggedFields(fields, tags)[0]
  }

  protected rudderFields(fields: Hub.Field[]): RudderFields {
    const idFieldNames = this.taggedFields(fields, [
      RudderTags.Email,
      RudderTags.RudderAnonymousId,
      RudderTags.UserId,
      RudderTags.RudderGroupId,
    ]).map((f: Hub.Field) => f.name)

    return {
      idFieldNames,
      idField: this.taggedField(fields, [
        RudderTags.UserId,
        RudderTags.RudderAnonymousId,
      ]),
      userIdField: this.taggedField(fields, [RudderTags.UserId]),
      groupIdField: this.taggedField(fields, [RudderTags.RudderGroupId]),
      emailField: this.taggedField(fields, [RudderTags.Email]),
      anonymousIdField: this.taggedField(fields, [
        RudderTags.RudderAnonymousId,
      ]),
    }
  }

  // Removes JsonDetail Cell metadata and only sends relevant nested data to Rudder
  // See JsonDetail.ts to see structure of a JsonDetail Row
  protected filterJson(
    jsonRow: any,
    rudderFields: RudderFields,
    fieldName: string,
  ) {
    const pivotValues: any = {}
    pivotValues[fieldName] = []
    const filterFunction = (currentObject: any, name: string) => {
      const returnVal: any = {}
      if (Object(currentObject) === currentObject) {
        for (const key in currentObject) {
          if (currentObject.hasOwnProperty(key)) {
            if (key === "value") {
              returnVal[name] = currentObject[key]
              return returnVal
            } else if (rudderFields.idFieldNames.indexOf(key) === -1) {
              const res = filterFunction(currentObject[key], key)
              if (Object.keys(res).length > 0) {
                pivotValues[fieldName].push(res)
              }
            }
          }
        }
      }
      return returnVal
    }
    filterFunction(jsonRow, fieldName)
    return pivotValues
  }

  protected prepareRudderTraitsFromRow(
    row: Hub.JsonDetail.Row,
    fields: Hub.Field[],
    rudderFields: RudderFields,
    hiddenFields: string[],
    trackCall: boolean,
  ) {
    const traits: { [key: string]: string } = {}
    for (const field of fields) {
      if (rudderFields.idFieldNames.indexOf(field.name) === -1) {
        if (hiddenFields.indexOf(field.name) === -1) {
          let values: any = {}
          if (!row.hasOwnProperty(field.name)) {
            winston.error(
              "[Rudder] Field name does not exist for Rudder action",
            )
            throw new RudderActionError(
              `Field id ${field.name} does not exist for JsonDetail.Row`,
            )
          }
          if (row[field.name].value) {
            values[field.name] = row[field.name].value
          } else {
            values = this.filterJson(row[field.name], rudderFields, field.name)
          }
          for (const key in values) {
            if (values.hasOwnProperty(key)) {
              traits[key] = values[key]
            }
          }
        }
      }
      if (
        rudderFields.emailField &&
        field.name === rudderFields.emailField.name
      ) {
        traits.email = row[field.name].value
      }
    }
    let userId: string | null = rudderFields.idField
      ? row[rudderFields.idField.name].value
      : null
    if (rudderFields.userIdField) {
      userId = row[rudderFields.userIdField.name].value
    } else {
      userId = null
    }
    let anonymousId: string | null
    if (rudderFields.anonymousIdField) {
      anonymousId = row[rudderFields.anonymousIdField.name].value
    } else {
      anonymousId = userId ? null : this.generateAnonymousId()
    }
    const groupId: string | null = rudderFields.groupIdField
      ? row[rudderFields.groupIdField.name].value
      : null

    const dimensionName = trackCall ? "properties" : "traits"

    const rudderRow: any = {
      userId,
      anonymousId,
      groupId,
    }
    rudderRow[dimensionName] = traits
    return rudderRow
  }

  protected createRudderClient(
    writeKey: string,
    dataPlaneUrl: string,
  ): RudderClient {
    const options: RudderClientOptions = {
      dataPlaneUrl,
      flushAt: this.sdkSettings.flushAt,
      // Without a timeout a stalled connection never settles, so its events never
      // get a delivery callback.
      timeout: this.sdkSettings.requestTimeoutMs,
      // Failures are counted through each event's callback. Without a handler the
      // SDK rethrows them from flush() as unhandled rejections, crashing the process.
      errorHandler: (error: unknown) => {
        winston.warn(
          `[Rudder] batch delivery failed: ${describeDeliveryError(error)}`,
        )
      },
    }
    return new Analytics(writeKey, options)
  }

  protected async flushClients(clients: RudderClient[]) {
    await Promise.all(
      clients.map((client) =>
        client.flush().catch((error: unknown) => {
          winston.warn(`[Rudder] flush failed: ${describeDeliveryError(error)}`)
        }),
      ),
    )
  }

  protected routingKey(
    userId: string | null | undefined,
    anonymousId: string | null | undefined,
  ): string {
    if (userId) {
      return userId
    }
    if (anonymousId) {
      return anonymousId
    }
    return ""
  }

  protected generateAnonymousId() {
    return uuid.v4()
  }
}

Hub.addAction(new RudderAction())
