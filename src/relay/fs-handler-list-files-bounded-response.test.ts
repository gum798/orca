/**
 * #12547: the relay used to bound `fs.listFiles` only when the client asked it to. The failing UI
 * (Quick Open / Files sidebar) is exactly a call site that does not ask, so the host serialized the
 * whole tree into one response and the request died as "Message too large" or over-capacity.
 *
 * The scan is bounded either way now, but a caller that named no limit is never handed the prefix:
 * clients that predate `maxResults` on this call hardcode `truncated: false`, so a prefix reaches
 * them as a complete listing with nothing on the wire for them to notice.
 *
 * What decides "this cannot be answered" is bytes, not rows. A row cap is not a bound on a frame —
 * 20,001 deep-monorepo paths serialize past the response lane — and it refuses listings that would
 * have fit, which is what an old client on a large remote workspace was hitting.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runListFilesScanMock } = vi.hoisted(() => ({
  runListFilesScanMock: vi.fn()
}))

vi.mock('./fs-list-files-fallback-chain', () => ({
  runListFilesScan: runListFilesScanMock
}))

vi.mock('@parcel/watcher', () => ({ subscribe: vi.fn() }))

import { FsHandler } from './fs-handler'
import { RelayContext } from './context'
import type { RelayDispatcher } from './dispatcher'
import { DISPATCHER_CONTROL_QUEUE_MAX_BYTES } from './dispatcher-writer-admission'
import { QUICK_OPEN_LISTING_MAX_RESULTS } from '../shared/quick-open-listing-limits'
import {
  QUICK_OPEN_LISTING_MAX_RESPONSE_BYTES,
  QUICK_OPEN_LISTING_UNCAPPED_SCAN_LIMIT
} from './fs-list-files-response-budget'

type ListFilesHandler = (
  params: Record<string, unknown>,
  context?: { clientId: number }
) => Promise<string[]>

function createHandler(): { listFiles: ListFilesHandler; dispose: () => void } {
  const requestHandlers = new Map<string, ListFilesHandler>()
  const dispatcher = {
    onRequest: (method: string, handler: ListFilesHandler) => requestHandlers.set(method, handler),
    onNotification: vi.fn(),
    onClientDetached: vi.fn(),
    notify: vi.fn(),
    notifyBulk: vi.fn(),
    publishProducerNotification: vi.fn(() => true),
    activeClientIds: () => [],
    producerEnvelopeBudget: () => Number.MAX_SAFE_INTEGER
  } as unknown as RelayDispatcher
  const handler = new FsHandler(dispatcher, new RelayContext(), {
    dispose: vi.fn(),
    forgetRoot: vi.fn(),
    subscribe: vi.fn()
  })
  return { listFiles: requestHandlers.get('fs.listFiles')!, dispose: () => handler.dispose() }
}

describe('fs.listFiles response bounding', () => {
  let listFiles: ListFilesHandler
  let dispose: () => void

  beforeEach(() => {
    runListFilesScanMock.mockReset()
    runListFilesScanMock.mockResolvedValue([])
    const created = createHandler()
    listFiles = created.listFiles
    dispose = created.dispose
    return () => dispose()
  })

  function scanMaxResults(): unknown {
    // runListFilesScan(rootPath, excludePathPrefixes, signal, maxResults, searchQuery)
    return runListFilesScanMock.mock.calls[0][3]
  }

  it('bounds a request that omitted maxResults by what the host can retain', async () => {
    await listFiles({ rootPath: '/remote/root' }, { clientId: 1 })

    expect(scanMaxResults()).toBe(QUICK_OPEN_LISTING_UNCAPPED_SCAN_LIMIT)
  })

  it('bounds a request whose maxResults is malformed rather than trusting it', async () => {
    await listFiles({ rootPath: '/remote/root', maxResults: 'all' }, { clientId: 1 })

    expect(scanMaxResults()).toBe(QUICK_OPEN_LISTING_UNCAPPED_SCAN_LIMIT)
  })

  it('refuses to answer an uncapped request with a prefix', async () => {
    runListFilesScanMock.mockResolvedValue(
      Array.from({ length: QUICK_OPEN_LISTING_UNCAPPED_SCAN_LIMIT }, (_, index) => `f${index}`)
    )

    await expect(listFiles({ rootPath: '/remote/root' }, { clientId: 1 })).rejects.toThrow(
      /more than 99999 files/
    )
  })

  it('answers an uncapped request that fits, so a normal workspace is unaffected', async () => {
    const files = Array.from({ length: QUICK_OPEN_LISTING_MAX_RESULTS - 1 }, (_, i) => `f${i}`)
    runListFilesScanMock.mockResolvedValue(files)

    await expect(listFiles({ rootPath: '/remote/root' }, { clientId: 1 })).resolves.toEqual(files)
  })

  it('hands a client that named a cap the prefix it asked for', async () => {
    runListFilesScanMock.mockResolvedValue(
      Array.from({ length: QUICK_OPEN_LISTING_MAX_RESULTS }, (_, index) => `f${index}`)
    )

    const files = await listFiles(
      { rootPath: '/remote/root', maxResults: QUICK_OPEN_LISTING_MAX_RESULTS },
      { clientId: 1 }
    )

    expect(files).toHaveLength(QUICK_OPEN_LISTING_MAX_RESULTS)
  })

  it('keeps a smaller client limit and clamps a larger one', async () => {
    await listFiles({ rootPath: '/remote/root', maxResults: 33 }, { clientId: 1 })
    expect(scanMaxResults()).toBe(33)

    runListFilesScanMock.mockClear()
    await listFiles(
      { rootPath: '/remote/root', maxResults: QUICK_OPEN_LISTING_MAX_RESULTS * 10 },
      { clientId: 2 }
    )
    expect(scanMaxResults()).toBe(QUICK_OPEN_LISTING_MAX_RESULTS)
  })
})

/**
 * #12547 second: what a frame can carry is a question about bytes. A fixed row ceiling both refuses
 * listings that would have fit — the old-client regression — and admits ones that will not, which
 * reach the response lane as an opaque ResponseOverCapacity that turns on unrelated load.
 */
