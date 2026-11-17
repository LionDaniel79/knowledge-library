import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

// Windows readers can briefly deny replacement while a status refresh is open.
// Keep atomic replacement: never truncate the existing checkpoint as a fallback.
export function writeCollectionState(
  file,
  value,
  {
    io = fs,
    wait = (ms) =>
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  } = {},
) {
  if (file instanceof URL) file = fileURLToPath(file);
  const temp = String(file) + "." + randomUUID() + ".tmp";
  try {
    io.writeFileSync(temp, JSON.stringify(value, null, 2));
    for (let attempt = 0; ; attempt++) {
      try {
        io.renameSync(temp, file);
        break;
      } catch (error) {
        if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 9)
          throw error;
        wait(Math.min(40 * (attempt + 1), 250));
      }
    }
  } catch (error) {
    error.collectionStateWrite = true;
    throw error;
  } finally {
    if (io.existsSync(temp)) io.unlinkSync(temp);
  }
}
