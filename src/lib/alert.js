import { sendText } from '../whatsapp.js';

// ─────────────────────────────────────────────────────────────
// Best-effort admin alerting for payment-critical failures.
//
// Pings ADMIN_ALERT_PHONE over WhatsApp (if configured) and records
// the alert in KV under an 'alert:' key with a 7-day TTL. This is a
// diagnostic side-channel: it MUST never throw and must never break
// the caller's flow.
// ─────────────────────────────────────────────────────────────

const ALERT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

// Short, stable hash of arbitrary text (FNV-1a, base36). Used to make
// the KV key unique-per-detail without depending on Date/time.
function shortHash(text) {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36);
}

export async function alertAdmin(env, event, detail) {
	const detailStr =
		typeof detail === 'string' ? detail : safeStringify(detail);
	const message = `[ALERT] ${event}\n${detailStr}`;

	// WhatsApp ping — best effort, only if a target phone is configured.
	if (env && env.ADMIN_ALERT_PHONE) {
		try {
			await sendText(env.ADMIN_ALERT_PHONE, message, env);
		} catch (err) {
			console.error('[alertAdmin] WhatsApp ping failed:', err);
		}
	}

	// KV record — best effort. Key is event + a short hash of the detail
	// so repeated identical alerts collapse onto one key.
	if (env && env.SESSION_KV) {
		try {
			const key = `alert:${event}:${shortHash(detailStr)}`;
			await env.SESSION_KV.put(
				key,
				JSON.stringify({ event, detail: detailStr, at: new Date().toISOString() }),
				{ expirationTtl: ALERT_TTL_SECONDS }
			);
		} catch (err) {
			console.error('[alertAdmin] KV write failed:', err);
		}
	}
}

function safeStringify(value) {
	try {
		return JSON.stringify(value);
	} catch (err) {
		return String(value);
	}
}
