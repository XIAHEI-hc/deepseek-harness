/**
 * Platform-owned HTML pages: the login page and the runtime status page.
 *
 * Both pages are rendered here, carry no external resources, and are served
 * with an explicit restrictive Content-Security-Policy. All product copy is
 * bilingual (Chinese and English) selected from the request's
 * `Accept-Language`; no user-controlled text is interpolated into the markup.
 *
 * @module @deepseek-ai/dsh-platform-services/gateway/pages
 */

import type { RuntimeStatusView, RuntimeState } from '../contracts.ts'

/** Content-Security-Policy for every page this gateway renders. */
export const PAGE_CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'"

/** Response headers shared by every gateway-rendered page. */
export const PAGE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': PAGE_CONTENT_SECURITY_POLICY,
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
}

/** Language one page is rendered in. */
export type PageLanguage = 'zh' | 'en'

/** Identity login route the login page links to. */
export const AUTH_LOGIN_PATH = '/auth/login'

/** Longest accepted `return_to` value, in characters. */
const MAX_RETURN_TO_LENGTH = 2048

/**
 * Pick the page language from an `Accept-Language` header.
 * @param acceptLanguage - raw header value, or undefined when absent.
 * @returns `zh` when Chinese is preferred, otherwise `en`.
 */
export function resolvePageLanguage(acceptLanguage: string | undefined): PageLanguage {
  if (acceptLanguage === undefined) return 'en'
  const first = acceptLanguage.split(',')[0]?.trim().toLowerCase() ?? ''
  return first.startsWith('zh') ? 'zh' : 'en'
}

/** Localized copy of one page section. */
interface PageCopy {
  readonly title: string
  readonly brand: string
  readonly heading: string
  readonly subtitle: string
  readonly button: string
  readonly hint: string
  readonly security: string
}

/** Login page copy per language. */
const LOGIN_COPY: Readonly<Record<PageLanguage, PageCopy>> = {
  zh: {
    title: 'DSH 登录',
    brand: 'DeepSeek Harness',
    heading: '欢迎使用 DSH',
    subtitle: '使用 W3 统一身份登录工作台',
    button: '通过 W3 登录',
    hint: '登录完成后进入你的私人 Agent 空间',
    security: '会话仅限当前浏览器；页面不会暴露内部服务地址。',
  },
  en: {
    title: 'DSH sign-in',
    brand: 'DeepSeek Harness',
    heading: 'Welcome to DSH',
    subtitle: 'Sign in to your workspace with W3 single sign-on',
    button: 'Sign in with W3',
    hint: 'After signing in you enter your private agent space.',
    security: 'The session is bound to this browser; internal service addresses are never exposed to the page.',
  },
}

/** Localized error copy keyed by stable platform error code. */
const LOGIN_ERROR_COPY: Readonly<Record<PageLanguage, Readonly<Record<string, string>>>> = {
  zh: {
    'w3-denied': 'W3 登录未完成，请重试。',
    'session-expired': '登录已过期，请重新登录。',
    'session-revoked': '会话已被注销，请重新登录。',
    'runtime-failed': '个人运行环境启动失败，请稍后重试或联系管理员。',
    'w3-unavailable': '认证服务暂时不可用，请稍后重试。',
    'identity-unavailable': '认证服务暂时不可用，请稍后重试。',
  },
  en: {
    'w3-denied': 'W3 sign-in was not completed. Please try again.',
    'session-expired': 'Your session expired. Please sign in again.',
    'session-revoked': 'Your session was revoked. Please sign in again.',
    'runtime-failed': 'Your personal runtime failed to start. Please retry later or contact an administrator.',
    'w3-unavailable': 'The identity service is temporarily unavailable. Please try again.',
    'identity-unavailable': 'The identity service is temporarily unavailable. Please try again.',
  },
}

/** Localized fallback error message. */
const LOGIN_ERROR_FALLBACK: Readonly<Record<PageLanguage, string>> = {
  zh: '登录未完成，请重试。',
  en: 'Sign-in was not completed. Please try again.',
}

