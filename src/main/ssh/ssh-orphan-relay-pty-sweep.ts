import type { Store } from '../persistence'
import type { IPtyProvider } from '../providers/types'
import { toAppSshPtyId, toRelaySshPtyId } from '../providers/ssh-pty-id'
import {
  planRelayPtySweep,
  RELAY_PTY_SWEEP_MIN_AGE_MS,
  type RelayPtyOwnershipEvidence
} from '../../shared/ssh-relay-pty-ownership-proof'

export type SshOrphanRelayPtySweepArgs = {
  targetId: string
  store: Store
  provider: IPtyProvider
  /** This client's persisted consumer identity for the target. */
  clientInstanceId: string
  /** True only when the relay granted this connection the negotiated `session-owner` role. */
  isSessionOwner: boolean
  /** Relay PTY ids this connect just reattached, plus any the caller otherwise knows are live. */
  routedPtyIds: Iterable<string>
  shouldContinue: () => boolean
  now?: () => number
  minimumHostAgeMs?: number
}

/** Every relay PTY id this client still has a route to. Read across all lease states except the
 *  tombstones, plus the undelivered stops, which belong to the replay pass and not to this one. */
function routedIds(args: SshOrphanRelayPtySweepArgs): Set<string> {
  const routed = new Set<string>(args.routedPtyIds)
  for (const lease of args.store.getSshRemotePtyLeases(args.targetId)) {
    if (lease.state !== 'terminated' && lease.state !== 'expired') {
      routed.add(lease.ptyId)
    }
    if (lease.pendingKill) {
      routed.add(lease.ptyId)
    }
  }
  return routed
}

function toEvidence(
  targetId: string,
  process: Awaited<ReturnType<IPtyProvider['listProcesses']>>[number]
): RelayPtyOwnershipEvidence {
  return {
    ptyId: toRelaySshPtyId(targetId, process.id),
    ...(process.incarnationId ? { incarnationId: process.incarnationId } : {}),
    ...(process.ownerClientInstanceId
      ? { ownerClientInstanceId: process.ownerClientInstanceId }
      : {}),
    ...(typeof process.hostAgeMs === 'number' ? { hostAgeMs: process.hostAgeMs } : {}),
    ...(typeof process.paneBound === 'boolean' ? { paneBound: process.paneBound } : {}),
    ...(process.agentSessionOwners ? { agentSessionOwners: process.agentSessionOwners } : {})
  }
}

/** Stops the relay PTYs this client can prove it created and has since lost every route to.
 *
 *  Runs after reattach, so a PTY this connect reclaimed is already routed and can never be a
 *  candidate. Best-effort and never throws: it is opportunistic cleanup on the connect path, and a
 *  failed connection is a much worse outcome than a slot left leaked for another session.
 *
 *  Costs one `pty.listProcesses` per connect. That is the price of reconciling at all — there is no
 *  cheaper question than asking the authoritative host what it is holding. */
export async function sweepOrphanedRelayPtys(args: SshOrphanRelayPtySweepArgs): Promise<void> {
  if (!args.isSessionOwner || !args.clientInstanceId || !args.shouldContinue()) {
    return
  }
  try {
    const processes = await args.provider.listProcesses()
    if (!args.shouldContinue()) {
      return
    }
    const plan = planRelayPtySweep(
      processes.map((process) => toEvidence(args.targetId, process)),
      {
        clientInstanceId: args.clientInstanceId,
        isSessionOwner: args.isSessionOwner,
        routedPtyIds: routedIds(args),
        minimumHostAgeMs: args.minimumHostAgeMs ?? RELAY_PTY_SWEEP_MIN_AGE_MS
      }
    )
    if (plan.sweep.length === 0) {
      return
    }
    await Promise.all(
      plan.sweep.map(async (target) => {
        if (!args.shouldContinue()) {
          return
        }
        try {
          // Fenced on the incarnation the same listing published, so a relay that renumbered its
          // ids between the read and this call refuses the stop instead of hitting a stranger.
          await args.provider.shutdown(toAppSshPtyId(args.targetId, target.ptyId), {
            immediate: true,
            expectedIncarnationId: target.incarnationId
          })
          console.log(
            `[ssh-orphan-sweep] stopped orphaned relay PTY ${args.targetId}/${target.ptyId}`
          )
        } catch (err) {
          // Unverifiable, not failed: the next connect re-reads the inventory and decides again.
          console.warn(
            `[ssh-orphan-sweep] stop for ${args.targetId}/${target.ptyId} is unverifiable: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        }
      })
    )
  } catch (err) {
    console.warn(
      `[ssh-orphan-sweep] pass on ${args.targetId} stopped early: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
}
