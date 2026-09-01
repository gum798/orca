/** Metadata attached to a host process-table observation. */
export type ForegroundEvidenceObservation = {
  authorityGeneration: string
  observationEpoch: number
  /** Age at serialization; receivers rebase this onto their monotonic clock. */
  capturedAgeMs: number
}

export type ForegroundProcessEvidence =
  | ({
      verdict: 'live'
      processName: string | null
      /** True only when the host observed the PTY's own shell owning the terminal's foreground
       *  process group — i.e. nothing is running in the pane. False means something IS running,
       *  named or not. Absent from a host that predates the field, which is neither: a reader
       *  deciding whether the pane is idle must require `true` and defer on anything else. */
      shellIsForeground?: boolean
    } & ForegroundEvidenceObservation)
  | ({ verdict: 'unverifiable'; reason: string } & ForegroundEvidenceObservation)

export function isForegroundProcessEvidence(value: unknown): value is ForegroundProcessEvidence {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const input = value as Record<string, unknown>
  if (
    typeof input.authorityGeneration !== 'string' ||
    input.authorityGeneration.length === 0 ||
    input.authorityGeneration.length > 256 ||
    typeof input.observationEpoch !== 'number' ||
    !Number.isSafeInteger(input.observationEpoch) ||
    input.observationEpoch < 0 ||
    typeof input.capturedAgeMs !== 'number' ||
    !Number.isSafeInteger(input.capturedAgeMs) ||
    input.capturedAgeMs < 0 ||
    input.capturedAgeMs > 86_400_000
  ) {
    return false
  }
  if (input.verdict === 'live') {
    if (input.shellIsForeground !== undefined && typeof input.shellIsForeground !== 'boolean') {
      return false
    }
    return input.processName === null || typeof input.processName === 'string'
  }
  return (
    input.verdict === 'unverifiable' && typeof input.reason === 'string' && input.reason.length > 0
  )
}

export function cloneForegroundProcessEvidence(
  evidence: ForegroundProcessEvidence
): ForegroundProcessEvidence {
  return { ...evidence }
}
