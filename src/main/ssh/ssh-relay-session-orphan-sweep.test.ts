// #9819 end to end on the client: the sweep runs only after reattach, only under a negotiated
// session-owner grant, and only against PTYs this relay itself attributes to this client.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SshRelaySession } from './ssh-relay-session'
import { createMockDeps, mockDeploySuccess } from './ssh-relay-session-test-fixtures'

const { muxRequestMock, openConsumerSessionMock } = vi.hoisted(() => ({
  muxRequestMock: vi.fn(),
  openConsumerSessionMock: vi.fn(async (_mux: unknown, options: { clientInstanceId: string }) => ({
    state: {
      mode: 'negotiated' as const,
      clientInstanceId: options.clientInstanceId,
      clientGeneration: 1,
      ownerGeneration: 1,
      ownerLease: 'test-owner-lease'
    },
    resumed: false
  }))
}))

vi.mock('./ssh-relay-deploy', () => ({ deployAndLaunchRelay: vi.fn() }))
vi.mock('./ssh-pty-consumer-session', () => ({
  openSshPtyConsumerSession: openConsumerSessionMock
}))
vi.mock('../ipc/ssh-pty-output-intake-registry', () => ({
  acceptSshPtyOutputData: vi.fn().mockResolvedValue(undefined),
  acceptSshPtyOutputExit: vi.fn().mockResolvedValue(undefined),
  allocateSshPtyProviderGeneration: vi.fn(() => 17),
  beginSshPtyOutputGenerationMigration: vi.fn(() => ({
    byPty: new Map(),
    completion: Promise.resolve()
  })),
  closeSshPtyOutputGeneration: vi.fn(),
  getSshPtyAcceptedSourceCheckpoints: vi.fn(() => []),
  applySshPtySourceCancellationProof: vi.fn(() => true),
  applySshPtySourceRecoveryCancellationProof: vi.fn(() => true),
  installSshPtySourceAckPublisher: vi.fn(() => () => {}),
  installSshPtySourceCancellationPublisher: vi.fn(() => () => {})
}))
vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: vi.fn().mockResolvedValue('') }))
vi.mock('./ssh-remote-orca-cli', () => ({
  runRemoteOrcaCli: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
}))
vi.mock('./ssh-channel-multiplexer', () => ({
  SshChannelMultiplexer: class MockSshChannelMultiplexer {
    notify = vi.fn()
    notifyWithSettlement = vi.fn()
    request = muxRequestMock
    onNotification = vi.fn().mockReturnValue(() => {})
    onNotificationByMethod = vi.fn().mockReturnValue(() => {})
    onRequest = vi.fn().mockReturnValue(() => {})
    onDispose = vi.fn().mockReturnValue(() => {})
    dispose = vi.fn()
    isDisposed = vi.fn().mockReturnValue(false)
  }
}))
vi.mock('../agent-hooks/remote-managed-hook-installers', () => ({
  installRemoteManagedAgentHooks: vi.fn()
}))
vi.mock('../providers/ssh-pty-provider', () => ({
  SshPtyProvider: class MockSshPtyProvider {
    onData = vi.fn().mockReturnValue(() => {})
    onReplay = vi.fn().mockReturnValue(() => {})
    onExit = vi.fn().mockReturnValue(() => {})
    attach = vi.fn().mockResolvedValue(undefined)
    attachForReconnect = vi.fn().mockResolvedValue({})
    dispose = vi.fn()
  }
}))
vi.mock('../providers/ssh-filesystem-provider', () => ({
  SshFilesystemProvider: class MockSshFilesystemProvider {
    dispose = vi.fn()
  }
}))
vi.mock('../providers/ssh-git-provider', () => ({
  SshGitProvider: class MockSshGitProvider {}
}))
vi.mock('../ipc/pty', () => ({
  registerSshPtyProvider: vi.fn(),
  unregisterSshPtyProvider: vi.fn(),
  getSshPtyProvider: vi.fn(),
  getPtyIdsForConnection: vi.fn().mockReturnValue([]),
  clearPtyOwnershipForConnection: vi.fn(),
  clearProviderPtyState: vi.fn(),
  deletePtyOwnership: vi.fn(),
  setPtyOwnership: vi.fn(),
  restorePtyIncarnation: vi.fn(),
  isCurrentPtyExit: vi.fn(() => true),
  answerStartupTerminalColorQueriesForPty: vi.fn((_id: string, data: string) => data)
}))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  registerSshFilesystemProvider: vi.fn(),
  unregisterSshFilesystemProvider: vi.fn(),
  getSshFilesystemProvider: vi.fn().mockReturnValue({ dispose: vi.fn() })
}))
vi.mock('../providers/ssh-git-dispatch', () => ({
  registerSshGitProvider: vi.fn(),
  unregisterSshGitProvider: vi.fn()
}))

