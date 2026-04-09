import { DecisionEngine } from './decision-engine'
import { EventInterceptor } from './event-interceptor'
import { ShadowBadgeUI } from './shadow-badge-ui'
import type { DecisionStatus, RiskState, ValidationRequest, ValidationResponse } from '../shared/types'

const badge = new ShadowBadgeUI({
  onAllowOnce: () => {
    const text = getCurrentText()
    if (!text) {
      return
    }
    decisionEngine.allowOnce(text)
    badge.setState('SAFE', 'Bypass active for one send attempt')
  },
})

let activeInput: HTMLElement | null = null

const decisionEngine = new DecisionEngine({
  debounceMs: 600,
  onStateChange: (status) => updateUi(status),
  validateAmbiguous: async ({ maskedText, cacheKey }) => {
    const request: ValidationRequest = {
      type: 'DLP_VALIDATE',
      maskedText,
      cacheKey,
    }

    return new Promise<ValidationResponse>((resolve) => {
      chrome.runtime.sendMessage(request, (response: ValidationResponse | undefined) => {
        if (chrome.runtime.lastError || !response?.ok) {
          resolve({
            ok: true,
            state: 'DANGER',
            score: 95,
            reason: 'Background validation failed. Blocking send.',
          })
          return
        }
        resolve(response)
      })
    })
  },
})

const interceptor = new EventInterceptor({
  getState: () => decisionEngine.getState(),
  getCurrentText: () => getCurrentText(),
  isBlocking: () => decisionEngine.isBlocking(),
  consumeAllowOnce: (text) => decisionEngine.consumeAllowOnce(text),
  onBlockedAttempt: (state) => {
    if (state === 'CHECKING') {
      badge.shake('Sending blocked: Security check in progress')
      return
    }
    badge.shake('Sending blocked: Sensitive PII detected')
  },
})

interceptor.attach()

document.addEventListener(
  'focusin',
  (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement) || !isWatchedInput(target)) {
      return
    }

    activeInput = target
    badge.setAnchor(target)
    decisionEngine.evaluate(getTextFromElement(target))
  },
  { capture: true },
)

document.addEventListener(
  'input',
  (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement) || !isWatchedInput(target)) {
      return
    }

    activeInput = target
    badge.setAnchor(target)
    decisionEngine.evaluate(getTextFromElement(target))
  },
  { capture: true },
)

function getCurrentText(): string {
  if (!activeInput) {
    return ''
  }
  return getTextFromElement(activeInput)
}

function getTextFromElement(element: HTMLElement): string {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    return element.value
  }

  return element.textContent ?? ''
}

function isWatchedInput(element: HTMLElement): boolean {
  if (element instanceof HTMLTextAreaElement) {
    return true
  }

  if (element instanceof HTMLInputElement) {
    return ['text', 'search', 'email', 'url', 'password', 'tel'].includes(element.type)
  }

  return element.isContentEditable
}

function updateUi(status: DecisionStatus): void {
  badge.setState(status.state, tooltipByState(status.state, status.reason))
}

function tooltipByState(state: RiskState, reason: string): string {
  if (state === 'CHECKING') {
    return 'Security check in progress'
  }

  if (state === 'DANGER') {
    return `Sensitive PII detected. ${reason}`
  }

  if (state === 'SAFE') {
    return `Safe to send. ${reason}`
  }

  return 'Monitoring input'
}