/** Localized runtime state labels for the status page. */
const STATE_COPY: Readonly<Record<PageLanguage, Readonly<Record<RuntimeState, string>>>> = {
  zh: {
    UNALLOCATED: '正在准备你的个人工作区',
    PROVISIONING: '正在准备你的个人工作区',
    STARTING: '正在启动你的个人工作区',
    READY: '你的工作区已就绪',
    STOPPING: '正在停止个人工作区',
    STOPPED: '个人工作区已停止，正在重新启动',
    FAILED: '个人运行环境启动失败',
  },
  en: {
    UNALLOCATED: 'Preparing your personal workspace',
    PROVISIONING: 'Preparing your personal workspace',
    STARTING: 'Starting your personal workspace',
    READY: 'Your workspace is ready',
    STOPPING: 'Stopping your personal workspace',
    STOPPED: 'Your workspace stopped and is restarting',
    FAILED: 'Your personal runtime failed to start',
  },
}

/** Escape text for HTML element content and attribute values. */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * Normalize a `return_to` value to a same-origin relative path.
 *
 * Only a path beginning with a single `/` survives; absolute URLs,
 * protocol-relative paths, backslashes, control characters, and paths that URL
 * normalization turns protocol-relative are refused. The returned value carries
 * path and query but never a fragment.
 * @param raw - untrusted `return_to` value, or undefined when absent.
 * @param publicOrigin - deployment origin every redirect must stay on.
 * @returns the safe relative path, or undefined when the value is unsafe.
 */
export function normalizeReturnTo(raw: string | null | undefined, publicOrigin: string): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (raw.length > MAX_RETURN_TO_LENGTH) return undefined
  if (!raw.startsWith('/') || raw.startsWith('//')) return undefined
  if (raw.includes('\\') || /[\u0000-\u001f\u007f]/.test(raw)) return undefined
  let origin: string
  let target: URL
  try {
    // The base only resolves a relative reference; an absolute or
    // protocol-relative value yields another origin and is refused below.
    const base = new URL(publicOrigin)
    origin = base.origin
    target = new URL(raw, base)
  } catch (error) {
    // A value WHATWG cannot parse cannot be a usable return path.
    void error
    return undefined
  }
  if (target.origin !== origin) return undefined
  // URL normalization can rewrite `/..//host` into a protocol-relative path, so
  // the same prefix rules are re-checked on the normalized result.
  const relative = `${target.pathname}${target.search}`
  if (!relative.startsWith('/') || relative.startsWith('//') || relative.includes('\\')) return undefined
  return relative
}

/**
 * Resolve the localized message for one login error code.
 * @param errorCode - `?error=` value, or undefined when the page is not an error page.
 * @param language - page language.
 * @returns the message to display, or undefined when no error is present.
 */
export function loginErrorMessage(errorCode: string | undefined, language: PageLanguage): string | undefined {
  if (errorCode === undefined || errorCode === '') return undefined
  const normalized = errorCode.replaceAll('_', '-').toLowerCase()
  return LOGIN_ERROR_COPY[language][normalized] ?? LOGIN_ERROR_FALLBACK[language]
}

