import * as express from "express"
import * as fs from "fs"
import * as path from "path"
import * as Raven from "raven"
import * as winston from "winston"
import * as Hub from "../hub"
import {DelegateOAuthAction, isDelegateOauthAction, isOauthAction, OAuthAction} from "../hub"
import * as ExecuteProcessQueue from "../xpc/execute_process_queue"
import * as ExtendedProcessQueue from "../xpc/extended_process_queue"
const expressWinston = require("express-winston")
const uparse = require("url")
const blocked = require("blocked-at")

const statusJsonPath = path.resolve(`${__dirname}/../../status.json`)
const useRaven = () => !!process.env.ACTION_HUB_RAVEN_DSN

// Largest POST body the hub will buffer and parse. The registered actions stream
// their data from Looker's download URL, so a request body carries only the
// scheduled plan, form params and data params, never the query results. 10 MB
// leaves ample headroom while bounding what an anonymous caller can make us parse.
export const POST_BODY_LIMIT_BYTES = 10 * 1024 * 1024

// Shape of the errors body-parser passes to the error middleware: a 4xx `status`
// for a malformed (400), oversized (413) or unsupported-charset (415) body.
interface HttpStatusError {
  status: number
  message: string
}

function isClientHttpError(e: unknown): e is HttpStatusError {
  if (typeof e !== "object" || e === null) {
    return false
  }
  const status: unknown = Reflect.get(e, "status")
  const message: unknown = Reflect.get(e, "message")
  return typeof status === "number" && status >= 400 && status < 500 && typeof message === "string"
}

// Should be used with actions that hold the event loop extensively
const expensiveJobQueue = new ExecuteProcessQueue.ExecuteProcessQueue()
// Should be used with actions that may exist for long periods of time
const extendedJobQueue = new ExtendedProcessQueue.ExtendedProcessQueue()

export default class Server implements Hub.RouteBuilder {

  static run() {

    if (useRaven()) {
      let statusJson: any = {}
      if (fs.existsSync(statusJsonPath)) {
        statusJson = JSON.parse(fs.readFileSync(statusJsonPath).toString())
      }
      Raven.config(process.env.ACTION_HUB_RAVEN_DSN, {
        captureUnhandledRejections: true,
        release: statusJson.git_commit,
        autoBreadcrumbs: false,
        environment: process.env.ACTION_HUB_BASE_URL,
      }).install()
    }

    blocked((time: number, stack: string[]) => {
      winston.warn(`Event loop blocked for ${time}ms, operation started here:\n${stack.join("\n")}`)
    }, {threshold: 100})

    if (!process.env.ACTION_HUB_BASE_URL) {
      throw new Error("No ACTION_HUB_BASE_URL environment variable set.")
    }
    if (!process.env.ACTION_HUB_LABEL) {
      throw new Error("No ACTION_HUB_LABEL environment variable set.")
    }
    if (process.env.ACTION_HUB_DEBUG) {
      winston.configure({
        level: "debug",
        transports: [
          new (winston.transports.Console)(),
        ],
      })
      winston.debug("Debug Mode")
    }

    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080

    // Default to 0 to prevent Node from applying timeout to sockets
    // Load balancers in front of the app may still timeout
    const timeout = process.env.ACTION_HUB_SOCKET_TIMEOUT ? parseInt(process.env.ACTION_HUB_SOCKET_TIMEOUT, 10) : 0

    Server.listen(port, timeout)
  }

  static listen(port: number, timeout: number) {
    const app = new Server().app
    const nodeServer = app.listen(port, () => {
      winston.info(`Action Hub listening!`, {port})
    })
    nodeServer.timeout = timeout
  }

  app: express.Application

  private actionList: {[key: string]: string} = {}

  // Body parser for the POST routes, capped at POST_BODY_LIMIT_BYTES. Mounted per
  // route, so the static mount never buffers or parses a request body.
  private jsonBodyParser: express.RequestHandler = express.json({limit: POST_BODY_LIMIT_BYTES})

  // Small body parser for the OAuth GET routes, so a GET never buffers a large
  // body. Those routes only need req.body to default to {}.
  private oauthJsonParser: express.RequestHandler = express.json({limit: "100kb"})

