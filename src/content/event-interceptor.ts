import type { RiskState } from '../shared/types'

interface EventInterceptorOptions {
  getState: () => RiskState
  getCurrentText: () => string
  isBlocking: () => boolean
  consumeAllowOnce: (text: string) => boolean
  onBlockedAttempt: (state: Extract<RiskState, 'CHECKING' | 'DANGER'>) => void
}

const SEND_LABEL_PATTERN = /(send|submit|reply|post|chat|ask|message)/i

export class EventInterceptor {
  private readonly getState: EventInterceptorOptions['getState']
  private readonly getCurrentText: EventInterceptorOptions['getCurrentText']
  private readonly isBlocking: EventInterceptorOptions['isBlocking']
  private readonly consumeAllowOnce: EventInterceptorOptions['consumeAllowOnce']
  private readonly onBlockedAttempt: EventInterceptorOptions['onBlockedAttempt']

  constructor(options: EventInterceptorOptions) {
    this.getState = options.getState
    this.getCurrentText = options.getCurrentText
    this.isBlocking = options.isBlocking
    this.consumeAllowOnce = options.consumeAllowOnce
    this.onBlockedAttempt = options.onBlockedAttempt
  }

  public attach(): void {
    document.addEventListener('keydown', this.onKeyDown, { capture: true })
    document.addEventListener('pointerdown', this.onPointerEvent, { capture: true })
    document.addEventListener('click', this.onPointerEvent, { capture: true })
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' || event.isComposing) {
      return
    }

    const target = event.target
    if (!(target instanceof Element) || !isEditable(target)) {
      return
    }

    this.handleAttempt(event)
  }

  private readonly onPointerEvent = (event: Event): void => {
    const target = event.target
    if (!(target instanceof Element)) {
      return
    }

    const clickable = target.closest('button, input[type="submit"], [role="button"], [aria-label], [data-testid]')
    if (!clickable || !looksLikeSendControl(clickable)) {
      return
    }

    this.handleAttempt(event)
  }

  private handleAttempt(event: Event): void {
    const currentText = this.getCurrentText()
    if (this.consumeAllowOnce(currentText)) {
      return
    }

    if (!this.isBlocking()) {
      return
    }

    const state = this.getState()
    if (state !== 'CHECKING' && state !== 'DANGER') {
      return
    }

    event.preventDefault()
    event.stopImmediatePropagation()
    event.stopPropagation()
    this.onBlockedAttempt(state)
  }
}

function isEditable(element: Element): boolean {
  if (element instanceof HTMLTextAreaElement) {
    return true
  }

  if (element instanceof HTMLInputElement) {
    const inputTypes = new Set(['text', 'search', 'email', 'url', 'password', 'tel'])
    return inputTypes.has(element.type)
  }

  return element instanceof HTMLElement && element.isContentEditable
}

function looksLikeSendControl(element: Element): boolean {
  const text = [
    element.getAttribute('aria-label') ?? '',
    element.getAttribute('data-testid') ?? '',
    element.getAttribute('name') ?? '',
    element.getAttribute('title') ?? '',
    element.textContent ?? '',
    (element as HTMLInputElement).value ?? '',
  ]
    .join(' ')
    .trim()

  return SEND_LABEL_PATTERN.test(text)
}
