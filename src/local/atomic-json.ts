import { writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
/** Windows readers/antivirus may briefly deny replacing an open checkpoint. */
export async function atomicWriteJson(path: string, value: unknown) {
  const temporary = path + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temporary, path);
      return;
    } catch (e) {
      if (
        attempt >= 8 ||
        !["EPERM", "EACCES", "EBUSY"].includes(
          (e as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw e;
      await new Promise((r) =>
        setTimeout(r, Math.min(1000, 50 * 2 ** attempt)),
      );
    }
  }
}