  constructor() {

    this.app = express()
    this.app.use(expressWinston.logger({
      winstonInstance: winston,
      dynamicMeta: this.requestLog,
      requestFilter(req: {[key: string]: any}, propName: string) {
        if (propName !== "headers") {
          return req[propName]
        }
      },
    }))
    this.app.use(express.static("public"))

    this.route("/", async (req, res) => {
      const request = Hub.ActionRequest.fromRequest(req)
      const version = request.lookerVersion ? request.lookerVersion : "5.5.0"
      if (!this.actionList[version]) {
        const actions = await Hub.allActions({ lookerVersion: request.lookerVersion })
        const response = {
          integrations: actions.map((d) => d.asJson(this, request)),
          label: process.env.ACTION_HUB_LABEL,
        }
        this.actionList[version] = JSON.stringify(response)
      }
      res.type("json")
      res.send(this.actionList[version])
      winston.debug(`version: ${version}, response: ${this.actionList[version]}`)
    })

    this.route("/actions/:actionId", async (req, res) => {
      const request = Hub.ActionRequest.fromRequest(req)
      const action = await Hub.findAction(req.params.actionId, { lookerVersion: request.lookerVersion })
      res.json(action.asJson(this, request))
    })

    this.route("/actions/:actionId/execute", this.jsonKeepAlive(async (req, complete) => {
      const request = Hub.ActionRequest.fromRequest(req)
      const action = await Hub.findAction(req.params.actionId, { lookerVersion: request.lookerVersion })
      const queue = action.extendedAction ? extendedJobQueue : expensiveJobQueue
      const actionResponse = await action.validateAndExecute(request, queue)
      complete(actionResponse.asJson())
    }))

    this.route("/actions/:actionId/form", this.jsonKeepAlive(async (req, complete) => {
      const request = Hub.ActionRequest.fromRequest(req)
      const action = await Hub.findAction(req.params.actionId, { lookerVersion: request.lookerVersion })

      let form
      if (isDelegateOauthAction(action) && request.params.test) {
        form = await (action as DelegateOAuthAction).oauthCheck(request)
      } else if (action.hasForm) {
        form = await action.validateAndFetchForm(request)
      }
      if (form) {
        complete(form.asJson())
      } else {
        throw "No form defined for action."
      }
    }))

    // Initial OAuth flow request from Resource Owner
    this.oauthRoute("/actions/:actionId/oauth", async (req, res) => {
      const request = Hub.ActionRequest.fromRequest(req)
      const action = await Hub.findAction(req.params.actionId, { lookerVersion: request.lookerVersion })
      if (isOauthAction(action)) {
        const parts = uparse.parse(req.url, true)
        const state = parts.query.state
        const url = await (action as OAuthAction).oauthUrl(this.oauthRedirectUrl(action), state)
        res.redirect(url)
      } else {
        throw "Action does not support OAuth."
      }
    })

    this.oauthRoute("/actions/:actionId/oauth_check", async (req, res) => {
      const request = Hub.ActionRequest.fromRequest(req)
      const action = await Hub.findAction(req.params.actionId, {lookerVersion: request.lookerVersion})
      if (isOauthAction(action)) {
        const check = (action as OAuthAction).oauthCheck(request)
        res.json(check)
      } else {
        res.statusCode = 404
      }
    })

    // Response from Authorization Server with response from OAuth flow
    this.oauthRoute("/actions/:actionId/oauth_redirect", async (req, res) => {
      const request = Hub.ActionRequest.fromRequest(req)
      const action = await Hub.findAction(req.params.actionId, { lookerVersion: request.lookerVersion })
      if (isOauthAction(action)) {
        try {
          await (action as OAuthAction).oauthFetchInfo(req.query as {[key: string]: string},
              this.oauthRedirectUrl(action))
          res.statusCode = 200
          res.send(`<html><script>window.close()</script>><body>You may now close this tab.</body></html>`)
        } catch (e: any) {
          this.logPromiseFail(req, res, e)
          res.statusCode = 400
        }
      } else {
        throw "Action does not support OAuth."
      }
    })

    // To provide a health or version check endpoint you should place a status.json file
    // into the project root, which will get served by this endpoint (or 404 otherwise).
    this.app.get("/status", (_req, res) => {
      res.sendFile(statusJsonPath)
    })

    // Must be registered after all routes so it catches errors they throw.
    // Bound so Express keeps its 4-arg arity (how it detects an error handler).
    this.app.use(this.handleError.bind(this))

  }

  actionUrl(action: Hub.Action) {
    return this.absUrl(`/actions/${encodeURIComponent(action.name)}/execute`)
  }

  formUrl(action: Hub.Action) {
    return this.absUrl(`/actions/${encodeURIComponent(action.name)}/form`)
  }

