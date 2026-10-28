import * as winston from "winston"

export function truncateString(s: string, limit: number, split = "\n") {
  if (s.length > limit) {
    // truncate to max limit characters
    s = s.substring(0, limit)
    // re-trim if we are in the middle of a line
    if (s.lastIndexOf(split) > 0) {
      s = s.substring(0, Math.min(s.length, s.lastIndexOf(split) + 1))
    }
  }
  return s
}

export function formatToFileExtension(format: string) {
  const JSON_LIKE = ["json", "json_label", "inline_json", "json_detail"]
  if (JSON_LIKE.indexOf(format) !== -1) {
    return "json"
  } else {
    return format
  }
}

export interface PositiveIntegerSetting {
  fallback: number
  maximum: number
  minimum?: number
  /** Prepended to warnings, e.g. "[Rudder]". */
  logPrefix?: string
}

/**
 * Reads a positive integer setting from the environment. A missing or blank value
 * returns the fallback. An invalid value is logged and replaced with the fallback,
 * and a value outside [minimum, maximum] is logged and clamped to that range.
 */
export function readPositiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  setting: PositiveIntegerSetting,
): number {
  const { fallback, maximum, minimum = 1 } = setting
  const prefix = setting.logPrefix ? `${setting.logPrefix} ` : ""
  const raw = env[name]
  if (raw === undefined || raw.trim() === "") {
    return fallback
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    winston.warn(`${prefix}ignoring invalid ${name}="${raw}", using ${fallback}`)
    return fallback
  }
  if (value > maximum) {
    winston.warn(`${prefix}${name}=${raw} is above the maximum ${maximum}, using ${maximum}`)
    return maximum
  }
  if (value < minimum) {
    winston.warn(`${prefix}${name}=${raw} is below the minimum ${minimum}, using ${minimum}`)
    return minimum
  }
  return value
}
