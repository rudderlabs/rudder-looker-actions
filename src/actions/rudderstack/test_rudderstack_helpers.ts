import { Query } from "../../api_types/query"
import { DeliveryCallback, RudderAction, RudderClient } from "./rudderstack"

export const STUB_ANONYMOUS_ID = "stubanon"

export type RudderClientFactory = (writeKey: string, dataPlaneUrl: string) => RudderClient

/** A client whose calls do nothing unless overridden. */
export function fakeRudderClient(overrides: Partial<RudderClient> = {}): RudderClient {
  return {
    identify: () => undefined,
    track: () => undefined,
    group: () => undefined,
    flush: async () => Promise.resolve(),
    ...overrides,
  }
}

/** A client that acknowledges every event immediately. */
export function ackingRudderClient(overrides: Partial<RudderClient> = {}): RudderClient {
  const ack = (_message: unknown, done: DeliveryCallback) => done()
  return fakeRudderClient({ identify: ack, track: ack, group: ack, ...overrides })
}

export interface TestActionOptions {
  drainTimeoutMs?: number
}

// Each real action class gets a subclass that only swaps in fake SDK clients and a
// fixed anonymous id, so the class's own execute() is what the tests run. None of
// them fork a process, and no protected method needs stubbing. The track and group
// subclasses live in test_rudderstack_track_action.ts and test_rudderstack_group_action.ts.

export class TestRudderIdentifyAction extends RudderAction {
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

/** A minimal Looker query whose visualization hides the given fields. */
export function queryHidingFields(hiddenFields: string[]): Query {
  return {
    can: {},
    id: 1,
    model: "model",
    view: "view",
    fields: null,
    pivots: null,
    fill_fields: null,
    filters: null,
    filter_expression: null,
    sorts: null,
    limit: null,
    column_limit: null,
    total: null,
    row_total: null,
    subtotals: null,
    vis_config: { hidden_fields: hiddenFields },
    filter_config: null,
    visible_ui_sections: null,
    slug: null,
    dynamic_fields: null,
    client_id: null,
    share_url: null,
    expanded_share_url: null,
    url: null,
    query_timezone: null,
    has_table_calculations: false,
  }
}
