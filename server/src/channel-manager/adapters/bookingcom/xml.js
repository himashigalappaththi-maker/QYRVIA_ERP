'use strict';

/**
 * Phase 69A (instruction 048) — minimal, dependency-free XML helpers for the
 * Booking.com B.XML availability codec.
 *
 * WHY NO XML LIBRARY: the only operation this phase needs is (a) escaping a
 * handful of known-shape fields into a small, fixed-structure request
 * document and (b) pulling a couple of named tags out of a response body.
 * A full parser/serializer dependency is not justified for that (instruction
 * 048 Section 16: "Do not add a heavyweight XML dependency unless
 * justified"). Every function here is a pure string transform — no DOM, no
 * external state.
 */

/** XML 1.0 predefined entity escaping. Order matters: '&' must be escaped first. */
function escapeXmlText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Same escaping is safe for attribute values too — no separate attribute-only rule needed. */
const escapeXmlAttr = escapeXmlText;

/**
 * Best-effort, non-validating extraction of the first `<tag>...</tag>` or
 * self-closing `<tag .../>` element's text content. Returns null when the
 * tag is absent or the input is not a string — never throws on malformed
 * XML, matching this codebase's "malformed provider response must never
 * take down the delivery attempt" convention (see transport.js's
 * readBoundedBody header comment).
 *
 * NOT a general XML parser: does not handle nested same-named tags,
 * namespaces, or CDATA specially. Sufficient for pulling a single
 * known-shape acknowledgement/error tag out of a small response document.
 */
function extractXmlTagText(xmlText, tagName) {
  if (typeof xmlText !== 'string' || !xmlText || !tagName) return null;
  const safeName = String(tagName).replace(/[^a-zA-Z0-9_:-]/g, '');
  if (!safeName) return null;
  const openClose = new RegExp('<' + safeName + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + safeName + '>', 'i');
  const m = xmlText.match(openClose);
  if (m) return m[1].trim();
  // Self-closing with no text content (e.g. <ok/>) — presence, not text.
  const selfClosing = new RegExp('<' + safeName + '(?:\\s[^>]*)?/>', 'i');
  return selfClosing.test(xmlText) ? '' : null;
}

/** True when the (case-insensitive) tag is present in the text, open/close or self-closing. */
function hasXmlTag(xmlText, tagName) {
  return extractXmlTagText(xmlText, tagName) !== null;
}

/**
 * Phase 69A (instruction 049) — Booking.com's DOCUMENTED B.XML Availability
 * RUID shape is a response COMMENT, not an element:
 *   <!-- RUID: [VALUE] -->
 * (instruction 048's `<ruid>`/`<RUID>` ELEMENT-only extraction was
 * insufficient — corrected here; extractXmlTagText's element-based lookup is
 * still used as a compatibility fallback by the caller, never as primary.)
 *
 * Tolerant of whitespace and an optional surrounding `[...]`. Bounded to
 * maxLength. NEVER throws — a malformed/absent/unterminated comment simply
 * returns null, never a fabricated value.
 */
function extractRuidComment(xmlText, maxLength = 200) {
  if (typeof xmlText !== 'string' || !xmlText) return null;
  const m = xmlText.match(/<!--\s*RUID\s*:\s*([\s\S]*?)\s*-->/i);
  if (!m) return null;
  let value = (m[1] || '').trim();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1).trim();
  if (!value) return null;
  return value.slice(0, maxLength);
}

module.exports = { escapeXmlText, escapeXmlAttr, extractXmlTagText, hasXmlTag, extractRuidComment };
