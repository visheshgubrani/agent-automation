import type { LlmCallUsage } from '../audit/calls.js'

/** The bounded prompt cannot fit the configured input budget. Permanent for this attempt. */
export class ClassifierInputTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClassifierInputTooLargeError'
  }
}

/** The provider refused or filtered the request; retrying the same message will not help. */
export class ClassifierRefusalError extends Error {
  readonly usage?: LlmCallUsage

  constructor(message: string, options: { usage?: LlmCallUsage } = {}) {
    super(message)
    this.name = 'ClassifierRefusalError'
    this.usage = options.usage
  }
}

/** Structured output was missing or invalid. Permanent and visible as a failed attempt. */
export class ClassifierInvalidOutputError extends Error {
  readonly usage?: LlmCallUsage

  constructor(message: string, options: { usage?: LlmCallUsage } = {}) {
    super(message)
    this.name = 'ClassifierInvalidOutputError'
    this.usage = options.usage
  }
}

/** The provider outcome (or its usage/cost) could not be determined; keep budget reserved. */
export class ClassifierUncertainError extends Error {
  readonly usage?: LlmCallUsage

  constructor(message: string, options: { cause?: unknown; usage?: LlmCallUsage } = {}) {
    super(message, { cause: options.cause })
    this.name = 'ClassifierUncertainError'
    this.usage = options.usage
  }
}
