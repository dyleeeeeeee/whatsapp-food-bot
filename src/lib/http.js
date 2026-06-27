/**
 * src/lib/http.js — fetch with timeout + retry/backoff
 *
 * Pure module. No app imports. Wraps the global fetch so external calls
 * (WhatsApp Cloud API, Flutterwave) don't hang forever and survive
 * transient failures.
 *
 * Behaviour:
 *   - Each attempt is bounded by AbortSignal.timeout(timeoutMs).
 *   - Retries on network error (fetch throws), HTTP 429, and HTTP 5xx.
 *   - Exponential backoff between attempts; if a Retry-After header is
 *     present (seconds or HTTP-date), it is honoured instead.
 *   - 4xx responses (other than 429) are returned as-is — they are not
 *     transient, so retrying is pointless.
 *   - Returns the final Response. Only throws if every attempt failed
 *     with a network/timeout error (mirrors fetch's own contract).
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Parse a Retry-After header into milliseconds.
 * Supports both delta-seconds ("120") and HTTP-date forms.
 * Returns null when absent or unparseable.
 */
function parseRetryAfter(response) {
  const header = response && response.headers
    ? response.headers.get('Retry-After')
    : null;
  if (!header) return null;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - Date.now());
  }

  return null;
}

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * fetch wrapper with timeout and retry/backoff.
 *
 * @param {string|Request} url
 * @param {object} options - standard fetch options (a `signal` is added)
 * @param {object} cfg
 * @param {number} cfg.retries   - extra attempts after the first (default 2)
 * @param {number} cfg.timeoutMs - per-attempt timeout (default 8000)
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(
  url,
  options = {},
  { retries = 2, timeoutMs = 8000 } = {}
) {
  let lastError = null;

  // total attempts = first try + `retries` retries
  for (let attempt = 0; attempt <= retries; attempt++) {
    const isLast = attempt === retries;

    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!isRetryableStatus(response.status) || isLast) {
        return response;
      }

      // Retryable status with attempts left — back off, then retry.
      const retryAfter = parseRetryAfter(response);
      const backoff = retryAfter !== null
        ? retryAfter
        : 2 ** attempt * 500;
      await sleep(backoff);
      continue;
    } catch (err) {
      // Network error / timeout (AbortError). Retry unless out of tries.
      lastError = err;
      if (isLast) throw err;
      await sleep(2 ** attempt * 500);
    }
  }

  // Unreachable in practice — loop either returns or throws above.
  throw lastError;
}
