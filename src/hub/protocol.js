const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const secret = /^[A-Za-z0-9_-]{43}$/;
const account = /^(?=.*[A-Za-z_-])[A-Za-z0-9_-]{16,128}$/;

export const MAX_WS_BYTES = 8 * 1024;
export const MAX_ADMIN_BYTES = 16 * 1024;

export function exactObject(value, required, optional = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
}

export function validRequestId(value) {
  return typeof value === 'string' && uuid.test(value);
}

export function validAccountCode(value) {
  return typeof value === 'string' && account.test(value);
}

export function validPortal(value) {
  return value === 'GİB' || value === 'SGK';
}

export function validateClientMessage(value, authenticated) {
  if (!authenticated) {
    if (!exactObject(value, ['type', 'organizationCode', 'staffToken'], ['lastHubId']) ||
        value.type !== 'HELLO' || typeof value.organizationCode !== 'string' ||
        typeof value.staffToken !== 'string' ||
        !secret.test(value.organizationCode) || !secret.test(value.staffToken) ||
        (value.lastHubId !== undefined &&
          (typeof value.lastHubId !== 'string' || !uuid.test(value.lastHubId)))) {
      return {ok: false, code: 'INVALID_HELLO'};
    }
    return {ok: true, value};
  }
  if (exactObject(value, ['type'], ['requestId']) && value.type === 'STATE' &&
      (value.requestId === undefined || validRequestId(value.requestId))) {
    return {ok: true, value};
  }
  if (exactObject(value, ['type', 'requestId', 'portal', 'accountCode']) &&
      ['ACQUIRE', 'RELEASE', 'CANCEL', 'CONFIRM'].includes(value.type) &&
      validRequestId(value.requestId) && validPortal(value.portal) &&
      validAccountCode(value.accountCode)) {
    return {ok: true, value};
  }
  return {ok: false, code: 'INVALID_MESSAGE'};
}