  private oauthRedirectUrl(action: Hub.Action) {
    return this.absUrl(`/actions/${encodeURIComponent(action.name)}/oauth_redirect`)
  }
  /**
   * For JSON responses that take a long time without sending any data,
   * we periodically send a newline character to prevent the connection from being
   * dropped by proxies or other services (like the AWS NAT Gateway).
   */
  private jsonKeepAlive(fn: (req: express.Request, complete: (data: any) => void) => Promise<void>):
  (req: express.Request, res: express.Response) => Promise<void> {
    const interval = process.env.ACTION_HUB_JSON_KEEPALIVE_SEC ?
        parseInt(process.env.ACTION_HUB_JSON_KEEPALIVE_SEC, 10)
      :
        30
    return async (req, res) => {
      res.status(200)
      res.setHeader("Content-Type", "application/json")
      const timer = setInterval(() => {
        res.write("\n")
      }, interval * 1000)
      try {
        await fn(req, (data) => {
          res.write(JSON.stringify(data))
          res.end()
        })
      } finally {
        clearInterval(timer)
      }
    }
  }

  // Wraps an async handler so a rejected promise is forwarded to the error
  // middleware (this.handleError) rather than becoming an unhandled rejection
  // that crashes the process.
  private asyncHandler(fn: (req: express.Request, res: express.Response) => Promise<void>): express.RequestHandler {
    return (req, res, next) => {
      fn(req, res).catch(next)
    }
  }

  private route(urlPath: string, fn: (req: express.Request, res: express.Response) => Promise<void>): void {
    this.app.post(urlPath, this.jsonBodyParser, this.asyncHandler(async (req, res) => {
      this.logInfo(req, res, "Starting request.")
      await fn(req, res)
    }))
  }

  // Registers an OAuth GET route with the small body parser and crash-safe
  // error handling.
  private oauthRoute(urlPath: string, fn: (req: express.Request, res: express.Response) => Promise<void>): void {
    this.app.get(urlPath, this.oauthJsonParser, this.asyncHandler(fn))
  }

  // Error-handling middleware. Sends errors thrown by async handlers through
  // Express instead of letting them become process-killing unhandled rejections.
  // Registered as the last middleware in the constructor.
  private handleError(e: any, req: express.Request, res: express.Response, _next: express.NextFunction): void {
    this.logError(req, res, "Error on request")
    if (isClientHttpError(e)) {
      // A rejected request body (malformed, oversized or wrong charset) is the
      // caller's fault: answer with its 4xx and keep it out of Raven.
      if (!res.headersSent) {
        res.status(e.status)
        res.json({success: false, error: e.message})
      }
      this.logError(req, res, e.message)
    } else if (typeof(e) === "string") {
      if (!res.headersSent) {
        res.status(404)
        res.json({success: false, error: e})
      }
      this.logError(req, res, e)
    } else {
      if (!res.headersSent) {
        res.status(500)
        res.json({ success: false, error: "Internal server error." })
      }
      this.logError(req, res, e)
      if (useRaven()) {
        // Typed as {} to satisfy Raven's tags index signature, as the original did.
        const ravenTags: {} = this.requestLog(req, res)
        Raven.captureException(e, { tags: ravenTags })
      }
    }
  }

  private logPromiseFail(req: express.Request, res: express.Response, e: any) {
    this.logError(req, res, "Error on request")
    if (typeof (e) === "string") {
      res.status(404)
      res.json({ success: false, error: e })
      this.logError(req, res, e)
    } else {
      res.status(500)
      res.json({ success: false, error: "Internal server error." })
      this.logError(req, res, e)
    }
  }

  private logInfo(req: express.Request, res: express.Response, message: any, options: any = {}) {
    winston.info(message, {
      ...options,
      ...this.requestLog(req, res),
    })
  }

  private logError(req: express.Request, res: express.Response, message: any, options: any = {}) {
    winston.error(message, {
      ...options,
      ...this.requestLog(req, res),
    })
  }

  private requestLog(req: express.Request, res: express.Response) {
    return {
      url: req.url,
      ip: req.ip,
      statusCode: res.statusCode,
      instanceId: req.header("x-looker-instance"),
      webhookId: req.header("x-looker-webhook-id"),
    }
  }

  private absUrl(rootRelativeUrl: string) {
    return `${process.env.ACTION_HUB_BASE_URL}${rootRelativeUrl}`
  }

}