const { getSshPtyProvider, getPtyIdsForConnection } = await import('../ipc/pty')

const TARGET = 'target-1'
const OUR_CLIENT = 'client-instance-1'

function hostEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `ssh:${TARGET}@@pty-orphan`,
    incarnationId: 'inc-orphan',
    cwd: '/home/user',
    title: 'zsh',
    // The relay stamps this from the live consumer grant, so it names THIS client.
    ownerClientInstanceId: OUR_CLIENT,
    hostAgeMs: 120_000,
    paneBound: true,
    ...overrides
  }
}

describe('SshRelaySession orphaned relay PTY sweep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    muxRequestMock.mockReset()
    muxRequestMock.mockResolvedValue([])
    mockDeploySuccess()
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
  })

  async function establish(
    processes: Record<string, unknown>[],
    leases: { ptyId: string; state: string }[] = []
  ): Promise<{ shutdown: ReturnType<typeof vi.fn> }> {
    const deps = createMockDeps()
    // Why the recovery row: it pins this session's clientInstanceId, and the comparison is
    // meaningless unless the id it uses is the persisted one.
    vi.mocked(deps.mockStore.getSshPtyConsumerRecovery).mockReturnValue({
      targetId: TARGET,
      clientInstanceId: OUR_CLIENT,
      serverBuildId: 'build-1',
      clientGeneration: 1,
      ownerGeneration: 1,
      ownerLease: 'test-owner-lease'
    } as ReturnType<typeof deps.mockStore.getSshPtyConsumerRecovery>)
    vi.mocked(deps.mockStore.getSshRemotePtyLeases).mockReturnValue(
      leases.map((lease) => ({ targetId: TARGET, ...lease })) as ReturnType<
        typeof deps.mockStore.getSshRemotePtyLeases
      >
    )
    const shutdown = vi.fn().mockResolvedValue(undefined)
    vi.mocked(getSshPtyProvider).mockReturnValue({
      attachForReconnect: vi.fn().mockResolvedValue({}),
      listProcesses: vi.fn().mockResolvedValue(processes),
      shutdown,
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)

    const session = new SshRelaySession(
      TARGET,
      deps.getMainWindow,
      deps.mockStore,
      deps.mockPortForward
    )
    await session.establish(deps.mockConn)
    return { shutdown }
  }

  it('stops an attested orphan the client has no lease for', async () => {
    const { shutdown } = await establish([hostEntry()])

    expect(shutdown).toHaveBeenCalledWith(`ssh:${TARGET}@@pty-orphan`, {
      immediate: true,
      expectedIncarnationId: 'inc-orphan'
    })
  })

  it('never stops a PTY that still holds a live lease', async () => {
    const { shutdown } = await establish(
      [hostEntry({ id: `ssh:${TARGET}@@pty-live`, incarnationId: 'inc-live' })],
      [{ ptyId: 'pty-live', state: 'detached' }]
    )

    expect(shutdown).not.toHaveBeenCalled()
  })

  it('never stops a PTY this relay attributes to a different client', async () => {
    const { shutdown } = await establish([
      hostEntry({ ownerClientInstanceId: 'someone-elses-laptop' })
    ])

    expect(shutdown).not.toHaveBeenCalled()
  })

  it('never stops anything a relay predating the attestation lists', async () => {
    const legacy = hostEntry()
    delete legacy.ownerClientInstanceId
    delete legacy.hostAgeMs
    delete legacy.paneBound

    const { shutdown } = await establish([legacy])

    expect(shutdown).not.toHaveBeenCalled()
  })
})
