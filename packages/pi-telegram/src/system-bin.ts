import { accessSync, constants } from "node:fs";
import { join } from "node:path";

/** util-linux installs helpers in one of a few fixed directories. Distros differ: Debian and
 * Fedora use /usr/bin, NixOS keeps them under the system profile. */
const DIRECTORIES = ["/usr/bin", "/bin", "/usr/local/bin", "/run/current-system/sw/bin"];

/** First readable executable for `name`, or undefined. Never consults PATH: an executable the
 * environment chooses is not a fixed executable. Callers decide whether absence is fatal. */
export function systemBin(name: string): string | undefined {
  return DIRECTORIES.map(directory => join(directory, name)).find(candidate => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** The kernel-lock helper behind bot ownership and the delivery ledger. */
export const FLOCK = systemBin("flock");
