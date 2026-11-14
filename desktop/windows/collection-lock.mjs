import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
// Recovery is itself exclusive. A crash during recovery fails closed; it never
// unlinks another launcher's newly acquired lock.
export function acquireCollectionLock(file, details = {}) {
  if (file instanceof URL) file = fileURLToPath(file);
  const guard = file + ".recovery";
  let descriptor;
  try {
    descriptor = fs.openSync(guard, "wx");
  } catch (e) {
    if (e.code === "EEXIST") return null;
    throw e;
  }
  const token = randomUUID();
  try {
    if (fs.existsSync(file)) {
      const old = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!Number.isSafeInteger(old.pid) || old.pid < 1)
        throw Error("Invalid collection lock");
      try {
        process.kill(old.pid, 0);
        return null;
      } catch (e) {
        if (e.code !== "ESRCH") return null;
      }
      fs.unlinkSync(file);
    }
    const fd = fs.openSync(file, "wx");
    try {
      fs.writeFileSync(
        fd,
        JSON.stringify({ ...details, pid: process.pid, token }),
      );
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    fs.closeSync(descriptor);
    fs.unlinkSync(guard);
  }
  return () => {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value.token !== token) throw Error("Collection lock owner changed");
    fs.unlinkSync(file);
  };
}
