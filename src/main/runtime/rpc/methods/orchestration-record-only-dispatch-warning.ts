// Why: without --inject the dispatch row exists but nobody tells the terminal (#14809), and the task
// is already `dispatched`, so the reset path is the only way back to an injected attempt.
export function buildRecordOnlyDispatchWarning(terminal: string, taskId: string): string {
  return (
    `Recorded only: terminal ${terminal} was not told about task ${taskId}. ` +
    'Nothing is delivered without --inject. Deliver the task yourself, or reset it ' +
    `(task-update --id ${taskId} --status failed, then --status ready) and dispatch again with --inject.`
  )
}
