import { RudderGroupAction } from "./rudderstack_group"
import { RudderClientFactory, STUB_ANONYMOUS_ID, TestActionOptions } from "./test_rudderstack_helpers"

/** The real RudderGroupAction with fake SDK clients; see test_rudderstack_helpers.ts. */
export class TestRudderGroupAction extends RudderGroupAction {
  constructor(private readonly makeClient: RudderClientFactory, options: TestActionOptions = {}) {
    super()
    this.executeInOwnProcess = false
    if (options.drainTimeoutMs !== undefined) {
      this.drainTimeoutMs = options.drainTimeoutMs
    }
  }

  protected createRudderClient(writeKey: string, dataPlaneUrl: string) {
    return this.makeClient(writeKey, dataPlaneUrl)
  }

  protected generateAnonymousId() {
    return STUB_ANONYMOUS_ID
  }
}
