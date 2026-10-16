const form = document.getElementById("draft-form"),
  status = document.getElementById("status");
let owner = null;
try {
  owner = localStorage.getItem("knowledge-library-offline-owner:v1");
} catch {}
if (!owner || owner.length > 128) {
  form.hidden = true;
  status.textContent =
    "먼저 온라인 서재에서 이 기기의 오프라인 새 기록 사용을 켜 주세요.";
}
form.addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    if (
      !owner ||
      localStorage.getItem("knowledge-library-offline-owner:v1") !== owner
    )
      throw Error(
        "같은 계정의 온라인 서재에서 오프라인 기록 설정을 확인해 주세요.",
      );
    const data = new FormData(form),
      title = String(data.get("title") || "").trim(),
      content = String(data.get("content") || "").trim();
    if (!title || title.length > 300 || !content || content.length > 50000)
      throw Error("제목과 내용을 확인해 주세요.");
    const prefix =
      "knowledge-library-draft:v1:" + encodeURIComponent(owner) + ":";
    let count = 0,
      total = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith(prefix)) {
        count++;
        total += (localStorage.getItem(k) || "").length;
      }
    }
    const id = crypto.randomUUID(),
      draft = {
        version: 1,
        id,
        ownerId: owner,
        createdAt: new Date().toISOString(),
        command: {
          requestId: id,
          type: "addNote",
          payload: {
            title,
            content,
            bookId: null,
            page: null,
            tags: [],
            kind: "thought",
          },
        },
      },
      text = JSON.stringify(draft);
    if (count >= 50 || total + text.length > 1000000)
      throw Error(
        "임시 기록 보관 한도입니다. 인터넷 연결 후 서재에 저장해 주세요.",
      );
    localStorage.setItem(prefix + id, text);
    form.reset();
    status.textContent =
      "이 기기에 임시 저장했습니다. 온라인 서재에서 확인하고 저장하세요.";
  } catch (e) {
    status.textContent =
      "임시 저장하지 못했습니다. 입력한 글은 유지됩니다. " + e.message;
  }
});
