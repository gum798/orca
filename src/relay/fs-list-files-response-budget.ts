import { QUICK_OPEN_LISTING_MAX_RETAINED_PATHS } from '../shared/quick-open-listing-limits'
import { limitQuickOpenFilesBySerializedBytes } from '../shared/quick-open-transport-budget'
import { DISPATCHER_CONTROL_QUEUE_MAX_BYTES } from './dispatcher-writer-admission'

/** `{"jsonrpc":"2.0","id":N,"result":[…]}` plus the frame header, rounded up hard. */
const RESPONSE_ENVELOPE_RESERVE_BYTES = 4096

/**
 * The largest `fs.listFiles` reply that is reliably deliverable.
 *
 * Not the 16MB frame cap. `sendResponse` demotes anything over
 * `DISPATCHER_CONTROL_QUEUE_MAX_BYTES` to the `legacy-response` lane, which is refused
 * outright once the producer queue passes its own budget — an opaque
 * `ResponseOverCapacity` that turns on unrelated load rather than on the request. This
 * is the boundary past which the reply stops being deliverable at all, and so the only
 * honest place to refuse one. Same reasoning as `MAX_FILE_RANGE_READ_BYTES`.
 */
export const QUICK_OPEN_LISTING_MAX_RESPONSE_BYTES =
  DISPATCHER_CONTROL_QUEUE_MAX_BYTES - RESPONSE_ENVELOPE_RESERVE_BYTES

/**
 * Row ceiling for a scan whose caller named no limit.
 *
 * Deliberately not a product cap on how many files Quick Open may list — how many fit
 * is a question about bytes, and a workspace of short paths should get more rows than a
 * deep monorepo. This only bounds what the host retains while finding out, at the
 * retention limit the listing walkers already hold themselves to.
 */
export const QUICK_OPEN_LISTING_UNCAPPED_SCAN_LIMIT = QUICK_OPEN_LISTING_MAX_RETAINED_PATHS

/**
 * Why `files` cannot be returned as it stands, or `undefined` when it can.
 *
 * The reply is a bare JSON array with nowhere to say "there is more", so the only
 * truncation a client can see is the row cap it named itself — and clients that predate
 * `maxResults` on this call hardcode `truncated: false`, so they cannot see even that.
 * Anything else has to be an error: handing back a prefix as the whole listing is the
 * silent truncation #12547 is about, and there is no wire change for a client to notice.
 *
 * A row cap is not a bound on a frame. 20,001 deep-monorepo paths serialize to megabytes
 * and blow the response lane, so bytes decide deliverability and the row cap only decides
 * how much the host was willing to look at.
 */
export function listFilesUndeliverableReason(
  files: readonly string[],
  requestedMaxResults: number | undefined,
  scanLimit: number
): string | undefined {
  const deliverable = limitQuickOpenFilesBySerializedBytes(
    files,
    QUICK_OPEN_LISTING_MAX_RESPONSE_BYTES
  )
  if (deliverable.length < files.length) {
    return `This workspace's ${files.length} file paths do not fit in one ${QUICK_OPEN_LISTING_MAX_RESPONSE_BYTES}-byte response. Open a narrower folder, or type to search so the host can rank a page — it will not return a partial listing as if it were complete.`
  }
  if (requestedMaxResults === undefined && files.length >= scanLimit) {
    return `This workspace has more than ${scanLimit - 1} files. Update Orca on this device so it can request a bounded page, or open a narrower folder — the host will not return a partial listing as if it were complete.`
  }
  return undefined
}
