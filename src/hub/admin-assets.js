import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {getAsset, isSea} from 'node:sea';

export function readAdminAsset(name) {
  if (isSea()) return Buffer.from(getAsset(`admin/${name}`));
  return readFileSync(resolve('src/hub/admin', name));
}
