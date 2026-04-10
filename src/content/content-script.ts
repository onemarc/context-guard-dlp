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
    badge.setState('SAFE', 'Allowed once for this message')
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
  getActiveInput: () => activeInput,
  isBlocking: () => decisionEngine.isBlocking(),
  consumeAllowOnce: (text) => decisionEngine.consumeAllowOnce(text),
  onBlockedAttempt: (state) => {
    if (state === 'CHECKING') {
      badge.shake('Please wait. We are still checking this message.')
      return
    }
    badge.shake('Message blocked to protect sensitive information.')
  },
})

interceptor.attach()

document.addEventListener(
  'focusin',
  (event) => {
    const input = resolveWatchedInput(event.target)
    if (!input) {
      return
    }

    activeInput = input
    badge.setAnchor(input)
    decisionEngine.evaluate(getTextFromElement(input))
  },
  { capture: true },
)

document.addEventListener(
  'input',
  (event) => {
    const input = resolveWatchedInput(event.target)
    if (!input) {
      return
    }

    activeInput = input
    badge.setAnchor(input)
    decisionEngine.evaluate(getTextFromElement(input))
  },
  { capture: true },
)

document.addEventListener(
  'beforeinput',
  (event) => {
    const input = resolveWatchedInput(event.target)
    if (!input) {
      return
    }

    activeInput = input
    badge.setAnchor(input)
    const inputEvent = event as InputEvent
    queueEvaluate(input, { aggressive: inputEvent.inputType === 'insertFromPaste' })
  },
  { capture: true },
)

document.addEventListener(
  'paste',
  (event) => {
    const input = resolveWatchedInput(event.target)
    if (!input) {
      return
    }

    activeInput = input
    badge.setAnchor(input)

    if (event instanceof ClipboardEvent) {
      const pastedText = event.clipboardData?.getData('text/plain').trim() ?? ''
      if (pastedText) {
        const projected = projectTextAfterPaste(input, pastedText)
        if (projected) {
          decisionEngine.evaluate(projected)
        }
      }
    }

    queueEvaluate(input, { aggressive: true })
  },
  { capture: true },
)

document.addEventListener(
  'focusout',
  () => {
    window.setTimeout(() => {
      const nextInput = resolveWatchedInput(document.activeElement)
      if (nextInput) {
        activeInput = nextInput
        badge.setAnchor(nextInput)
        return
      }

      clearActiveInputTracking()
    }, 0)
  },
  { capture: true },
)

function getCurrentText(): string {
  if (!activeInput || !document.contains(activeInput)) {
    clearActiveInputTracking()
    return ''
  }

  const text = getTextFromElement(activeInput)
  if (!text.trim()) {
    decisionEngine.evaluate('')
  }

  return text
}

function getTextFromElement(element: HTMLElement): string {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    return element.value
  }

  return element.innerText || element.textContent || ''
}

function queueEvaluate(input: HTMLElement, options?: { aggressive?: boolean }): void {
  window.setTimeout(() => {
    evaluateIfConnected(input)
  }, 0)

  if (!options?.aggressive) {
    return
  }

  window.requestAnimationFrame(() => {
    evaluateIfConnected(input)
  })

  window.setTimeout(() => {
    evaluateIfConnected(input)
  }, 90)

  window.setTimeout(() => {
    evaluateIfConnected(input)
  }, 240)
}

function evaluateIfConnected(input: HTMLElement): void {
  if (!document.contains(input)) {
    return
  }

  decisionEngine.evaluate(getTextFromElement(input))
}

function projectTextAfterPaste(input: HTMLElement, pastedText: string): string {
  if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
    const existing = input.value
    const start = input.selectionStart ?? existing.length
    const end = input.selectionEnd ?? start
    return `${existing.slice(0, start)}${pastedText}${existing.slice(end)}`
  }

  const existing = getTextFromElement(input)
  if (!existing.trim()) {
    return pastedText
  }

  return `${existing}\n${pastedText}`
}

function clearActiveInputTracking(): void {
  activeInput = null
  badge.setAnchor(null)
  decisionEngine.evaluate('')
}

function resolveWatchedInput(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) {
    return document.activeElement instanceof HTMLElement && isWatchedInput(document.activeElement)
      ? document.activeElement
      : null
  }

  if (isWatchedInput(target)) {
    return target
  }

  const editableRoot = target.closest('[contenteditable]:not([contenteditable="false"])')
  if (editableRoot instanceof HTMLElement && isWatchedInput(editableRoot)) {
    return editableRoot
  }

  if (document.activeElement instanceof HTMLElement && isWatchedInput(document.activeElement)) {
    return document.activeElement
  }

  return null
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
    return 'Checking this message for sensitive data...'
  }

  if (state === 'DANGER') {
    return `${reason}. Please remove it before sending.`
  }

  if (state === 'SAFE') {
    return 'Looks good. Safe to send.'
  }

  return 'Watching this field'
}
