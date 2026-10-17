import { runLocalQuery, type LocalIndex, type QueryKind } from "./queries";
let data: LocalIndex,
  owner = "";
self.onmessage = async (event: MessageEvent) => {
  const m = event.data;
  try {
    if (m.type === "init") {
      data = m.data;
      owner = m.owner;
      self.postMessage({ id: m.id, result: true });
    } else if (m.type === "query") {
      if (!data) throw Error("검색 자료를 준비하고 있습니다.");
      self.postMessage({
        id: m.id,
        result: await runLocalQuery(data, owner, m.kind as QueryKind, m.input),
      });
    }
  } catch (error) {
    self.postMessage({
      id: m.id,
      error:
        error instanceof Error ? error.message : "기기 검색에 실패했습니다.",
      status: (error as { status?: number })?.status ?? 400,
    });
  }
};
