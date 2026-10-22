let tail: Promise<unknown> = Promise.resolve()

/**
 * Serialize classifier admissions/calls inside the single worker. A failed task must not break
 * the chain for the next message.
 */
export function withSerializedModelCall<T>(task: () => Promise<T>): Promise<T> {
  const run = tail.then(task, task)
  tail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}
