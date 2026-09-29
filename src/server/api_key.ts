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
  // timingSafeEqual throws a RangeError on unequal lengths, so reject a
  // wrong-length digest before comparing rather than letting it throw.
  if (providedBuffer.length !== expectedBuffer.length) {
    return false
  }
  return crypto.timingSafeEqual(providedBuffer, expectedBuffer)
}
