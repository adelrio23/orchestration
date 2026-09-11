import dns from 'node:dns/promises';
import net from 'node:net';
import { redact } from './process.mjs';

// Live research with real citations. Every claim an agent later makes about the
// market must trace to an entry here: a URL, the time it was fetched, and the
// text actually retrieved. Nothing is generated, summarised or inferred in this
// module — it only fetches and records.

export const RESEARCH_LIMITS = { maxSources: 8, maxBytes: 400000, perSourceChars: 6000, totalChars: 30000, timeoutMs: 20000 };

function privateAddress(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a >= 224;
  }
  if (v === 6) {
    const low = ip.toLowerCase();
    return low === '::1' || low === '::' || low.startsWith('fc') || low.startsWith('fd') || low.startsWith('fe80') || low.startsWith('::ffff:');
  }
  return true;
}

// The coordinator reaches the public web only. A source that resolves to a
// loopback, link-local or private address is refused rather than fetched.
export async function assertPublicHttps(rawUrl, resolver = dns) {
  let url;
  try { url = new URL(rawUrl); } catch { throw Error('Each source must be a full https:// URL'); }
  if (url.protocol !== 'https:') throw Error('Only https:// sources are fetched');
  if (url.username || url.password) throw Error('Credentials in a source URL are refused');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) { if (privateAddress(host)) throw Error(`Refused a private or loopback address: ${host}`); return url; }
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) throw Error(`Refused a local hostname: ${host}`);
  const addresses = await resolver.lookup(host, { all: true }).catch(() => { throw Error(`Could not resolve ${host}`); });
  if (!addresses.length) throw Error(`Could not resolve ${host}`);
  for (const { address } of addresses) if (privateAddress(address)) throw Error(`Refused a private or loopback address for ${host}`);
  return url;
}

export function extractText(html) {
  const withoutNoise = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(withoutNoise)?.[1]?.trim().slice(0, 300) || null;
  const text = withoutNoise
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, m => ({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[m]))
    .replace(/\s+/g, ' ')
    .trim();
  return { title, text };
}

export async function fetchSource(rawUrl, { fetcher = fetch, resolver = dns } = {}) {
  const url = await assertPublicHttps(rawUrl, resolver);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESEARCH_LIMITS.timeoutMs);
  try {
    const response = await fetcher(url.href, { redirect: 'error', signal: controller.signal, headers: { accept: 'text/html,text/plain' } });
    if (!response.ok) return { url: url.href, fetchedAt: new Date().toISOString(), ok: false, error: `HTTP ${response.status}` };
    const body = (await response.text()).slice(0, RESEARCH_LIMITS.maxBytes);
    const { title, text } = extractText(body);
    if (!text) return { url: url.href, fetchedAt: new Date().toISOString(), ok: false, error: 'No readable text at this source' };
    return {
      url: url.href, fetchedAt: new Date().toISOString(), ok: true, title,
      excerpt: redact(text).slice(0, RESEARCH_LIMITS.perSourceChars),
      truncated: text.length > RESEARCH_LIMITS.perSourceChars
    };
  } catch (error) {
    const reason = error?.name === 'AbortError' ? 'Timed out' : redact(String(error?.message || error));
    return { url: rawUrl, fetchedAt: new Date().toISOString(), ok: false, error: reason };
  } finally { clearTimeout(timer); }
}

// Fetches the named sources once. Makes no model call and spends no call budget;
// reviewing this evidence is a separate, explicit step.
export async function gatherEvidence(question, urls, options = {}) {
  if (typeof question !== 'string' || !question.trim() || question.length > 2000) throw Error('Describe the research question (at most 2000 characters)');
  if (!Array.isArray(urls) || !urls.length) throw Error('List at least one https:// source to read');
  if (urls.length > RESEARCH_LIMITS.maxSources) throw Error(`At most ${RESEARCH_LIMITS.maxSources} sources per research round`);
  const unique = [...new Set(urls.map(u => String(u).trim()).filter(Boolean))];
  const sources = [];
  let budget = RESEARCH_LIMITS.totalChars;
  for (const url of unique) {
    const source = await fetchSource(url, options);
    if (source.ok) {
      source.excerpt = source.excerpt.slice(0, Math.max(0, budget));
      budget -= source.excerpt.length;
      if (!source.excerpt) { sources.push({ url: source.url, fetchedAt: source.fetchedAt, ok: false, error: 'Total evidence budget reached before this source' }); continue; }
    }
    sources.push(source);
  }
  return {
    question: question.trim(), at: new Date().toISOString(), sources,
    retrieved: sources.filter(s => s.ok).length,
    failed: sources.filter(s => !s.ok).map(s => ({ url: s.url, error: s.error })),
    review: null,
    note: 'Verbatim excerpts retrieved at the stated times. Not a complete market survey, and no claim here has been checked for accuracy.'
  };
}

// A plan may only cite research an independent agent has examined and passed.
export function usableEvidence(research) {
  if (!research?.review?.passed) return null;
  return {
    question: research.question,
    reviewedBy: research.review.provider,
    reviewedAt: research.review.at,
    citations: research.sources.filter(s => s.ok).map(s => ({ url: s.url, title: s.title, fetchedAt: s.fetchedAt, excerpt: s.excerpt, truncated: s.truncated })),
    rules: 'Every market claim must cite one of these URLs. State "not supported by the retrieved sources" instead of inferring anything they do not say.'
  };
}
