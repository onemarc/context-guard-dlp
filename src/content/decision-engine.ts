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
const API_KEY_REGEX =
  /(\bsk-[A-Za-z0-9]{8,}\b|\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z\-_]{35}|\bghp_[A-Za-z0-9]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b)/
const HIGH_RISK_SECRET_KV_REGEX =
  /(?:(?:"|')?(?:(?:db[_-]?)?password|passwd|pwd|private[_-]?key|private[_-]?token|client[_-]?secret|app[_-]?secret|aws[_-]?(?:secret|access)[_-]?key|stripe[_-]?token)(?:"|')?\s*[:=]\s*)(?:"[^"\n]{4,}"|'[^'\n]{4,}'|[^\s,}{]{4,})/i
const HIGH_RISK_SECRET_KV_MASK_REGEX =
  /((?:"|')?(?:(?:db[_-]?)?password|passwd|pwd|private[_-]?key|private[_-]?token|client[_-]?secret|app[_-]?secret|aws[_-]?(?:secret|access)[_-]?key|stripe[_-]?token)(?:"|')?\s*[:=]\s*)(?:"[^"\n]{4,}"|'[^'\n]{4,}'|[^\s,}{]{4,})/gi
const SESSION_KV_REGEX =
  /(?:(?:"|')?(?:sessionid|session_id|token|auth(?:orization)?|api[_-]?key|secret)(?:"|')?\s*[:=]\s*)(?:"[^"\n]{4,}"|'[^'\n]{4,}'|[A-Za-z0-9_\-]{6,})/i
const SESSION_KV_MASK_REGEX =
  /((?:"|')?(?:sessionid|session_id|token|auth(?:orization)?|api[_-]?key|secret)(?:"|')?\s*[:=]\s*)(?:"[^"\n]{4,}"|'[^'\n]{4,}'|[A-Za-z0-9_\-]{6,})/gi
const PASSPORT_REGEX = /\b[A-Z]{1,2}\d{6,9}\b/
const FULL_NAME_REGEX = /\b[A-Z][a-z]{1,30}\s+[A-Z][a-z]{1,30}\b/
const PHONE_CANDIDATE_REGEX = /(?:\+?\d[\d().\-\s]{7,}\d)/g
const GENDER_REGEX = /\b(male|female|man|woman|non-binary|boy|girl)\b/i
const BIRTH_YEAR_REGEX = /\b(?:born\s*(?:in)?\s*)?(19[3-9]\d|20[0-1]\d)\b/i
const SMALL_LOCATION_REGEX = /\b(small town|village|hamlet|rural town|lives in|from)\b/i
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
    reason = 'This looks like a payment card number'
  }

  if (SSN_REGEX.test(text)) {
    score = Math.max(score, 94)
    reason = 'This looks like a social security number'
  }

  if (hasLikelyPhoneNumber(text)) {
    score = Math.max(score, 92)
    reason = 'This looks like a phone number'
  }

  if (PASSPORT_REGEX.test(text)) {
    score = Math.max(score, 92)
    reason = 'This looks like a passport or ID number'
  }

  if (API_KEY_REGEX.test(text)) {
    score = Math.max(score, 93)
    reason = 'This looks like an API key or access secret'
  }

  if (HIGH_RISK_SECRET_KV_REGEX.test(text)) {
    score = Math.max(score, 96)
    reason = 'This looks like a password or credential secret'
  }

  if (SESSION_KV_REGEX.test(text)) {
    score = Math.max(score, 72)
    reason = 'This may contain a token or secret key-value pair'
  }

  if (TOKEN_REGEX.test(text)) {
    score = Math.max(score, 64)
    reason = 'This may contain a private token'
  }

  if (FULL_NAME_REGEX.test(text)) {
    score = Math.max(score, 34)
    reason = 'This may include a full name and needs a quick check'
  }

  if (hasQuasiIdentifierCombo(text)) {
    score = Math.max(score, 58)
    reason = 'This combination of personal details may identify a person'
  }

  if (EMAIL_REGEX.test(text)) {
    score = Math.max(score, 22)
    reason = 'This may include an email address'
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

function hasLikelyPhoneNumber(text: string): boolean {
  const matches = text.match(PHONE_CANDIDATE_REGEX) ?? []
  return matches.some((candidate) => {
    const digits = candidate.replace(/\D/g, '')
    return digits.length >= 9 && digits.length <= 15
  })
}

function hasQuasiIdentifierCombo(text: string): boolean {
  return GENDER_REGEX.test(text) && BIRTH_YEAR_REGEX.test(text) && SMALL_LOCATION_REGEX.test(text)
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
  let masked = text

  masked = masked.replace(EMAIL_REGEX, '[EMAIL]')
  masked = masked.replace(SSN_REGEX, '[SSN]')
  masked = masked.replace(HIGH_RISK_SECRET_KV_MASK_REGEX, '$1[REDACTED]')
  masked = masked.replace(SESSION_KV_MASK_REGEX, '$1[REDACTED]')
  masked = masked.replace(API_KEY_REGEX, '[API_KEY]')

  masked = masked.replace(TOKEN_REGEX, '[TOKEN]')

  const phoneMatches = masked.match(PHONE_CANDIDATE_REGEX) ?? []
  for (const phoneMatch of phoneMatches) {
    const digits = phoneMatch.replace(/\D/g, '')
    if (digits.length >= 9 && digits.length <= 15) {
      masked = masked.replace(phoneMatch, '[PHONE]')
    }
  }

  const cardMatches = masked.match(CARD_CANDIDATE_REGEX) ?? []
  for (const cardMatch of cardMatches) {
    const digits = cardMatch.replace(/\D/g, '')
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      masked = masked.replace(cardMatch, '[CARD]')
    }
  }

  masked = masked.replace(PASSPORT_REGEX, '[PASSPORT]')
  return masked
}

function hash(input: string): string {
  let acc = 0
  for (let index = 0; index < input.length; index += 1) {
    acc = (acc << 5) - acc + input.charCodeAt(index)
    acc |= 0
  }
  return `h${Math.abs(acc)}`
}
