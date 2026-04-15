# Context Guard DLP

## Project description

Context Guard DLP is a browser extension that helps prevent accidental sharing of sensitive data in web-based chat and messaging inputs.

https://github.com/user-attachments/assets/5cf4ea3d-b995-45cf-b1bf-55c9ff32a9d9

It monitors text fields in real time, evaluates risk locally with pattern-based detection, and uses an OpenAI fallback check for ambiguous cases. If risky content is detected, send actions are blocked until the content is removed or the user explicitly allows one send.

The project is built using TypeScript and LangChain.js as a Chrome extension.

## Functionality

- Detects sensitive content while typing and pasting in editable chat inputs.
- Intercepts send attempts on Enter, send button clicks, and form submits.
- Classifies message risk as `IDLE`, `SAFE`, `CHECKING`, or `DANGER`.
- Uses local detection for common sensitive patterns, including:
	- Payment card-like values.
	- Social security number format.
	- Phone numbers and passport/ID-like formats.
	- API keys and session/token-like secrets.
	- Quasi-identifier combinations that can reveal identity.
- Uses OpenAI model validation `(gpt-4.1-nano)` for ambiguous cases.
- Caches validation responses for repeated masked input.
- Displays a floating badge UI near the active input with status and user-friendly messaging.
- Supports one-time override (Allow Once) for the current message.
- Auto-recovers badge UI on dynamic SPA pages that rewrite DOM (for example ChatGPT-like sites).

## Setup instructions

### 1. Install dependencies

```bash
npm install
```

### 2. Build the extension

```bash
npm run build
```

Build output is generated in the dist folder.

### 3. Load extension in Chrome

1. Open Chrome and go to `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select the dist folder.

### 4. Add OpenAI API key to extension storage

This step is optional. The extension works without an OpenAI key using local detection.
If you add a key, ambiguous cases are validated more precisely.

The background validator reads key `openaiApiKey from chrome.storage.local`.

After loading the extension (step 3), open the extension service worker console and run:

```js
chrome.storage.local.set({ openaiApiKey: 'YOUR_OPENAI_API_KEY' })
```

### 5. Run in development mode (optional)

```bash
npm run dev
```

### 6. Verify behavior

1. Open a chat-style website.
2. Type or paste content with sensitive values (for example phone, key-like token, or card-like data).
3. Confirm badge state changes and send is blocked when risk is high.
4. Clear the input and confirm blocking is removed.
