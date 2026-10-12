import { RudderTrackAction } from "./rudderstack_track"
import { RudderClientFactory, STUB_ANONYMOUS_ID, TestActionOptions } from "./test_rudderstack_helpers"

/** The real RudderTrackAction with fake SDK clients; see test_rudderstack_helpers.ts. */
export class TestRudderTrackAction extends RudderTrackAction {
  constructor(private readonly makeClient: RudderClientFactory, options: TestActionOptions = {}) {
    super()
    this.executeInOwnProcess = false
    if (options.drainTimeoutMs !== undefined) {
      this.drainTimeoutMs = options.drainTimeoutMs
    }
    if (options.sdkSettings) {
      this.sdkSettings = { ...this.sdkSettings, ...options.sdkSettings }
    }
  }

  protected createRudderClient(writeKey: string, dataPlaneUrl: string) {
    return this.makeClient(writeKey, dataPlaneUrl)
  }

  protected generateAnonymousId() {
    return STUB_ANONYMOUS_ID
  }
}