/** Shared page chrome around one body section. */
function renderDocument(options: {
  readonly language: PageLanguage
  readonly title: string
  readonly body: string
  /** When set, the document refreshes itself after this many seconds. */
  readonly refreshSeconds?: number | undefined
}): string {
  const lang = options.language === 'zh' ? 'zh-CN' : 'en'
  const refresh = options.refreshSeconds === undefined
    ? ''
    : `<meta http-equiv="refresh" content="${String(options.refreshSeconds)}">\n`
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
${refresh}<style>
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
  background: #0f1115; color: #e8eaed;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
}
main {
  width: min(560px, calc(100vw - 32px)); padding: 40px 32px; border-radius: 16px;
  background: #171a21; border: 1px solid #2a2f3a; text-align: center;
}
.brand { font-size: 13px; letter-spacing: .28em; text-transform: uppercase; color: #8b93a3; }
h1 { margin: 20px 0 12px; font-size: 26px; line-height: 1.3; }
.subtitle { margin: 0 0 28px; color: #b6bdc9; }
.button {
  display: inline-block; padding: 12px 26px; border-radius: 10px; text-decoration: none;
  background: #4d6bfe; color: #ffffff; font-weight: 600;
}
.button:focus-visible { outline: 3px solid #9db0ff; outline-offset: 3px; }
.error { margin: 0 0 24px; padding: 12px; border-radius: 10px; background: #3a1d22; color: #ffb4be; }
.hint { margin: 24px 0 0; color: #8b93a3; font-size: 14px; }
.security { margin: 8px 0 0; color: #6f7787; font-size: 12px; }
.detail { margin: 0 0 20px; color: #b6bdc9; font-size: 14px; }
@media (max-width: 480px) { main { padding: 28px 18px; } h1 { font-size: 22px; } }
</style>
</head>
<body>
${options.body}
</body>
</html>
`
}

/** Options accepted by {@link renderLoginPage}. */
export interface LoginPageOptions {
  readonly language: PageLanguage
  /** `?return_to=` value already normalized to a same-origin relative path. */
  readonly returnTo?: string | undefined
  /** Stable error code from the `?error=` query parameter. */
  readonly errorCode?: string | undefined
}

/**
 * Render the platform login page.
 * @param options - language, safe return path, and optional error code.
 * @returns a complete HTML document referencing no external resource.
 */
export function renderLoginPage(options: LoginPageOptions): string {
  const copy = LOGIN_COPY[options.language]
  const error = loginErrorMessage(options.errorCode, options.language)
  const href = options.returnTo === undefined
    ? AUTH_LOGIN_PATH
    : `${AUTH_LOGIN_PATH}?return_to=${encodeURIComponent(options.returnTo)}`
  const errorBlock = error === undefined
    ? ''
    : `      <p class="error" role="alert">${escapeHtml(error)}</p>\n`
  const body = `<main>
      <div class="brand">${escapeHtml(copy.brand)}</div>
      <h1>${escapeHtml(copy.heading)}</h1>
      <p class="subtitle">${escapeHtml(copy.subtitle)}</p>
${errorBlock}      <a class="button" href="${escapeHtml(href)}">${escapeHtml(copy.button)}</a>
      <p class="hint">${escapeHtml(copy.hint)}</p>
      <p class="security">${escapeHtml(copy.security)}</p>
    </main>`
  return renderDocument({ language: options.language, title: copy.title, body })
}

/** Options accepted by {@link renderStatusPage}. */
export interface StatusPageOptions {
  readonly language: PageLanguage
  /** Anonymous runtime status; never carries a target host or port. */
  readonly status: RuntimeStatusView
}

/**
 * Render the runtime status page shown while a runtime is not READY.
 *
 * The page refreshes itself through a `<meta http-equiv="refresh">` element, so
 * it needs no inline script and the strict script-free CSP stays in force.
 * @param options - language and the anonymous runtime status.
 * @returns a complete HTML document referencing no external resource.
 */
export function renderStatusPage(options: StatusPageOptions): string {
  const copy = STATE_COPY[options.language]
  const heading = copy[options.status.state]
  const detail = options.language === 'zh'
    ? `当前状态：${options.status.state}`
    : `Current state: ${options.status.state}`
  const errorBlock = options.status.errorCode === null
    ? ''
    : `      <p class="detail">${escapeHtml(options.language === 'zh' ? '错误码' : 'Error code')}: ${escapeHtml(options.status.errorCode)}</p>\n`
  const retryHint = options.status.retryable
    ? (options.language === 'zh' ? '可以重试，页面会自动刷新。' : 'A retry may succeed; this page refreshes automatically.')
    : (options.language === 'zh' ? '页面会自动刷新，无需手动操作。' : 'This page refreshes automatically; no action is needed.')
  const body = `<main>
      <div class="brand">DeepSeek Harness</div>
      <h1>${escapeHtml(heading)}</h1>
      <p class="detail">${escapeHtml(detail)}</p>
${errorBlock}      <p class="hint">${escapeHtml(retryHint)}</p>
    </main>`
  return renderDocument({ language: options.language, title: heading, body, refreshSeconds: 3 })
}