describe('fs.listFiles byte-budgeted ceiling', () => {
  let listFiles: ListFilesHandler

  beforeEach(() => {
    runListFilesScanMock.mockReset()
    runListFilesScanMock.mockResolvedValue([])
    const created = createHandler()
    listFiles = created.listFiles
    return () => created.dispose()
  })

  function pathsOfLength(count: number, length: number): string[] {
    return Array.from({ length: count }, (_, index) => `${String(index).padStart(length, 'p')}.ts`)
  }

  it('answers an uncapped request well past the old fixed row cap when the paths fit', async () => {
    const files = pathsOfLength(QUICK_OPEN_LISTING_MAX_RESULTS + 5_000, 8)
    runListFilesScanMock.mockResolvedValue(files)

    await expect(listFiles({ rootPath: '/remote/root' }, { clientId: 1 })).resolves.toEqual(files)
  })

  it('refuses an uncapped request whose paths do not fit one response', async () => {
    runListFilesScanMock.mockResolvedValue(pathsOfLength(4_000, 400))

    await expect(listFiles({ rootPath: '/remote/root' }, { clientId: 1 })).rejects.toThrow(
      new RegExp(`do not fit in one ${QUICK_OPEN_LISTING_MAX_RESPONSE_BYTES}-byte response`)
    )
  })

  it('refuses a capped request whose own page does not fit, instead of blowing the lane', async () => {
    runListFilesScanMock.mockResolvedValue(pathsOfLength(4_000, 400))

    await expect(
      listFiles({ rootPath: '/remote/root', maxResults: 4_000 }, { clientId: 1 })
    ).rejects.toThrow(/do not fit in one/)
  })

  it('keeps answering a capped request whose page fits', async () => {
    const files = pathsOfLength(4_000, 8)
    runListFilesScanMock.mockResolvedValue(files)

    await expect(
      listFiles({ rootPath: '/remote/root', maxResults: 4_000 }, { clientId: 1 })
    ).resolves.toEqual(files)
  })

  it('stays under the lane budget past which a response is refused on unrelated load', () => {
    expect(QUICK_OPEN_LISTING_MAX_RESPONSE_BYTES).toBeLessThan(DISPATCHER_CONTROL_QUEUE_MAX_BYTES)
  })
})
