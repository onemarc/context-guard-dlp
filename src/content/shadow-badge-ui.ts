import type { RiskState } from '../shared/types'

interface BadgeOptions {
  onAllowOnce: () => void
}

export class ShadowBadgeUI {
  private readonly host: HTMLDivElement
  private readonly badge: HTMLButtonElement
  private readonly tooltip: HTMLDivElement
  private readonly tooltipText: HTMLSpanElement
  private readonly allowOnceButton: HTMLButtonElement
  private readonly mountObserver: MutationObserver
  private readonly mountCheckTimer: number
  private readonly anchorResizeObserver: ResizeObserver
  private trackingFrame: number | null = null
  private lastAnchorSignature = ''
  private anchor: HTMLElement | null = null

  constructor(options: BadgeOptions) {
    this.host = document.createElement('div')
    this.host.setAttribute('data-context-guard-root', 'true')
    this.host.style.position = 'fixed'
    this.host.style.zIndex = '2147483647'
    this.host.style.pointerEvents = 'none'

    const root = this.host.attachShadow({ mode: 'open' })
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .wrap { position: relative; pointer-events: auto; font-family: system-ui, sans-serif; }
        .badge {
          width: 16px;
          height: 16px;
          position: relative;
          border-radius: 50%;
          border: 1px solid rgba(0, 0, 0, 0.24);
          cursor: default;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.36), 0 0 0 1px rgba(255, 255, 255, 0.2) inset;
          transition: transform 120ms ease;
          display: grid;
          place-items: center;
          padding: 0;
          margin: 0;
        }
        .badge::after {
          content: '';
          position: absolute;
          left: 50%;
          top: 50%;
          width: 10px;
          height: 10px;
          display: block;
          transform: translate(-50%, -50%);
          background: center / contain no-repeat
            url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='white' d='M12 2l7 3v6c0 5.25-3.75 10-7 11-3.25-1-7-5.75-7-11V5l7-3z'/%3E%3C/svg%3E");
          filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.6));
        }
        .idle { background: #9ca3af; }
        .safe { background: #16a34a; }
        .checking { background: #f59e0b; }
        .danger { background: #dc2626; }

        .tooltip {
          position: absolute;
          top: 20px;
          right: 0;
          min-width: 220px;
          max-width: 260px;
          padding: 8px;
          border-radius: 8px;
          background: #111827;
          color: #f9fafb;
          font-size: 11px;
          line-height: 1.35;
          border: 1px solid rgba(255,255,255,0.2);
          opacity: 0;
          transform: translateY(-4px);
          pointer-events: none;
          transition: opacity 120ms ease, transform 120ms ease;
        }
        .wrap:hover .tooltip,
        .tooltip.force-open {
          opacity: 1;
          transform: translateY(0);
          pointer-events: auto;
        }

        .allow-once {
          margin-top: 6px;
          border: 1px solid rgba(255, 255, 255, 0.3);
          border-radius: 6px;
          background: transparent;
          color: #fef2f2;
          font-size: 10px;
          padding: 3px 6px;
          cursor: pointer;
          display: none;
        }

        .allow-once.show { display: inline-flex; }

        .shake {
          animation: shake 280ms linear;
        }

        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          20% { transform: translateX(-3px); }
          40% { transform: translateX(3px); }
          60% { transform: translateX(-2px); }
          80% { transform: translateX(2px); }
        }
      </style>
      <div class="wrap">
        <button class="badge idle" aria-label="Context Guard DLP status"></button>
        <div class="tooltip" role="status" aria-live="polite">
          <span class="tooltip-text">Monitoring input</span>
          <button class="allow-once" type="button">Dismiss / Allow Once</button>
        </div>
      </div>
    `

    this.badge = root.querySelector<HTMLButtonElement>('.badge') ?? document.createElement('button')
    this.tooltip = root.querySelector<HTMLDivElement>('.tooltip') ?? document.createElement('div')
    this.tooltipText = root.querySelector<HTMLSpanElement>('.tooltip-text') ?? document.createElement('span')
    this.allowOnceButton = root.querySelector<HTMLButtonElement>('.allow-once') ?? document.createElement('button')

    this.allowOnceButton.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      options.onAllowOnce()
    })

    this.mountHost()

    this.mountObserver = new MutationObserver(() => {
      this.mountHost()
    })
    this.mountObserver.observe(document, {
      childList: true,
      subtree: true,
    })

    this.mountCheckTimer = window.setInterval(() => {
      this.mountHost()
    }, 1200)

    this.anchorResizeObserver = new ResizeObserver(() => {
      this.reposition()
    })

    window.addEventListener('scroll', this.reposition, true)
    window.addEventListener('resize', this.reposition, true)
    window.visualViewport?.addEventListener('resize', this.reposition)
    window.visualViewport?.addEventListener('scroll', this.reposition)
  }

  public setAnchor(element: HTMLElement | null): void {
    this.mountHost()

    if (this.anchor && this.anchor !== element) {
      this.anchorResizeObserver.unobserve(this.anchor)
    }

    this.anchor = element
    this.lastAnchorSignature = ''

    if (this.anchor) {
      this.anchorResizeObserver.observe(this.anchor)
      this.ensureTracking()
    } else {
      this.stopTracking()
    }

    this.reposition()
  }

  public setState(state: RiskState, tooltipText: string): void {
    this.mountHost()
    this.badge.classList.remove('idle', 'safe', 'checking', 'danger')
    this.tooltip.classList.remove('force-open')

    if (state === 'IDLE') {
      this.badge.classList.add('idle')
      this.allowOnceButton.classList.remove('show')
    } else if (state === 'SAFE') {
      this.badge.classList.add('safe')
      this.allowOnceButton.classList.remove('show')
    } else if (state === 'CHECKING') {
      this.badge.classList.add('checking')
      this.allowOnceButton.classList.remove('show')
      this.tooltip.classList.add('force-open')
    } else {
      this.badge.classList.add('danger')
      this.allowOnceButton.classList.add('show')
      this.tooltip.classList.add('force-open')
    }

    this.tooltipText.textContent = tooltipText
  }

  public shake(tooltipText: string): void {
    this.mountHost()
    this.tooltipText.textContent = tooltipText
    this.tooltip.classList.add('force-open')
    this.badge.classList.remove('shake')
    void this.badge.offsetWidth
    this.badge.classList.add('shake')
  }

  public dispose(): void {
    this.mountObserver.disconnect()
    window.clearInterval(this.mountCheckTimer)
    this.anchorResizeObserver.disconnect()
    this.stopTracking()
    window.removeEventListener('scroll', this.reposition, true)
    window.removeEventListener('resize', this.reposition, true)
    window.visualViewport?.removeEventListener('resize', this.reposition)
    window.visualViewport?.removeEventListener('scroll', this.reposition)

    if (this.host.isConnected) {
      this.host.remove()
    }
  }

  private mountHost(): void {
    if (this.host.isConnected) {
      return
    }

    const root = document.documentElement ?? document.body
    if (!root) {
      return
    }

    root.appendChild(this.host)
  }

  private readonly reposition = (): void => {
    this.mountHost()

    if (!this.anchor) {
      this.host.style.display = 'none'
      this.lastAnchorSignature = ''
      return
    }

    if (!this.anchor.isConnected) {
      this.host.style.display = 'none'
      this.lastAnchorSignature = ''
      return
    }

    this.host.style.display = 'block'
    const rect = this.anchor.getBoundingClientRect()
    const top = Math.max(4, rect.top + 4)
    const left = Math.min(window.innerWidth - 24, rect.right - 18)
    const signature = `${top}|${left}|${rect.width}|${rect.height}|${window.innerWidth}|${window.innerHeight}`

    if (signature === this.lastAnchorSignature) {
      return
    }

    this.lastAnchorSignature = signature
    this.host.style.top = `${top}px`
    this.host.style.left = `${left}px`
  }

  private ensureTracking(): void {
    if (this.trackingFrame !== null) {
      return
    }

    const tick = () => {
      this.reposition()

      if (!this.anchor) {
        this.trackingFrame = null
        return
      }

      this.trackingFrame = window.requestAnimationFrame(tick)
    }

    this.trackingFrame = window.requestAnimationFrame(tick)
  }

  private stopTracking(): void {
    if (this.trackingFrame === null) {
      return
    }

    window.cancelAnimationFrame(this.trackingFrame)
    this.trackingFrame = null
  }
}
