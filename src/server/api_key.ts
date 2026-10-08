import * as crypto from "crypto"

function digest(nonce: string) {
  return crypto.createHmac("sha512", process.env.ACTION_HUB_SECRET!.toString()).update(nonce).digest("hex")
}

export function fromNonce(nonce: string) {
  return `${nonce}/${digest(nonce)}`
}

export function validate(key: string) {
  const [nonce, providedDigest] = key.split("/")
  if (!nonce || !providedDigest) {
    return false
  }
  const providedBuffer = Buffer.from(providedDigest)
  const expectedBuffer = Buffer.from(digest(nonce))
  try {
    return crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  } catch (_e) {
    // timingSafeEqual throws (e.g. a RangeError on unequal digest lengths) for
    // malformed tokens; treat any comparison failure as an invalid token.
    return false
  }
}
