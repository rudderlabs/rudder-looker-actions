import * as Hub from "../../hub"

const MAX_REPORTED_DELIVERY_ERRORS = 3
export const DELIVERY_STALLED_MESSAGE = "RudderStack delivery stalled while the stream was paused"

export function describeDeliveryError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Counts events handed to the SDK against their delivery callbacks. Pauses the
 * incoming stream while too many events are pending and resolves drain waiters
 * once every sent event has been acknowledged or has failed. If the stream stays
 * paused with no delivery result for `stallTimeoutMs`, it aborts the stream so the
 * action can finish instead of waiting forever.
 */
export class RudderDeliveryTracker {
  sent = 0
  acked = 0
  failed = 0
  stalled = false
  readonly errorMessages: string[] = []
  private flowControl?: Hub.StreamFlowControl
  private paused = false
  private stallTimer?: NodeJS.Timeout
  private drainWaiters: (() => void)[] = []

  constructor(
    private readonly maxPendingEvents: number,
    private readonly stallTimeoutMs: number,
  ) {}

  get pending() {
    return this.sent - this.acked - this.failed
  }

  setFlowControl(control: Hub.StreamFlowControl) {
    this.flowControl = control
  }

  markSent() {
    this.sent++
    if (
      !this.paused &&
      this.flowControl &&
      this.pending >= this.maxPendingEvents
    ) {
      this.paused = true
      this.flowControl.pause()
      this.armStallTimer()
    }
  }

  // The SDK threw before queueing the event, so no callback will arrive for it.
  revertSent() {
    this.sent--
    this.settle()
  }

  readonly onEventDone = (error?: Error) => {
    if (error) {
      this.failed++
      const message = describeDeliveryError(error)
      if (
        this.errorMessages.length < MAX_REPORTED_DELIVERY_ERRORS &&
        this.errorMessages.indexOf(message) === -1
      ) {
        this.errorMessages.push(message)
      }
    } else {
      this.acked++
    }
    this.settle()
  }

  /**
   * Resolves `true` once every sent event has a result, or `false` if some are
   * still pending after `timeoutMs`.
   */
  async waitForDrain(timeoutMs: number): Promise<boolean> {
    if (this.pending === 0) {
      return true
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.drainWaiters = this.drainWaiters.filter((waiter) => waiter !== onDrained)
        resolve(false)
      }, timeoutMs)
      const onDrained = () => {
        clearTimeout(timer)
        resolve(true)
      }
      this.drainWaiters.push(onDrained)
    })
  }

  /** Clears the stall timer; call once the action is done with the tracker. */
  stop() {
    this.clearStallTimer()
  }

  private settle() {
    if (this.paused && this.flowControl) {
      if (this.pending <= Math.floor(this.maxPendingEvents / 2)) {
        this.paused = false
        this.clearStallTimer()
        this.flowControl.resume()
      } else {
        // Still paused, but delivery is progressing: restart the stall window.
        this.armStallTimer()
      }
    }
    if (this.pending === 0 && this.drainWaiters.length > 0) {
      const waiters = this.drainWaiters
      this.drainWaiters = []
      waiters.forEach((resolve) => resolve())
    }
  }

  private armStallTimer() {
    this.clearStallTimer()
    this.stallTimer = setTimeout(() => {
      this.stallTimer = undefined
      if (!this.paused || !this.flowControl) {
        return
      }
      this.stalled = true
      this.paused = false
      this.flowControl.abort(new Error(DELIVERY_STALLED_MESSAGE))
    }, this.stallTimeoutMs)
  }

  private clearStallTimer() {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer)
      this.stallTimer = undefined
    }
  }
}
