// The host half of #9819: a client may only reap a relay PTY it can prove it created, so the relay
// has to say who created each one. The attestation is read from the live consumer grant, never from
// a spawn parameter — otherwise it would just echo the caller's claim back at it.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const { mockPtySpawn, mockPtyInstance, mockCreateShellPromptReadinessProbe } = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  mockPtyInstance: {
    pid: process.pid,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
}))

vi.mock('node-pty', () => ({ spawn: mockPtySpawn }))
vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))
vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mockCreateShellPromptReadinessProbe
}))

import type { PtyHandler } from './pty-handler'
import {
  beginPtyHandlerTest,
  endPtyHandlerTest,
  type MockDispatcher
} from './pty-handler-test-harness'

const PANE_KEY = 'tab-agent:22222222-2222-4222-8222-222222222222'

type Summary = {
  id: string
  paneBound?: boolean
  hostAgeMs?: number
  ownerClientInstanceId?: string
}

describe('PtyHandler publishes host-attested PTY ownership', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined

  async function spawnFrom(
    clientId: number,
    params: Record<string, unknown> = {}
  ): Promise<{ id: string }> {
    mockPtySpawn.mockReturnValue({ ...mockPtyInstance, onData: vi.fn(), onExit: vi.fn() })
    return (await dispatcher.callRequest('pty.spawn', params, {
      clientId,
      isStale: () => false
    } as never)) as { id: string }
  }

  async function listProcesses(): Promise<Summary[]> {
    return (await dispatcher.callRequest('pty.listProcesses', {})) as Summary[]
  }

  beforeEach(() => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
    handler.setConsumerIdentityResolver((clientId) => (clientId === 7 ? 'client-A' : null))
  })

  afterEach(async () => {
    await endPtyHandlerTest(handler, originalPlatform)
  })

  it('attributes a pane spawn to the identity the consumer grant names', async () => {
    const { id } = await spawnFrom(7, { env: { ORCA_PANE_KEY: PANE_KEY } })
    vi.advanceTimersByTime(45_000)

    const entry = (await listProcesses()).find((process) => process.id === id)

    expect(entry?.ownerClientInstanceId).toBe('client-A')
    expect(entry?.paneBound).toBe(true)
    expect(entry?.hostAgeMs).toBeGreaterThanOrEqual(45_000)
  })

  it('omits the attestation entirely when the connection holds no active grant', async () => {
    const { id } = await spawnFrom(9, { env: { ORCA_PANE_KEY: PANE_KEY } })

    const entry = (await listProcesses()).find((process) => process.id === id)

    // Absent, not empty-string or null: a reader must be able to tell "unattested" from any value.
    expect(entry).not.toHaveProperty('ownerClientInstanceId')
  })

  it('reports a bare shell as not pane-bound', async () => {
    const { id } = await spawnFrom(7, {})

    const entry = (await listProcesses()).find((process) => process.id === id)

    expect(entry?.paneBound).toBe(false)
    expect(entry?.ownerClientInstanceId).toBe('client-A')
  })
})
