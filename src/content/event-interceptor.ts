import type { RiskState } from '../shared/types'

interface EventInterceptorOptions {
  getState: () => RiskState
  getCurrentText: () => string
  getActiveInput: () => HTMLElement | null
  isBlocking: () => boolean
  consumeAllowOnce: (text: string) => boolean
  onBlockedAttempt: (state: Extract<RiskState, 'CHECKING' | 'DANGER'>) => void
}

const SEND_LABEL_PATTERN = /(send|submit|reply|post|chat|ask|message)/i

export class EventInterceptor {
  private readonly getState: EventInterceptorOptions['getState']
  private readonly getCurrentText: EventInterceptorOptions['getCurrentText']
  private readonly getActiveInput: EventInterceptorOptions['getActiveInput']
  private readonly isBlocking: EventInterceptorOptions['isBlocking']
  private readonly consumeAllowOnce: EventInterceptorOptions['consumeAllowOnce']
  private readonly onBlockedAttempt: EventInterceptorOptions['onBlockedAttempt']

  constructor(options: EventInterceptorOptions) {
    this.getState = options.getState
    this.getCurrentText = options.getCurrentText
    this.getActiveInput = options.getActiveInput
    this.isBlocking = options.isBlocking
    this.consumeAllowOnce = options.consumeAllowOnce
    this.onBlockedAttempt = options.onBlockedAttempt
  }

  public attach(): void {
    document.addEventListener('keydown', this.onKeyDown, { capture: true })
    document.addEventListener('pointerdown', this.onPointerEvent, { capture: true })
    document.addEventListener('click', this.onPointerEvent, { capture: true })
    document.addEventListener('submit', this.onSubmit, { capture: true })
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
    const clickable = findClickableInPath(event)
    if (!clickable) {
      return
    }

    const activeInput = this.getActiveInput()
    if (!activeInput || !activeInput.isConnected || !isEditable(activeInput)) {
      return
    }

    if (!looksLikeSendControl(clickable, activeInput)) {
      return
    }

    this.handleAttempt(event)
  }

  private readonly onSubmit = (event: Event): void => {
    const target = event.target
    if (!(target instanceof HTMLFormElement)) {
      return
    }

    const activeInput = this.getActiveInput()
    if (!activeInput || !target.contains(activeInput)) {
      return
    }

    this.handleAttempt(event)
  }

  private handleAttempt(event: Event): void {
    const currentText = this.getCurrentText()
    if (!currentText.trim()) {
      return
    }

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

function looksLikeSendControl(element: Element, activeInput: HTMLElement | null): boolean {
  if (isSubmitControl(element, activeInput)) {
    return true
  }

  const text = [
    element.getAttribute('aria-label') ?? '',
    element.getAttribute('data-testid') ?? '',
    element.getAttribute('data-action') ?? '',
    element.getAttribute('name') ?? '',
    element.getAttribute('title') ?? '',
    element.textContent ?? '',
    (element as HTMLInputElement).value ?? '',
  ]
    .join(' ')
    .trim()

  return SEND_LABEL_PATTERN.test(text)
}

function isSubmitControl(element: Element, activeInput: HTMLElement | null): boolean {
  if (element instanceof HTMLInputElement) {
    if (element.type === 'submit' || element.type === 'image') {
      return activeInput ? belongsToSameForm(element, activeInput) : true
    }
  }

  if (element instanceof HTMLButtonElement) {
    const type = (element.getAttribute('type') ?? 'submit').toLowerCase()
    if (type === 'submit') {
      return activeInput ? belongsToSameForm(element, activeInput) : true
    }
  }

  return false
}

function belongsToSameForm(control: Element, activeInput: HTMLElement): boolean {
  const form = control instanceof HTMLInputElement || control instanceof HTMLButtonElement ? control.form : null
  if (form) {
    return form.contains(activeInput)
  }

  const inputForm = activeInput.closest('form')
  return !!inputForm && inputForm.contains(control)
}

function findClickableInPath(event: Event): Element | null {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : []
  for (const node of path) {
    if (!(node instanceof Element)) {
      continue
    }

    if (
      node.matches(
        'button, input[type="submit"], input[type="image"], [role="button"], [aria-label], [data-testid], [data-action]',
      )
    ) {
      return node
    }
  }

  const target = event.target
  if (!(target instanceof Element)) {
    return null
  }

  return target.closest(
    'button, input[type="submit"], input[type="image"], [role="button"], [aria-label], [data-testid], [data-action]',
  )
}
