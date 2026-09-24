const secretPattern = /^[A-Za-z0-9_-]{43}$/;

function invalid(field, message) { return {ok: false, field, message}; }

/** Accept literal private/link-local/loopback addresses and the literal localhost name. */
export function normalizeLanHost(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (raw.toLowerCase() === 'localhost') return 'localhost';
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(raw)) {
    const parts = raw.split('.');
    if (parts.some((part) => (part.length > 1 && part[0] === '0') || Number(part) > 255)) {
      return null;
    }
    const [a, b] = parts.map(Number);
    if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) || (a === 169 && b === 254)) return raw;
    return null;
  }
  const address = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  if (!address.includes(':') || !/^[0-9a-fA-F:]+$/.test(address)) return null;
  try {
    const parsed = new URL(`http://[${address}]/`);
    const normalized = parsed.hostname.slice(1, -1);
    if (normalized === '::1') return '[::1]';
    const first = Number.parseInt(normalized.split(':')[0], 16);
    if ((first >= 0xfc00 && first <= 0xfdff) ||
        (first >= 0xfe80 && first <= 0xfebf)) return `[${normalized}]`;
  } catch { /* malformed IPv6 */ }
  return null;
}

export function validateConnectionInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return invalid('form', 'Bağlantı bilgileri geçersiz.');
  }
  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
  if (displayName.length < 2 || displayName.length > 80 || /[\u0000-\u001f]/.test(displayName)) {
    return invalid('displayName', 'Ad soyad 2–80 karakter olmalı.');
  }
  const organizationName = typeof input.organizationName === 'string' ?
    input.organizationName.trim() : '';
  if (organizationName.length < 2 || organizationName.length > 100 ||
      /[\u0000-\u001f]/.test(organizationName)) {
    return invalid('organizationName', 'Kurum adı 2–100 karakter olmalı.');
  }
  const host = normalizeLanHost(input.host);
  if (!host) {
    return invalid('host', 'Yalnızca özel/yerel IP adresi veya localhost kabul edilir.');
  }
  const portText = typeof input.port === 'number' ? String(input.port) : input.port;
  if (typeof portText !== 'string' || !/^\d{1,5}$/.test(portText) ||
      Number(portText) < 1 || Number(portText) > 65535) {
    return invalid('port', 'Port 1–65535 arasında olmalı.');
  }
  if (typeof input.organizationCode !== 'string' ||
      !secretPattern.test(input.organizationCode)) {
    return invalid('organizationCode', 'Kurum kodu 43 karakterlik geçerli kod olmalı.');
  }
  if (typeof input.staffToken !== 'string' || !secretPattern.test(input.staffToken)) {
    return invalid('staffToken', 'Personel erişim anahtarı geçersiz.');
  }
  return {ok: true, value: {displayName, organizationName, host,
    port: Number(portText), organizationCode: input.organizationCode,
    staffToken: input.staffToken}};
}

export function websocketUrl(config) {
  return `ws://${config.host}:${config.port}/ws`;
}
