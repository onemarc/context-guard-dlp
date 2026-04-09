import type { DecisionStatus, RiskState, ValidationResponse } from '../shared/types'

interface DecisionEngineOptions {
  debounceMs?: number
  onStateChange: (status: DecisionStatus) => void
  validateAmbiguous: (payload: {
    maskedText: string
    cacheKey: string
  }) => Promise<ValidationResponse>
}

interface LocalScore {
  score: number
  reason: string
  maskedText: string
  cacheKey: string
}

const SSN_REGEX = /\b\d{3}-\d{2}-\d{4}\b/
const EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i
const TOKEN_REGEX = /\b[A-Za-z0-9_\-]{24,}\b/
const API_KEY_REGEX = /(sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z\-_]{35})/
const CARD_CANDIDATE_REGEX = /(?:\d[ -]*?){13,19}/g

export class DecisionEngine {
  private readonly debounceMs: number
  private readonly onStateChange: DecisionEngineOptions['onStateChange']
  private readonly validateAmbiguous: DecisionEngineOptions['validateAmbiguous']
  private debounceTimer: number | null = null
  private requestSeq = 0
  private allowOnceFingerprint: string | null = null
  private bypassArmed = false
  private lastFingerprint = ''
  private status: DecisionStatus = {
    state: 'IDLE',
    score: 0,
    reason: 'Idle',
    maskedText: '',
    cacheKey: '',
  }

  constructor(options: DecisionEngineOptions) {
    this.debounceMs = options.debounceMs ?? 600
    this.onStateChange = options.onStateChange
    this.validateAmbiguous = options.validateAmbiguous
  }

  public evaluate(text: string): DecisionStatus {
    const fingerprint = normalizeText(text)
    if (fingerprint !== this.lastFingerprint) {
      this.allowOnceFingerprint = null
      this.bypassArmed = false
      this.lastFingerprint = fingerprint
    }

    if (!fingerprint) {
      this.publish({
        state: 'IDLE',
        score: 0,
        reason: 'Waiting for input',
        maskedText: '',
        cacheKey: '',
      })
      return this.status
    }

    const local = scoreLocal(text)

    if (local.score > 90) {
      this.clearDebounce()
      this.publish({ ...local, state: 'DANGER' })
      return this.status
    }

    if (local.score < 15) {
      this.clearDebounce()
      this.publish({ ...local, state: 'SAFE' })
      return this.status
    }

    this.publish({ ...local, state: 'CHECKING' })
    this.scheduleValidation(local.maskedText, local.cacheKey)
    return this.status
  }

  public getState(): RiskState {
    return this.status.state
  }

  public isBlocking(): boolean {
    return this.status.state === 'CHECKING' || this.status.state === 'DANGER'
  }

  public allowOnce(text: string): void {
    this.allowOnceFingerprint = normalizeText(text)
    this.bypassArmed = true
    this.publish({
      ...this.status,
      state: 'SAFE',
      score: 0,
      reason: 'Allow once enabled for current message',
    })
  }

  public consumeAllowOnce(text: string): boolean {
    const fingerprint = normalizeText(text)
    if (!this.bypassArmed || !this.allowOnceFingerprint || fingerprint !== this.allowOnceFingerprint) {
      return false
    }

    this.bypassArmed = false
    this.allowOnceFingerprint = null
    this.publish({
      ...this.status,
      state: 'DANGER',
      score: 91,
      reason: 'Allow once consumed. Review required for another send attempt.',
    })
    return true
  }

  private scheduleValidation(maskedText: string, cacheKey: string): void {
    this.clearDebounce()
    const seq = ++this.requestSeq
    this.debounceTimer = window.setTimeout(async () => {
      try {
        const result = await this.validateAmbiguous({ maskedText, cacheKey })
        if (seq !== this.requestSeq) {
          return
        }
        this.publish({
          state: result.state,
          score: result.score,
          reason: result.reason,
          maskedText,
          cacheKey,
        })
      } catch {
        if (seq !== this.requestSeq) {
          return
        }
        this.publish({
          state: 'DANGER',
          score: 95,
          reason: 'Validation unavailable. Blocking send to prevent exfiltration.',
          maskedText,
          cacheKey,
        })
      }
    }, this.debounceMs)
  }

  private clearDebounce(): void {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
  }

  private publish(next: DecisionStatus): void {
    this.status = next
    this.onStateChange(next)
  }
}

function scoreLocal(text: string): LocalScore {
  let score = 0
  let reason = 'No sensitive indicators found'

  const validCards = findValidCards(text)
  if (validCards.length > 0) {
    score = Math.max(score, 98)
    reason = 'Valid payment card detected via Luhn verification'
  }

  if (SSN_REGEX.test(text)) {
    score = Math.max(score, 94)
    reason = 'SSN format detected'
  }

  if (API_KEY_REGEX.test(text)) {
    score = Math.max(score, 72)
    reason = 'Possible API key detected, context requires verification'
  }

  if (TOKEN_REGEX.test(text)) {
    score = Math.max(score, 56)
    reason = 'High-entropy token-like text detected'
  }

  if (EMAIL_REGEX.test(text)) {
    score = Math.max(score, 22)
    reason = 'Contains email-like content'
  }

  const maskedText = maskText(text)
  return {
    score,
    reason,
    maskedText,
    cacheKey: hash(maskedText),
  }
}

function findValidCards(text: string): string[] {
  const matches = text.match(CARD_CANDIDATE_REGEX) ?? []
  return matches
    .map((candidate) => candidate.replace(/[^\d]/g, ''))
    .filter((digits) => digits.length >= 13 && digits.length <= 19)
    .filter((digits) => luhnValid(digits))
}

function luhnValid(number: string): boolean {
  let sum = 0
  let shouldDouble = false

  for (let index = number.length - 1; index >= 0; index -= 1) {
    let digit = Number(number[index])
    if (shouldDouble) {
      digit *= 2
      if (digit > 9) {
        digit -= 9
      }
    }
    sum += digit
    shouldDouble = !shouldDouble
  }

  return sum % 10 === 0
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

function maskText(text: string): string {
  return text.replace(/[A-Za-z0-9]/g, '*')
}

function hash(input: string): string {
  let acc = 0
  for (let index = 0; index < input.length; index += 1) {
    acc = (acc << 5) - acc + input.charCodeAt(index)
    acc |= 0
  }
  return `h${Math.abs(acc)}`
}
