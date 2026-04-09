export type RiskState = 'IDLE' | 'SAFE' | 'CHECKING' | 'DANGER'

export interface DecisionStatus {
  state: RiskState
  score: number
  reason: string
  maskedText: string
  cacheKey: string
}

export interface ValidationRequest {
  type: 'DLP_VALIDATE'
  maskedText: string
  cacheKey: string
}

export interface ValidationResponse {
  ok: boolean
  state: Extract<RiskState, 'SAFE' | 'DANGER'>
  score: number
  reason: string
  cached?: boolean
}
