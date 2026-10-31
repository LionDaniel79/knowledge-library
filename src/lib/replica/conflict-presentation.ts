import type { OutboxEntry } from "./contracts";
import { categoryName } from "../catalog";
import { noteKindNames } from "../note-kinds";
import { relationNames, type Relation } from "../knowledge";
import { formatNames, type Format } from "../domain";
import { bundleRelations } from "../thought-bundles";

export interface ConflictContext {
  bookTitles: Record<string, string>;
  topicNames: Record<string, string>;
  sourceTitles: Record<string, string>;
  bookDetails?: Record<string, string>;
}
export interface ConflictPreview {
  title: string;
  fields: { key: string; label: string; value: string; different: boolean }[];
  body?: string;
  image?: string;
  intent?: string;
  missing?: boolean;
  board?: { points: { x: number; y: number }[] };
}
type Row = Record<string, any>;
type ReviewInput = {
  entry: Pick<OutboxEntry, "command">;
  base?: unknown;
  latest?: unknown;
  local?: unknown;
  primary?: { entity: string } | null;
  context?: ConflictContext;
  unavailable?: string | null;
};
const row = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
const words = (value: unknown) => (typeof value === "string" ? value : "");
const list = (value: unknown) =>
  Array.isArray(value)
    ? value.map(words).filter(Boolean).sort().join(", ")
    : "";
const states: Record<string, string> = {
  reading: "읽는 중",
  completed: "완독",
  pending: "검토 전",
  accepted: "확정",
  rejected: "거절",
  suggested: "제안",
  deferred: "보류",
  applied: "반영 완료",
  superseded: "다른 후보로 대체",
  excluded: "서재에서 제외",
  restored: "복원",
};
const operations: Record<string, string> = {
  saveMemoBundle: "생각 묶음 저장",
  archiveMemoBundle: "생각 묶음 보관해제",
  saveBundleLink: "묶음 연결 저장",
  addNote: "메모 추가",
  editNote: "메모 수정",
  deleteNote: "메모 삭제",
  restoreNote: "메모 복원",
  emptyNoteTrash: "휴지통 비우기",
  updateProgress: "읽은 쪽 기록",
  completeReading: "완독 설정",
  editCompletion: "완독 날짜 수정",
  startReading: "읽기 시작",
  addBook: "도서 추가",
  editBook: "도서 정보 수정",
  saveWhiteboard: "화이트보드 배치",
  setWhiteboardNoteVisibility: "화이트보드 표시 설정",
  setWhiteboardNotesVisibility: "화이트보드 일괄 표시 설정",
  upsertTopic: "주제 수정",
  deleteTopic: "주제 삭제",
  restoreTopic: "주제 복원",
  assignTopic: "주제 분류",
  linkTopics: "주제 연결",
  decideTopicLink: "주제 연결 검토",
  connect: "메모 연결",
  editConnection: "메모 연결 수정",
  connectWhiteboardNotes: "메모 연결",
  createResearch: "글감 묶음 만들기",
  updateResearch: "글감 묶음 수정",
  deleteResearch: "글감 삭제",
  addResearchNote: "글감 추가",
  placeResearchItem: "글감 배치",
  moveResearchItems: "글감 순서 수정",
  setThoughtEvent: "기록 정보 수정",
  decideCandidate: "연결 후보 검토",
};
function commandOf(entry: Pick<OutboxEntry, "command">) {
  const c = row(entry.command);
  return { command: c, body: row(c.body), payload: row(c.body?.payload) };
}
export function queuedConflictRow(
  entry: Pick<OutboxEntry, "command" | "entityId">,
): Row {
  const c = row(entry.command),
    effects = Array.isArray(c.effects) ? c.effects : [];
  return row(
    effects.find(
      (e) => e.entity !== "library_revisions" && e.after?.id === entry.entityId,
    )?.after ??
      effects.find((e) => e.entity !== "library_revisions")?.after ??
      c.base ??
      c.body?.payload,
  );
}
function operation(entry: Pick<OutboxEntry, "command">) {
  const { command, body } = commandOf(entry);
  return command.path === "/api/catalog-review"
    ? "도서정보 후보 검토"
    : command.path === "/api/note-tags"
      ? "태그 삭제"
      : command.path === "/api/book-exclusions"
        ? body.action === "delete"
          ? "소장 도서 삭제"
          : "제외 자료 복원"
        : (operations[body.type] ?? "자료 변경");
}
function titleOf(r: Row, context: ConflictContext) {
  const title =
    words(r.title) ||
    words(r.name) ||
    words(r.book_snapshot?.title) ||
    words(r.record?.title);
  if (title && title !== "미분류 메모") return title;
  return (
    words(r.content).trim().split("\n")[0]?.slice(0, 80) ||
    context.bookTitles[r.book_id] ||
    context.topicNames[r.topic_id] ||
    title ||
    ""
  );
}
export function describeQueuedConflict(
  entry: OutboxEntry,
  context: ConflictContext = {
    bookTitles: {},
    topicNames: {},
    sourceTitles: {},
  },
) {
  const r = queuedConflictRow(entry),
    op = operation(entry),
    { body } = commandOf(entry);
  return {
    operation: op,
    title:
      body.type === "saveWhiteboard" ? "화이트보드" : titleOf(r, context) || op,
    detail:
      r.current_page != null
        ? `${r.current_page}쪽`
        : words(r.content).slice(0, 100) ||
          states[r.status] ||
          "내용을 비교해 선택하세요.",
  };
}

