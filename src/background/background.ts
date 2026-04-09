import { ChatOpenAI } from '@langchain/openai'
import { z } from 'zod'
import type { ValidationRequest, ValidationResponse } from '../shared/types'

const verdictSchema = z.object({
  verdict: z.enum(['SAFE', 'DANGER']),
  confidence: z.number().min(0).max(100),
  reason: z.string().min(1).max(240),
})

const inMemoryCache = new Map<string, ValidationResponse>()

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isValidationRequest(message)) {
    return false
  }

  void validate(message)
    .then((result) => sendResponse(result))
    .catch(() => {
      sendResponse({
        ok: true,
        state: 'DANGER',
        score: 95,
        reason: 'We could not verify this message safely, so sending is blocked.',
      } satisfies ValidationResponse)
    })

  return true
})

async function validate(request: ValidationRequest): Promise<ValidationResponse> {
  const key = `dlp-cache:${request.cacheKey}`

  const mem = inMemoryCache.get(key)
  if (mem) {
    return { ...mem, cached: true }
  }

  const persisted = await chrome.storage.local.get(key)
  const persistedValue = persisted[key] as ValidationResponse | undefined
  if (persistedValue) {
    inMemoryCache.set(key, persistedValue)
    return { ...persistedValue, cached: true }
  }

  const apiKey = await getApiKey()
  if (!apiKey) {
    const fallback: ValidationResponse = {
      ok: true,
      state: 'DANGER',
      score: 95,
      reason: 'Cloud validation is unavailable, so sending is blocked for safety.',
    }
    await cacheResult(key, fallback)
    return fallback
  }

  const model = new ChatOpenAI({
    apiKey,
    model: 'gpt-4.1-nano',
    temperature: 0,
  }).withStructuredOutput(verdictSchema)

  const result = await model.invoke([
    {
      role: 'system',
      content:
        'You are a DLP validator. Input is privacy-scrubbed text where sensitive values may be replaced with placeholders such as [EMAIL], [PHONE], [CARD], [API_KEY], [TOKEN], [PASSPORT]. Classify as SAFE or DANGER for data exfiltration prevention. Favor DANGER when uncertain.',
    },
    {
      role: 'user',
      content: `Masked text to review:\n${request.maskedText}`,
    },
  ])

  const response: ValidationResponse = {
    ok: true,
    state: result.verdict,
    score: Math.round(result.confidence),
    reason: result.reason,
  }

  await cacheResult(key, response)
  return response
}

async function cacheResult(key: string, value: ValidationResponse): Promise<void> {
  inMemoryCache.set(key, value)
  await chrome.storage.local.set({ [key]: value })
}

async function getApiKey(): Promise<string> {
  const storage = await chrome.storage.local.get('openaiApiKey')
  const value = storage.openaiApiKey
  return typeof value === 'string' ? value.trim() : ''
}

function isValidationRequest(message: unknown): message is ValidationRequest {
  if (!message || typeof message !== 'object') {
    return false
  }

  const candidate = message as Partial<ValidationRequest>
  return (
    candidate.type === 'DLP_VALIDATE' &&
    typeof candidate.maskedText === 'string' &&
    typeof candidate.cacheKey === 'string'
  )
}
