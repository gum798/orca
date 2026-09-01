// #9819, the client half: what the sweep actually asks the store and the host, and what it does
// with the answers. The rule itself is covered in ssh-relay-pty-ownership-proof.test.ts.
import { describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type { IPtyProvider } from '../providers/types'
import type { PtyProcessInfo } from '../providers/pty-process-info'
import type { SshRemotePtyLease } from '../../shared/ssh-types'
import { sweepOrphanedRelayPtys } from './ssh-orphan-relay-pty-sweep'
import { RELAY_PTY_SWEEP_MIN_AGE_MS } from '../../shared/ssh-relay-pty-ownership-proof'

const TARGET = 'target-1'
const OURS = 'client-instance-ours'

function hostEntry(overrides: Partial<PtyProcessInfo> = {}): PtyProcessInfo {
  return {
    id: `ssh:${TARGET}@@pty-1`,
    incarnationId: 'inc-1',
    cwd: '/home/user',
    title: 'zsh',
    ownerClientInstanceId: OURS,
    hostAgeMs: RELAY_PTY_SWEEP_MIN_AGE_MS * 2,
    paneBound: true,
    ...overrides
  }
}

function createHarness(
  processes: PtyProcessInfo[],
  leases: SshRemotePtyLease[] = []
): { provider: IPtyProvider; store: Store; shutdown: ReturnType<typeof vi.fn> } {
  const shutdown = vi.fn().mockResolvedValue(undefined)
  const provider = {
    listProcesses: vi.fn().mockResolvedValue(processes),
    shutdown
  } as unknown as IPtyProvider
  const store = {
    getSshRemotePtyLeases: vi.fn().mockReturnValue(leases)
  } as unknown as Store
  return { provider, store, shutdown }
}

function run(
  harness: ReturnType<typeof createHarness>,
  overrides: Partial<Parameters<typeof sweepOrphanedRelayPtys>[0]> = {}
): Promise<void> {
  return sweepOrphanedRelayPtys({
    targetId: TARGET,
    store: harness.store,
    provider: harness.provider,
    clientInstanceId: OURS,
    isSessionOwner: true,
    routedPtyIds: [],
    shouldContinue: () => true,
    ...overrides
  })
}

function lease(ptyId: string, state: SshRemotePtyLease['state']): SshRemotePtyLease {
  return { ptyId, state } as SshRemotePtyLease
}

describe('sweepOrphanedRelayPtys', () => {
  it('stops an attested orphan, fenced on the incarnation the same listing published', async () => {
    const harness = createHarness([hostEntry()])

    await run(harness)

    expect(harness.shutdown).toHaveBeenCalledWith(`ssh:${TARGET}@@pty-1`, {
      immediate: true,
      expectedIncarnationId: 'inc-1'
    })
  })

  it('leaves a PTY the caller just reattached alone', async () => {
    const harness = createHarness([hostEntry()])

    await run(harness, { routedPtyIds: ['pty-1'] })

    expect(harness.shutdown).not.toHaveBeenCalled()
  })

  it.each([['attached'], ['detached']] as const)(
    'leaves a PTY holding a live %s lease alone',
    async (state) => {
      const harness = createHarness([hostEntry()], [lease('pty-1', state)])

      await run(harness)

      expect(harness.shutdown).not.toHaveBeenCalled()
    }
  )

  it('leaves a PTY with an undelivered stop to the replay pass', async () => {
    // The kill-intent journal owns those: it re-fences and retries them, and a second stop issued
    // from here would race that decision with weaker evidence.
    const tombstoned = {
      ...lease('pty-1', 'terminated'),
      pendingKill: { requestedAt: 1, incarnationId: 'inc-1', attempts: 0 }
    } as SshRemotePtyLease
    const harness = createHarness([hostEntry()], [tombstoned])

    await run(harness)

    expect(harness.shutdown).not.toHaveBeenCalled()
  })

  it('does sweep a PTY whose lease this client already tombstoned without an order', async () => {
    const harness = createHarness([hostEntry()], [lease('pty-1', 'terminated')])

    await run(harness)

    expect(harness.shutdown).toHaveBeenCalledTimes(1)
  })

  it('asks the host nothing when this connection is not the session owner', async () => {
    const harness = createHarness([hostEntry()])

    await run(harness, { isSessionOwner: false })

    expect(harness.provider.listProcesses).not.toHaveBeenCalled()
    expect(harness.shutdown).not.toHaveBeenCalled()
  })

  it('stops nothing against a host that publishes no attestation', async () => {
    const legacy = hostEntry()
    delete legacy.ownerClientInstanceId
    delete legacy.hostAgeMs
    delete legacy.paneBound
    const harness = createHarness([legacy])

    await run(harness)

    expect(harness.shutdown).not.toHaveBeenCalled()
  })

  it('swallows a failed listing rather than failing the connect it runs on', async () => {
    const harness = createHarness([])
    vi.mocked(harness.provider.listProcesses).mockRejectedValue(new Error('relay went away'))

    await expect(run(harness)).resolves.toBeUndefined()
  })

  it('swallows a failed stop and leaves the order to the next connect', async () => {
    const harness = createHarness([hostEntry()])
    harness.shutdown.mockRejectedValue(new Error('connection lost'))

    await expect(run(harness)).resolves.toBeUndefined()
  })

  it('abandons the pass when the attempt is superseded mid-flight', async () => {
    const harness = createHarness([hostEntry()])
    let alive = true
    vi.mocked(harness.provider.listProcesses).mockImplementation(async () => {
      alive = false
      return [hostEntry()]
    })

    await run(harness, { shouldContinue: () => alive })

    expect(harness.shutdown).not.toHaveBeenCalled()
  })
})
