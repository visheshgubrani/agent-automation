let tail: Promise<unknown> = Promise.resolve()

/**
 * Serialize model admissions/calls (mail classifier and agent) inside the single worker, so two
 * reservations cannot both pass the same remaining budget. A failed task must not break the
 * chain for the next caller.
 */
export function withSerializedModelCall<T>(task: () => Promise<T>): Promise<T> {
  const run = tail.then(task, task)
  tail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}