export function presentConflict(review: ReviewInput) {
  const context = review.context ?? {
      bookTitles: {},
      topicNames: {},
      sourceTitles: {},
    },
    { command, body } = commandOf(review.entry),
    entity = review.primary?.entity ?? "",
    type = words(body.type),
    op = operation(review.entry);
  function preview(value: unknown, side: "server" | "pc"): ConflictPreview {
    const r = row(value),
      fields: ConflictPreview["fields"] = [];
    const add = (key: string, label: string, v: unknown) =>
      fields.push({
        key,
        label,
        value: v === null || v === undefined || v === "" ? "미입력" : String(v),
        different: false,
      });
    const result: ConflictPreview = {
      title: titleOf(r, context),
      fields,
      missing: value == null,
    };
    const image = words(r.cover_url) || words(r.record?.facts?.coverUrl);
    if (/^https?:\/\//i.test(image) || image.startsWith("/api/"))
      result.image = image;
    if (value == null) {
      result.title = "해당 자료 없음";
      return result;
    }
    if (type === "deleteResearch") {
      const chapters = r.writingBoard?.data?.writing?.chapters;
      result.intent =
        side === "pc" ? "이 글감의 목차와 배치 삭제" : "최신 글감 유지";
      add("title", "글감 제목", r.title);
      add("question", "글감 내용", r.question);
      add(
        "chapters",
        "목차",
        Array.isArray(chapters)
          ? chapters.map((c: Row) => `${c.order}. ${c.title}`).join(" / ") ||
              "없음"
          : "없음",
      );
      add("board_version", "보드 버전", r.writingBoard?.version ?? 0);
      return result;
    }
    if (entity === "library_memo_bundles") {
      add("title", "생각 묶음 이름", r.title);
      add("description", "정리 내용", r.description);
      add(
        "note_ids",
        "담긴 메모",
        Array.isArray(r.note_ids)
          ? r.note_ids
              .map((id: string) => context.sourceTitles["note:" + id] || "메모")
              .join(", ")
          : "없음",
      );
      add("archived_at", "보관 상태", r.archived_at ? "보관해제" : "사용 중");
    } else if (entity === "library_bundle_links") {
      add(
        "source_id",
        "출발 생각 묶음",
        context.sourceTitles["bundle:" + r.source_id] || "생각 묶음",
      );
      add(
        "target_id",
        "도착 생각 묶음",
        context.sourceTitles["bundle:" + r.target_id] || "생각 묶음",
      );
      add(
        "relation",
        "묶음 관계",
        bundleRelations[r.relation as keyof typeof bundleRelations] ||
          r.relation,
      );
      add("reason", "연결 이유", r.reason);
      add("status", "연결 상태", r.status === "accepted" ? "연결됨" : "해제됨");
    } else if (entity === "library_whiteboards" || type === "saveWhiteboard") {
      const data = row(r.data),
        positions = Object.values(row(data.positions))
          .map(row)
          .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
      result.title = "화이트보드";
      add(
        "positions",
        "배치 위치",
        `${positions.length.toLocaleString("ko-KR")}개`,
      );
      add(
        "groups",
        "직접 만든 묶음",
        `${Array.isArray(data.groups) ? data.groups.length : 0}개`,
      );
      add(
        "links",
        "묶음 연결 수",
        `${Array.isArray(data.links) ? data.links.length : 0}개`,
      );
      add("query", "검색어", data.filter?.q || "전체");
      add(
        "hidden_notes",
        "가린 메모",
        Array.isArray(data.hiddenNoteIds) && data.hiddenNoteIds.length
          ? data.hiddenNoteIds
              .slice(0, 20)
              .map((id: string) => context.sourceTitles[`note:${id}`] || "메모")
              .join(", ") +
              (data.hiddenNoteIds.length > 20
                ? ` 외 ${data.hiddenNoteIds.length - 20}개`
                : "")
          : "없음",
      );
      const groupName = (id: string) =>
        id === "unclassified"
          ? "미분류 메모"
          : typeof id === "string" && id.startsWith("topic:")
            ? context.topicNames[id.slice(6)] || "등록된 주제"
            : data.groups?.find((g: Row) => g.id === id)?.title || "메모 묶음";
      const names = (values: unknown, resolve: (id: string) => string) =>
        Array.isArray(values)
          ? values.map(words).filter(Boolean).map(resolve).join(", ") || "전체"
          : "전체";
      add(
        "filter_topics",
        "주제 필터",
        names(
          data.filter?.topics,
          (id) => context.topicNames[id] || "등록된 주제",
        ),
      );
      add("filter_tags", "태그 필터", list(data.filter?.tags) || "전체");
      add(
        "filter_categories",
        "분야 필터",
        names(data.filter?.categories, (id) => categoryName(id)),
      );
      add(
        "filter_books",
        "도서 필터",
        names(
          data.filter?.books,
          (id) => context.bookTitles[id] || "등록된 도서",
        ),
      );
      const groups = Array.isArray(data.groups) ? data.groups : [],
        links = Array.isArray(data.links) ? data.links : [];
      add(
        "group_details",
        "묶음 구성",
        groups.length
          ? groups
              .slice(0, 20)
              .map(
                (g: Row) =>
                  `${g.title} (${g.noteIds?.length || 0}개 메모)${
                    Array.isArray(g.noteIds)
                      ? ": " +
                        g.noteIds
                          .slice(0, 5)
                          .map(
                            (id: string) =>
                              context.sourceTitles[`note:${id}`] ||
                              "저장된 메모",
                          )
                          .join(", ")
                      : ""
                  }`,
              )
              .join("\n") +
              (groups.length > 20 ? `\n외 ${groups.length - 20}개 묶음` : "")
          : "없음",
      );
      add(
        "link_details",
        "묶음 연결",
        links.length
          ? links
              .slice(0, 20)
              .map(
                (l: Row) => `${groupName(l.source)} ↔ ${groupName(l.target)}`,
              )
              .join("\n") +
              (links.length > 20 ? `\n외 ${links.length - 20}개 연결` : "")
          : "없음",
      );
      add(
        "collapsed",
        "접힌 묶음",
        Array.isArray(data.collapsed) && data.collapsed.length
          ? data.collapsed.slice(0, 20).map(groupName).join(", ") +
              (data.collapsed.length > 20
                ? ` 외 ${data.collapsed.length - 20}개`
                : "")
          : "없음",
      );
      add(
        "group_positions",
        "묶음 배치",
        `${Object.keys(row(data.groupPositions)).length}개 위치 저장`,
      );
      result.board = {
        points: positions
          .filter(
            (_, i) => i % Math.max(1, Math.ceil(positions.length / 160)) === 0,
          )
          .slice(0, 160)
          .map((p) => ({ x: p.x, y: p.y })),
      };
    } else if (
      entity === "library_cycles" ||
      [
        "updateProgress",
        "completeReading",
        "editCompletion",
        "startReading",
      ].includes(type)
    ) {
      result.title = context.bookTitles[r.book_id] || "독서 기록";
      add(
        "current_page",
        "읽은 쪽수",
        r.current_page == null ? null : `${r.current_page}쪽`,
      );
      add("status", "독서 상태", states[r.status] || "미입력");
      add("started_on", "읽기 시작", r.started_on);
      add("completed_on", "완독 날짜", r.completed_on);
    } else if (
      entity === "library_notes" ||
      ["addNote", "editNote", "deleteNote", "restoreNote"].includes(type)
    ) {
      add("title", "제목", r.title);
      add(
        "kind",
        "기록 종류",
        noteKindNames[r.kind as keyof typeof noteKindNames] || "내 기록",
      );
      add(
        "book_id",
        "연결된 책",
        r.book_id
          ? context.bookTitles[r.book_id] || "등록된 도서"
          : "책과 연결하지 않음",
      );
      add("page", "원문 쪽수", r.page == null ? null : `${r.page}쪽`);
      add("tags", "태그", list(r.tags) || "없음");
      result.body = words(r.content);
      if (type === "deleteNote")
        result.intent = side === "pc" ? "휴지통으로 이동" : "현재 기록 유지";
      if (type === "restoreNote")
        result.intent = side === "pc" ? "휴지통에서 복원" : "현재 상태 유지";
      if (
        side === "server" &&
        review.unavailable === "다른 기기에서 휴지통으로 이동했습니다."
      )
        result.intent = "휴지통에 보관";
    } else if (
      entity === "library_catalog_reviews" ||
      command.path === "/api/catalog-review"
    ) {
      const record = row(r.record),
        facts = row(record.facts);
      result.title =
        words(record.title) || words(r.book_snapshot?.title) || "도서정보 후보";
      add("status", "검토 상태", states[r.status] || "검토 전");
      add("title", "도서명", record.title);
      add("author", "저자", facts.author);
      add("publisher", "출판사", facts.publisher);
      add("isbn", "ISBN", record.isbn || facts.isbn);
    } else if (entity === "library_books") {
      for (const [key, label] of [
        ["title", "도서명"],
        ["author", "저자"],
        ["publisher", "출판사"],
        ["isbn", "ISBN"],
      ])
        add(key, label, r[key]);
      add(
        "formats",
        "소장 형태",
        Array.isArray(r.formats)
          ? r.formats.map((f: Format) => formatNames[f] || f).join(", ")
          : null,
      );
      add(
        "total_pages",
        "전체 쪽수",
        r.total_pages == null ? null : `${r.total_pages}쪽`,
      );
      add("shelf", "보관 위치", r.shelf);
      const category = words(r.category);
      add(
        "category",
        "분야",
        category
          ? `${categoryName(category[0] + "00")} (${category})`
          : "미분류",
      );
      add("tags", "태그", list(r.tags) || "없음");
      add("bookshelves", "책장", list(r.bookshelves) || "없음");
      add(
        "cover_url",
        "표지",
        r.cover_url ? "표지 이미지 있음" : "표지 이미지 없음",
      );
    } else if (entity === "library_topic_memberships") {
      result.title =
        context.sourceTitles[`${r.source_kind}:${r.source_id}`] ||
        "자료의 주제 분류";
      add("topic_id", "주제", context.topicNames[r.topic_id] || "등록된 주제");
      add("status", "분류 상태", states[r.status] || r.status);
    } else if (
      entity === "library_connections" ||
      entity === "library_topic_links"
    ) {
      const topicLink = entity === "library_topic_links";
      add(
        "source",
        "출발 자료",
        topicLink
          ? context.topicNames[r.source_topic_id]
          : context.sourceTitles[`${r.source_kind}:${r.source_id}`],
      );
      add(
        "target",
        "도착 자료",
        topicLink
          ? context.topicNames[r.target_topic_id]
          : context.sourceTitles[`${r.target_kind}:${r.target_id}`],
      );
      add(
        "relation",
        "연결 종류",
        relationNames[r.relation as Relation] || "관련된 자료",
      );
      add("status", "연결 상태", states[r.status] || r.status);
      if (r.reason) add("reason", "연결 이유", r.reason);
    } else if (entity === "library_topics") {
      add("name", "주제", r.name);
      add("description", "설명", r.description);
      add("aliases", "다른 표현", list(r.aliases) || "없음");
      add("kdc_codes", "관련 분야", list(r.kdc_codes) || "없음");
      if (type === "deleteTopic")
        result.intent = side === "pc" ? "주제 삭제" : "주제 유지";
      if (type === "restoreTopic")
        result.intent = side === "pc" ? "주제 복원" : "현재 상태 유지";
    } else {
      for (const [key, label] of [
        ["title", "제목"],
        ["name", "이름"],
        ["status", "상태"],
        ["reason", "이유"],
        ["description", "설명"],
      ])
        if (r[key] != null)
          add(key, label, key === "status" ? states[r[key]] || r[key] : r[key]);
      if (typeof r.content === "string") result.body = r.content;
      if (!fields.length && !result.body) add("change", "변경", op);
    }
    return result;
  }
  const server = preview(review.latest, "server"),
    pc = preview(review.local, "pc"),
    changed: string[] = [];
  const keys = [
    ...new Set([
      ...server.fields.map((f) => f.key),
      ...pc.fields.map((f) => f.key),
    ]),
  ];
  for (const key of keys) {
    const a = server.fields.find((f) => f.key === key),
      b = pc.fields.find((f) => f.key === key);
    if (a?.value !== b?.value) {
      if (a) a.different = true;
      if (b) b.different = true;
      changed.push(a?.label || b!.label);
    }
  }
  if (server.body !== pc.body) changed.push("메모 내용");
  if (server.intent !== pc.intent) changed.push("처리");
  if (server.image !== pc.image) {
    changed.push("표지");
    for (const p of [server, pc])
      for (const f of p.fields) if (f.key === "cover_url") f.different = true;
  }
  if (entity === "library_whiteboards") {
    const a = row(row(review.latest).data).positions ?? {},
      b = row(row(review.local).data).positions ?? {};
    const keys = Object.keys(a);
    if (
      keys.length !== Object.keys(b).length ||
      keys.some((k) => a[k]?.x !== b[k]?.x || a[k]?.y !== b[k]?.y)
    )
      changed.push("메모 배치");
    const aData = row(row(review.latest).data),
      bData = row(row(review.local).data);
    for (const [key, label, one, two] of [
      [
        "filter_topics",
        "주제 필터",
        aData.filter?.topics,
        bData.filter?.topics,
      ],
      ["filter_tags", "태그 필터", aData.filter?.tags, bData.filter?.tags],
      [
        "filter_categories",
        "분야 필터",
        aData.filter?.categories,
        bData.filter?.categories,
      ],
      ["filter_books", "도서 필터", aData.filter?.books, bData.filter?.books],
      ["group_details", "묶음 구성", aData.groups, bData.groups],
      ["link_details", "묶음 연결", aData.links, bData.links],
      ["collapsed", "접힌 묶음", aData.collapsed, bData.collapsed],
      ["hidden_notes", "가린 메모", aData.hiddenNoteIds, bData.hiddenNoteIds],
      [
        "group_positions",
        "묶음 배치",
        aData.groupPositions,
        bData.groupPositions,
      ],
    ] as const) {
      if (JSON.stringify(one ?? null) !== JSON.stringify(two ?? null)) {
        if (!changed.includes(label)) changed.push(label);
        for (const p of [server, pc])
          for (const f of p.fields) if (f.key === key) f.different = true;
      }
    }
  }
  const latest = row(review.latest),
    local = row(review.local);
  for (const [key, label] of [
    ["book_id", "연결된 책"],
    ["topic_id", "주제"],
    ["source", "출발 자료"],
    ["target", "도착 자료"],
  ] as const) {
    const first =
      key === "source" || key === "target"
        ? [
            latest[`${key}_kind`],
            latest[`${key}_id`],
            latest[`${key}_topic_id`],
          ]
        : latest[key];
    const second =
      key === "source" || key === "target"
        ? [local[`${key}_kind`], local[`${key}_id`], local[`${key}_topic_id`]]
        : local[key];
    if (JSON.stringify(first ?? null) === JSON.stringify(second ?? null))
      continue;
    const a = server.fields.find((f) => f.key === key),
      b = pc.fields.find((f) => f.key === key);
    if (!a || !b) continue;
    if (!changed.includes(label)) changed.push(label);
    a.different = b.different = true;
    if (a.value === b.value) {
      const detail = (r: Row) =>
        key === "book_id" ? context.bookDetails?.[r.book_id] : null;
      a.value += " · " + (detail(latest) || "온라인 서재의 연결 자료");
      b.value += " · " + (detail(local) || "이 기기에서 선택한 연결 자료");
      if (a.value === b.value) {
        a.value += " · 온라인 소장본";
        b.value += " · 이 기기에서 선택한 소장본";
      }
    }
  }
  return {
    operation: op,
    title: pc.title || server.title || op,
    server,
    pc,
    changed,
    canEditNote: ["addNote", "editNote"].includes(type),
  };
}
