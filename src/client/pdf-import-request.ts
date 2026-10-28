/** PDF control requests return a short acknowledgement; folder work runs on the PC. */
export async function pdfImportRequest<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs = 20000,
): Promise<T> {
  const controller = new AbortController(),
    outer = init.signal;
  let timedOut = false;
  const abort = () => controller.abort();
  if (outer?.aborted) abort();
  outer?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    abort();
  }, timeoutMs);
  try {
    const r = await fetch(path, {
      ...init,
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await r.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw Error(
        `PC 서재에서 정상 응답을 받지 못했습니다 (${r.status}). 진행 현황을 다시 확인해 주세요.`,
      );
    }
    if (!r.ok)
      throw Error(
        data?.error || `PDF 등록 요청을 처리하지 못했습니다 (${r.status}).`,
      );
    if (!data || typeof data !== "object" || !("job" in data))
      throw Error("PDF 등록 현황을 확인하지 못했습니다. 다시 조회해 주세요.");
    return data;
  } catch (error) {
    if (timedOut)
      throw Error(
        "PC의 응답이 지연되고 있습니다. 등록 여부를 다시 확인해 주세요.",
      );
    throw error;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", abort);
  }
}
