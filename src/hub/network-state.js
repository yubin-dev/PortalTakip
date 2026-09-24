import {existsSync, readFileSync, renameSync, unlinkSync, writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {dirname, join} from 'node:path';

export const networkStatePath = (configPath) => join(dirname(configPath), 'network-state.json');
const addressesOnly = (values) => [...new Set(values.filter((value) =>
  typeof value === 'string' && /^[0-9.]{7,15}$/.test(value)))].sort();

export function acknowledgeNetwork(configPath, addresses) {
  const path = networkStatePath(configPath);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({addresses: addressesOnly(addresses)}) + '\n',
      {flag: 'wx', mode: 0o600});
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) {
      try { unlinkSync(temporary); } catch { /* temporary cleanup only */ }
    }
  }
}

export function networkStatus(configPath, current) {
  const addresses = addressesOnly(current);
  let previous;
  try {
    const value = JSON.parse(readFileSync(networkStatePath(configPath), 'utf8'));
    previous = addressesOnly(Array.isArray(value?.addresses) ? value.addresses : []);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      acknowledgeNetwork(configPath, addresses);
      previous = addresses;
    } else if (error instanceof SyntaxError) {
      return {previous: [], changed: true, repairRequired: true};
    } else throw error;
  }
  return {previous, changed: JSON.stringify(previous) !== JSON.stringify(addresses)};
}
