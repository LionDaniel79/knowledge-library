import type { OutboxEntry } from "../../lib/replica/contracts";
import type { ReplicaStorage, ReplicaConflict } from "./storage";
import type { QueuedChange, OptimisticEffect } from "./optimistic";
import { readReplicaValue } from "./values";
import { contentHash } from "../../lib/thought-map/records";
import { createReplicaRepository } from "./repository";
import { createLocalReplicaRepository } from "./repository-local";
import { prepareOptimistic } from "./optimistic";
import { remapQueuedEntry } from "./reference-remap";
import { queueReplicaCommand } from "./outbox";
import {
  readDrafts,
  dropDraft,
  draftStorageKey,
  type DeviceStorage,
} from "../../lib/offline-drafts";
import { ReplicaQueryError } from "./queries";
import type { SyncEntity } from "../../lib/replica/entities";
import {
  queuedConflictRow,
  type ConflictContext,
} from "../../lib/replica/conflict-presentation";
function primaryEffect(entry: OutboxEntry) {
  const c = entry.command as QueuedChange;
  const preferred = [
    "createResearch",
    "updateResearch",
    "deleteResearch",
  ].includes(c.body.type)
    ? "library_research"
    : [
          "saveWhiteboard",
          "setWhiteboardNoteVisibility",
          "setWhiteboardNotesVisibility",
        ].includes(c.body.type)
      ? "library_whiteboards"
      : null;
  return (
    (preferred
      ? c.effects.find(
          (e) =>
            e.entity === preferred &&
            e.key === JSON.stringify([entry.entityId]),
        )
      : undefined) ??
    c.effects.find(
      (e) => e.entity !== "library_revisions" && e.after?.id === entry.entityId,
    ) ??
    c.effects.find((e) => e.entity !== "library_revisions")
  );
}
function primaryEntity(entry: OutboxEntry): SyncEntity | undefined {
  const type = (entry.command as QueuedChange).body.type;
  if (["createResearch", "updateResearch", "deleteResearch"].includes(type))
    return "library_research";
  if (
    [
      "saveWhiteboard",
      "setWhiteboardNoteVisibility",
      "setWhiteboardNotesVisibility",
    ].includes(type)
  )
    return "library_whiteboards";
  return primaryEffect(entry)?.entity;
}
async function baseRow(
  storage: ReplicaStorage,
  entity: SyncEntity,
  key: string,
) {
  const row = await storage.readRow(entity, key);
  return !row || row.deleted
    ? null
    : JSON.parse(
        new TextDecoder().decode(
          await readReplicaValue(
            storage,
            row,
            (await storage.checkpoint())!.generation,
          ),
        ),
      );
}
async function reviewedRow(
  repository: ReturnType<typeof createLocalReplicaRepository>,
  entity: SyncEntity | undefined,
  entry: OutboxEntry,
) {
  const body = (entry.command as QueuedChange).body;
  if (entity === "library_topic_memberships" && body.type === "assignTopic") {
    const p = body.payload;
    return (await repository.all(entity)).find(
      (row) =>
        row.topic_id === p.topicId &&
        row.source_kind === p.sourceKind &&
        row.source_id === p.sourceId,
    );
  }
  return entity ? repository.raw(entity, entry.entityId) : undefined;
}
export async function readConflictContext(
  storage: ReplicaStorage,
  entries: OutboxEntry[],
  values: unknown[] = [],
): Promise<ConflictContext> {
  const result: ConflictContext = {
      bookTitles: {},
      topicNames: {},
      sourceTitles: {},
      bookDetails: {},
    },
    books = new Set<string>(),
    topics = new Set<string>(),
    sources = new Map<string, { kind: string; id: string }>();
  const collect = (value: any) => {
    if (!value || typeof value !== "object") return;
    if (typeof value.book_id === "string") books.add(value.book_id);
    if (typeof value.bookId === "string") books.add(value.bookId);
    for (const key of [
      "topic_id",
      "topicId",
      "source_topic_id",
      "target_topic_id",
      "sourceTopicId",
      "targetTopicId",
    ])
      if (typeof value[key] === "string") topics.add(value[key]);
    for (const [kind, id] of [
      [
        value.source_kind ?? value.sourceKind,
        value.source_id ?? value.sourceId,
      ],
      [
        value.target_kind ?? value.targetKind,
        value.target_id ?? value.targetId,
      ],
    ])
      if (["note", "book"].includes(kind) && typeof id === "string")
        sources.set(`${kind}:${id}`, { kind, id });
    if (value.data && typeof value.data === "object") {
      const data = value.data;
      for (const id of (Array.isArray(data.hiddenNoteIds)
        ? data.hiddenNoteIds
        : []
      ).slice(0, 20))
        sources.set(`note:${id}`, { kind: "note", id });
      for (const id of data.filter?.books ?? [])
        if (typeof id === "string") books.add(id);
      for (const id of data.filter?.topics ?? [])
        if (typeof id === "string") topics.add(id);
      for (const group of (Array.isArray(data.groups) ? data.groups : []).slice(
        0,
        20,
      ))
        for (const id of (Array.isArray(group.noteIds)
          ? group.noteIds
          : []
        ).slice(0, 5))
          if (typeof id === "string")
            sources.set(`note:${id}`, { kind: "note", id });
      for (const link of (Array.isArray(data.links) ? data.links : []).slice(
        0,
        20,
      ))
        for (const id of [link.source, link.target])
          if (typeof id === "string" && id.startsWith("topic:"))
            topics.add(id.slice(6));
    }
  };
  for (const value of values) collect(value);
  for (const entry of entries) {
    const c = entry.command as QueuedChange;
    collect(queuedConflictRow(entry));
    collect(c.body);
    collect(c.body.payload);
  }
  const cache = new Map<string, Promise<any>>();
  const read = (entity: SyncEntity, id: string) => {
    const key = entity + ":" + id;
    if (!cache.has(key))
      cache.set(key, baseRow(storage, entity, JSON.stringify([id])));
    return cache.get(key)!;
  };
  await Promise.all([
    ...[...books].map(async (id) => {
      const r = await read("library_books", id);
      if (r?.title) {
        result.bookTitles[id] = r.title;
        result.bookDetails![id] = [r.author, r.publisher, r.isbn]
          .filter(Boolean)
          .join(" · ");
      }
    }),
    ...[...topics].map(async (id) => {
      const r = await read("library_topics", id);
      if (r?.name) result.topicNames[id] = r.name;
    }),
    ...[...sources].map(async ([key, { kind, id }]) => {
      const r = await read(
        kind === "book" ? "library_books" : "library_notes",
        id,
      );
      if (r)
        result.sourceTitles[key] = r.title || r.content?.slice(0, 80) || "자료";
    }),
  ]);
  return result;
}
export async function loadReplicaConflict(
  storage: ReplicaStorage,
  requestId: string,
) {
  const entries = await storage.listOutbox(),
    entry = entries.find((e) => e.requestId === requestId);
  if (!entry)
    throw new ReplicaQueryError(404, "검토할 입력을 찾을 수 없습니다.");
  const chain = entries
      .filter(
        (e) =>
          e.entityId === entry.entityId && !(e.command as QueuedChange).ack,
      )
      .filter((e) => primaryEntity(e) === primaryEntity(entry))
      .sort(
        (a, b) => a.order - b.order || a.requestId.localeCompare(b.requestId),
      ),
    firstEntry = chain[0];
  if (!firstEntry)
    throw new ReplicaQueryError(
      409,
      "이미 저장을 확인 중인 자료입니다. 동기화 후 다시 확인하세요.",
    );
  const first = firstEntry.command as QueuedChange,
    last = chain.at(-1) ?? entry,
    change = last.command as QueuedChange;
  const primary =
    primaryEffect(last)?.entity === "library_research"
      ? primaryEffect(last)
      : ([...chain]
          .reverse()
          .flatMap((e) => (e.command as QueuedChange).effects)
          .find(
            (e) =>
              e.after?.id === entry.entityId &&
              e.entity !== "library_revisions",
          ) ?? first.effects.find((e) => e.entity !== "library_revisions"));
  const cp = (await storage.checkpoint())!;
  let latest = primary
    ? await baseRow(storage, primary.entity, primary.key)
    : null;
  if (primary?.entity === "library_topic_memberships") {
    const downloaded = createLocalReplicaRepository({
      ...storage,
      listOutbox: async () => [],
    });
    try {
      latest = (await reviewedRow(downloaded, primary.entity, entry)) ?? null;
    } finally {
      downloaded.close();
    }
  }
  if (
    primary?.entity === "library_research" &&
    latest &&
    change.body.type === "deleteResearch"
  )
    latest = {
      ...latest,
      writingBoard: await baseRow(
        storage,
        "library_whiteboards",
        JSON.stringify([entry.entityId]),
      ),
    };
  const trash =
      primary?.entity === "library_notes"
        ? await baseRow(storage, "library_note_trash", primary.key)
        : null,
    excluded =
      primary?.entity === "library_books"
        ? await baseRow(storage, "library_book_exclusions", primary.key)
        : null;
  let unavailable =
    trash?.restored_at === null
      ? "다른 기기에서 휴지통으로 이동했습니다."
      : excluded?.state === "excluded"
        ? "다른 기기에서 제외한 자료입니다."
        : primary?.entity === "library_research_items" && !latest
          ? "연구에 담을 원문이나 서지 정보가 변경되었습니다. 기존 선택은 보관되며 원문을 다시 확인해야 합니다."
          : !latest && (firstEntry.baseVersion !== null || !!first.base)
            ? "서버에서 자료를 찾을 수 없습니다."
            : null;
  const local =
    primary?.after ??
    (change.body.type === "deleteResearch" ? change.base : null) ??
    change.body.payload ??
    change.body;
  const topic =
    primary?.entity === "library_topic_memberships" && local?.topic_id
      ? await baseRow(
          storage,
          "library_topics",
          JSON.stringify([local.topic_id]),
        )
      : null;
  const source =
    primary?.entity === "library_topic_memberships" &&
    ["note", "book"].includes(local?.source_kind)
      ? await baseRow(
          storage,
          local.source_kind === "note" ? "library_notes" : "library_books",
          JSON.stringify([local.source_id]),
        )
      : null;
  const topicsToRestore: any[] = [];
  if (primary?.entity === "library_topic_memberships") {
    if (!topic)
      unavailable =
        "분류할 주제가 없습니다. 온라인 서재를 선택하면 이 확인 항목을 정리합니다. 메모는 유지됩니다.";
    if (!source)
      unavailable =
        "분류할 자료를 찾을 수 없습니다. 온라인 서재를 선택해 이 확인 항목을 정리하세요.";
    let cursor = topic;
    const visited = new Set<string>();
    while (
      cursor?.archived_at &&
      !visited.has(cursor.id) &&
      topicsToRestore.length < 3
    ) {
      visited.add(cursor.id);
      topicsToRestore.unshift(cursor);
      if (!cursor.parent_id) break;
      cursor = await baseRow(
        storage,
        "library_topics",
        JSON.stringify([cursor.parent_id]),
      );
      if (!cursor)
        unavailable =
          "상위 주제를 찾을 수 없습니다. 온라인 서재를 선택해 확인 항목을 정리하세요.";
    }
  }
  const deletedTopic = topic?.archived_at ? topic : null;
  const token = contentHash(
    JSON.stringify([
      cp.generation,
      cp.cursor,
      cp.localRevision ?? 0,
      latest,
      unavailable,
      topic,
      topicsToRestore,
      source,
      chain.map((e) => [e.requestId, e.command, e.state]),
    ]),
  );
  return {
    entry: last,
    firstEntry,
    chain,
    base: first.base ?? null,
    latest,
    local,
    primary,
    unavailable,
    deletedTopic,
    topicsToRestore,
    source,
    token,
    context: await readConflictContext(
      storage,
      [last],
      [latest, local, first.base],
    ),
  };
}
export type ConflictReview = Awaited<ReturnType<typeof loadReplicaConflict>>;
export type Resolution = {
  choice: "mine" | "server" | "merge" | "copy";
  text?: { title: string; content: string };
  restoreTopic?: boolean;
};
export function resolveReplicaConflict(input: {
  entry: OutboxEntry;
  base: unknown;
  latest: any;
  choice: Resolution["choice"];
  text?: Resolution["text"];
}): OutboxEntry {
  const { entry, latest, choice, text } = input,
    old = entry.command as QueuedChange,
    body = structuredClone(old.body),
    at = new Date().toISOString(),
    requestId = crypto.randomUUID();
  if (choice === "server")
    throw Error("서버 선택은 보관 중인 초안만 정리합니다.");
  let entityId = entry.entityId,
    primaryEntity: SyncEntity | undefined;
  const effects: OptimisticEffect[] = old.effects
    .filter((e) => e.entity !== "library_revisions")
    .map((e) => structuredClone(e));
  if (choice === "copy") {
    if (
      entry.family !== "library" ||
      !["addNote", "editNote"].includes(body.type)
    )
      throw Error("이 자료는 새 기록으로 복사할 수 없습니다.");
    entityId = crypto.randomUUID();
    body.type = "addNote";
    body.entityId = entityId;
    delete body.payload.id;
    delete body.payload.expectedVersion;
    body.payload.kind = "thought";
    body.payload.page = null;
  } else {
    if (!latest)
      throw Error(
        "현재 자료가 없어 덮어쓸 수 없습니다. 새 기록으로 보관하세요.",
      );
    if (body.payload && typeof body.payload === "object")
      body.payload.expectedVersion = latest.version;
    else if (Object.hasOwn(body, "version")) body.version = latest.version;
    else body.expectedVersion = latest.version;
  }
  if (text) {
    const payload = body.payload ?? body;
    payload.title = text.title;
    payload.content = text.content;
  }
  body.requestId = requestId;
  for (const effect of effects)
    if (effect.after?.id === entry.entityId) {
      primaryEntity = effect.entity;
      effect.after = {
        ...(latest ?? {}),
        ...effect.after,
        id: entityId,
        version: choice === "copy" ? 1 : (latest.version ?? 0) + 1,
      };
      if (text) Object.assign(effect.after!, text);
      if (choice === "copy")
        Object.assign(effect.after!, {
          kind: "thought",
          page: null,
          source_data: null,
          source_key: null,
          created_at: at,
        });
      if (Object.hasOwn(effect.after!, "updated_at"))
        effect.after!.updated_at = at;
      effect.key = JSON.stringify([entityId]);
    }
  const after = effects.find((e) => e.entity === primaryEntity)?.after;
  if (after)
    effects.push({
      entity: "library_revisions",
      key: JSON.stringify([requestId]),
      after: {
        id: requestId,
        entity_id: entityId,
        action: body.type ?? old.path,
        before_data: latest,
        after_data: after,
        created_at: at,
      },
    });
  const command: QueuedChange = {
    path: old.path,
    body,
    at,
    base: latest,
    effects,
    result: { id: entityId, version: after?.version ?? 1, queued: true },
    inputHash: contentHash(JSON.stringify({ path: old.path, body })),
  };
  return {
    ...entry,
    requestId,
    entityId,
    baseVersion: latest?.version ?? null,
    state: "pending",
    dependsOn: [],
    command,
    order: Date.now() * 1000,
  };
}
/** Rebuild the chosen command chain against the downloaded state, retaining
 * context edits and chronology. The original commands remain archived. */
async function replayReviewedChanges(
  storage: ReplicaStorage,
  review: ConflictReview,
  all: OutboxEntry[],
  resolution: Resolution,
  dependentEntries: OutboxEntry[] = [],
) {
  const originals = [...review.chain, ...dependentEntries].sort(
      (a, b) => a.order - b.order || a.requestId.localeCompare(b.requestId),
    ),
    removed = new Set(originals.map((e) => e.requestId)),
    requestMap = new Map<string, string>(),
    aliases = new Map<string, string>(),
    entries: OutboxEntry[] = [];
  let others = all.filter((e) => !removed.has(e.requestId)),
    preparingOrder = Infinity;
  const repository = createLocalReplicaRepository({
    ...storage,
    listOutbox: async () => [
      ...others.filter((e) => e.order < preparingOrder),
      ...entries,
    ],
  });
  const remap = (entry: OutboxEntry) => {
    for (const [from, to] of aliases) entry = remapQueuedEntry(entry, from, to);
    return entry;
  };
  try {
    if (resolution.restoreTopic && review.deletedTopic) {
      preparingOrder = review.firstEntry.order;
      for (const [index, topic] of review.topicsToRestore.entries()) {
        repository.invalidate();
        const row = await repository.raw("library_topics", topic.id);
        if (!row?.archived_at) continue;
        const requestId = crypto.randomUUID(),
          at = new Date().toISOString();
        const prepared = await prepareOptimistic(
          repository,
          "/api/thought-map",
          {
            requestId,
            type: "restoreTopic",
            payload: { id: row.id, expectedVersion: row.version },
          },
          at,
        );
        entries.push({
          ...review.firstEntry,
          requestId,
          entityId: prepared.entityId,
          family: "thought-map",
          order:
            review.firstEntry.order - review.topicsToRestore.length + index,
          state: "pending",
          baseVersion: row.version,
          baseRevision: null,
          dependsOn: entries.length ? [entries.at(-1)!.requestId] : [],
          command: {
            path: "/api/thought-map",
            body: prepared.body,
            at,
            base: prepared.base,
            effects: prepared.effects,
            result: prepared.result,
            inputHash: contentHash(
              JSON.stringify({ path: "/api/thought-map", body: prepared.body }),
            ),
          } satisfies QueuedChange,
        });
      }
    }
    const restorationRequest = entries.at(-1)?.requestId;
    for (const original of originals) {
      preparingOrder = original.order;
      repository.invalidate();
      const old = remap(original),
        c = old.command as QueuedChange,
        body = structuredClone(c.body),
        requestId = crypto.randomUUID(),
        at = new Date().toISOString(),
        entity = primaryEffect(old)?.entity,
        row = await reviewedRow(repository, entity, old);
      body.requestId = requestId;
      body.entityId = old.entityId;
      delete body.editBase;
      if (body.payload && Object.hasOwn(body.payload, "expectedVersion"))
        body.payload.expectedVersion = row?.version ?? 0;
      if (body.type === "assignTopic" && body.payload) {
        body.payload.expectedVersion = row?.version ?? 0;
        const source = await repository.raw(
          body.payload.sourceKind === "note"
            ? "library_notes"
            : "library_books",
          body.payload.sourceId,
        );
        if (source) body.payload.sourceVersion = String(source.version);
      }
      if (Object.hasOwn(body, "version")) body.version = row?.version ?? 0;
      if (Object.hasOwn(body, "expectedVersion"))
        body.expectedVersion = row?.version ?? 0;
      if (body.payload && Object.hasOwn(body.payload, "expectedTitle"))
        body.payload.expectedTitle = row?.title;
      if (body.payload && Object.hasOwn(body.payload, "expectedQuestion"))
        body.payload.expectedQuestion = row?.question;
      if (body.type === "deleteResearch")
        body.payload.expectedBoardVersion =
          (await repository.raw("library_whiteboards", body.payload.id))
            ?.version ?? 0;
      if (["addNote", "editNote"].includes(body.type)) {
        const memberships = body.payload.topicChanges?.length
          ? await repository.all("library_topic_memberships")
          : [];
        for (const change of body.payload.topicChanges ?? []) {
          const membership = memberships.find(
            (m) =>
              m.topic_id === change.topicId &&
              m.source_kind === "note" &&
              m.source_id === old.entityId,
          );
          change.expectedVersion = membership?.version ?? 0;
        }
      }
      if (body.type === "moveResearchItems")
        for (const item of body.payload.items) {
          const placement = await repository.raw(
            "library_research_placements",
            item.itemId,
          );
          item.expectedVersion = placement?.version ?? 0;
        }
      if (body.type === "addResearchNote") {
        const note = await repository.raw("library_notes", body.payload.noteId);
        if (note) body.payload.expectedNoteVersion = note.version;
      }
      if (c.path === "/api/book-introduction") {
        const book = await repository.raw("library_books", body.bookId);
        if (book) body.bookVersion = book.version;
      }
      if (c.path === "/api/book-relations")
        for (const side of ["left", "right"] as const) {
          const book = await repository.raw("library_books", body[side + "Id"]);
          if (book) body[side + "Version"] = book.version;
        }
      if (
        resolution.text &&
        original === review.chain.at(-1) &&
        ["addNote", "editNote"].includes(body.type)
      )
        Object.assign(body.payload, resolution.text);
      const prepared = await prepareOptimistic(repository, c.path, body, at);
      requestMap.set(original.requestId, requestId);
      const next: OutboxEntry = {
        ...old,
        requestId,
        entityId: prepared.entityId,
        baseVersion: prepared.base?.version ?? null,
        baseRevision: null,
        state: "pending",
        // Keep chronology relative to other pending topic/connection changes.
        order: original.order,
        dependsOn: [
          ...new Set([
            ...old.dependsOn.map((id) => requestMap.get(id) ?? id),
            ...(restorationRequest ? [restorationRequest] : []),
          ]),
        ],
        command: {
          path: c.path,
          body: prepared.body,
          at,
          base: prepared.base,
          effects: prepared.effects,
          result: prepared.result,
          inputHash: contentHash(
            JSON.stringify({ path: c.path, body: prepared.body }),
          ),
        } satisfies QueuedChange,
      };
      entries.push(next);
      // A fresh request can give note-topic/connection context rows new IDs.
      // Carry those identities into pending dependants, never into user prose.
      const identity = [
        "book_id",
        "note_id",
        "topic_id",
        "research_id",
        "source_kind",
        "source_id",
        "target_kind",
        "target_id",
        "source_topic_id",
        "target_topic_id",
      ];
      for (const effect of c.effects.filter(
        (e) => e.entity !== "library_revisions" && e.after,
      )) {
        const candidates = prepared.effects.filter(
          (e) =>
            e.entity === effect.entity &&
            e.after &&
            identity.every((k) => e.after![k] === effect.after![k]),
        );
        if (
          candidates.length === 1 &&
          effect.after!.id !== candidates[0].after!.id
        )
          aliases.set(effect.after!.id, candidates[0].after!.id);
      }
      if (old.entityId !== prepared.entityId)
        aliases.set(old.entityId, prepared.entityId);
      for (let i = 0; i < entries.length; i++) entries[i] = remap(entries[i]);
      others = others.map((e) =>
        (e.command as QueuedChange).ack ? e : remap(e),
      );
      repository.invalidate();
    }
    return { entries, requestMap, aliases, dependentEntries };
  } finally {
    repository.close();
  }
}
export async function applyReplicaResolution(
  storage: ReplicaStorage,
  review: ConflictReview,
  resolution: Resolution,
) {
  const current = await loadReplicaConflict(
    storage,
    review.firstEntry.requestId,
  );
  if (current.token !== review.token)
    throw new ReplicaQueryError(
      409,
      "검토 중 자료가 변경되었습니다. 입력은 유지됩니다. 최신 내용을 다시 확인하세요.",
    );
  if (current.unavailable && !["server", "copy"].includes(resolution.choice))
    throw new ReplicaQueryError(409, current.unavailable);
  if (
    current.deletedTopic &&
    resolution.choice !== "server" &&
    !resolution.restoreTopic
  )
    throw new ReplicaQueryError(
      409,
      "삭제된 주제입니다. 주제 복원 후 적용을 선택하거나 온라인 상태를 유지하세요.",
    );
  const cp = (await storage.checkpoint())!,
    removed = new Set(current.chain.map((e) => e.requestId)),
    all = await storage.listOutbox();
  const selectedEntry =
    current.primary?.entity === "library_whiteboards" && current.local?.data
      ? {
          ...current.entry,
          command: {
            ...(current.entry.command as QueuedChange),
            body: {
              ...(current.entry.command as QueuedChange).body,
              type: "saveWhiteboard",
              payload: {
                boardId: current.local.id,
                data: current.local.data,
                expectedVersion: current.latest?.version ?? 0,
                includeVisibility: true,
              },
            },
            effects: [{ ...current.primary, after: current.local }],
          },
        }
      : current.entry;
  const first = current.firstEntry.command as QueuedChange;
  const dependentEntries: OutboxEntry[] = [],
    blocked = new Set(removed);
  for (const entry of [...all].sort((a, b) => a.order - b.order))
    if (
      !blocked.has(entry.requestId) &&
      entry.state === "pending" &&
      !(entry.command as QueuedChange).ack &&
      entry.dependsOn.some((id) => blocked.has(id))
    ) {
      blocked.add(entry.requestId);
      dependentEntries.push(entry);
    }
  const replay =
    (current.primary?.entity !== "library_whiteboards" ||
      dependentEntries.some(
        (e) => (e.command as QueuedChange).body.type === "deleteResearch",
      ) ||
      (!current.latest &&
        !current.unavailable &&
        current.firstEntry.baseVersion === null &&
        !first.base &&
        first.effects.some(
          (e) => e.entity !== "library_revisions" && !!e.after,
        ))) &&
    ["mine", "merge"].includes(resolution.choice)
      ? await replayReviewedChanges(
          storage,
          current,
          all,
          resolution,
          dependentEntries,
        )
      : null;
  for (const entry of replay?.dependentEntries ?? [])
    removed.add(entry.requestId);
  const next = replay
    ? null
    : resolution.choice === "server"
      ? null
      : resolveReplicaConflict({
          entry: selectedEntry,
          base: current.base,
          latest: current.latest,
          ...resolution,
        });
  if (next && resolution.choice === "copy") {
    const repository = createLocalReplicaRepository({
      ...storage,
      listOutbox: async () => all.filter((e) => !removed.has(e.requestId)),
    });
    try {
      const change = next.command as QueuedChange,
        topics = new Map<string, any>(),
        related = new Map<string, any>();
      for (const entry of current.chain) {
        const body = (entry.command as QueuedChange).body;
        if (!["addNote", "editNote"].includes(body.type)) continue;
        for (const topic of body.payload.topicChanges ?? [])
          topics.set(topic.topicId, { ...topic, expectedVersion: 0 });
        for (const note of body.payload.relatedNotes ?? [])
          related.set(note.noteId, structuredClone(note));
      }
      if (topics.size) change.body.payload.topicChanges = [...topics.values()];
      if (related.size)
        change.body.payload.relatedNotes = [...related.values()];
      const prepared = await prepareOptimistic(
        repository,
        change.path,
        change.body,
        change.at,
      );
      next.baseVersion = null;
      next.baseRevision = null;
      next.command = {
        path: change.path,
        body: prepared.body,
        at: change.at,
        base: prepared.base,
        effects: prepared.effects,
        result: prepared.result,
        inputHash: contentHash(
          JSON.stringify({ path: change.path, body: prepared.body }),
        ),
      } satisfies QueuedChange;
    } finally {
      repository.close();
    }
  }
  if (next) {
    next.order = all.reduce(
      (max, e) => Math.max(max, e.order + 1),
      Date.now() * 1000,
    );
    next.dependsOn = current.entry.dependsOn.filter((id) => !removed.has(id));
  }
  const replacements = replay?.entries ?? (next ? [next] : []),
    requestMap =
      replay?.requestMap ??
      new Map(current.chain.map((e) => [e.requestId, next?.requestId ?? null]));
  const archived: ReplicaConflict = {
    requestId: current.firstEntry.requestId,
    entityId: current.entry.entityId,
    local: current.local,
    base: current.base,
    server: current.latest,
    createdAt:
      (await storage.listConflicts()).find(
        (c) => c.requestId === current.firstEntry.requestId,
      )?.createdAt ?? new Date().toISOString(),
    resolvedAt: new Date().toISOString(),
    resolution: {
      choice: resolution.choice,
      entries: current.chain,
      ...(replay?.dependentEntries.length
        ? { dependentEntries: replay.dependentEntries }
        : {}),
      nextRequestId: replacements[0]?.requestId ?? null,
      nextRequestIds: replacements.map((e) => e.requestId),
    },
  };
  const localEntityRevisions = { ...cp.localEntityRevisions };
  const originals = [...current.chain, ...(replay?.dependentEntries ?? [])];
  for (const e of originals)
    for (const effect of (e.command as QueuedChange).effects)
      localEntityRevisions[effect.entity] =
        (localEntityRevisions[effect.entity] ?? 0) + 1;
  await storage.transaction((tx) => {
    tx.expectCheckpoint(cp.generation, cp);
    for (const e of originals) {
      tx.removeOutbox(e.requestId);
      tx.removeConflict(e.requestId);
    }
    tx.putConflict(archived);
    for (const replacement of replacements) tx.putOutbox(replacement);
    for (const e of all)
      if (
        !removed.has(e.requestId) &&
        (e.dependsOn.some((id) => removed.has(id)) || !!replay?.aliases.size)
      ) {
        let preserved = e;
        if (!(e.command as QueuedChange).ack)
          for (const [from, to] of replay?.aliases ?? [])
            preserved = remapQueuedEntry(preserved, from, to);
        tx.putOutbox({
          ...preserved,
          dependsOn: [
            ...new Set([
              ...e.dependsOn
                .map(
                  (id) => requestMap.get(id) ?? (!removed.has(id) ? id : null),
                )
                .filter((id): id is string => !!id),
            ]),
          ],
        });
      }
    tx.setCheckpoint(cp.generation, {
      localRevision: (cp.localRevision ?? 0) + 1,
      localEntityRevisions,
    });
  });
  return replacements.at(-1) ?? null;
}
export interface MigrationReport {
  migrated: number;
  alreadyPresent: number;
  failed: number;
  originalsPreserved: number;
}
export async function migrateLegacyDrafts(
  storage: ReplicaStorage,
  legacy: DeviceStorage,
  owner: string,
): Promise<MigrationReport> {
  if (storage.owner !== owner) throw Error("서재 계정이 다릅니다.");
  const result: MigrationReport = {
    migrated: 0,
    alreadyPresent: 0,
    failed: 0,
    originalsPreserved: 0,
  };
  const drafts = readDrafts(legacy, owner);
  if (!drafts.length) return result;
  const repo = createReplicaRepository(storage);
  try {
    for (const draft of drafts) {
      const key = draftStorageKey(owner, draft.id),
        original = legacy.getItem(key);
      if (original === null) continue;
      try {
        const previous = (await storage.listOutbox()).find(
            (e) => e.requestId === draft.id,
          ),
          op = await repo.raw("library_operations", draft.id),
          archive = (await storage.listConflicts(true)).find(
            (c) =>
              c.resolution?.legacyRequestId === draft.id &&
              c.resolution?.kind === "legacy-migration",
          );
        if (archive) {
          if (archive.resolution.original !== original)
            throw Error("같은 초안의 내용이 달라졌습니다.");
        } else if (op) {
          if (
            op.fingerprint !==
              contentHash(
                JSON.stringify({
                  type: draft.command.type,
                  payload: draft.command.payload,
                }),
              ) ||
            !op.result
          )
            throw Error("기존 요청 내용을 확인해야 합니다.");
        } else if (previous) {
          const c = (previous.command as QueuedChange).body;
          if (
            contentHash(
              JSON.stringify({ type: c.type, payload: c.payload }),
            ) !==
            contentHash(
              JSON.stringify({
                type: draft.command.type,
                payload: draft.command.payload,
              }),
            )
          )
            throw Error("같은 요청 번호의 초안이 달라졌습니다.");
        } else
          await queueReplicaCommand({
            storage,
            repository: repo,
            path: "/api/library",
            body: draft.command,
          });
        const saved = (await storage.listOutbox()).find(
          (e) => e.requestId === draft.id,
        );
        if (!saved && !op && !archive)
          throw Error("이전한 초안을 확인하지 못했습니다.");
        await storage.transaction((tx) =>
          tx.putConflict({
            requestId: "legacy:" + draft.id,
            entityId: saved?.entityId ?? op?.result?.id ?? draft.id,
            base: null,
            local: draft,
            server: null,
            createdAt: draft.createdAt,
            resolvedAt: new Date().toISOString(),
            resolution: {
              kind: "legacy-migration",
              legacyRequestId: draft.id,
              original,
            },
          }),
        );
        const verified = (await storage.listConflicts(true)).find(
          (c) => c.requestId === "legacy:" + draft.id,
        );
        if (verified?.resolution?.original !== original)
          throw Error("원본 보관을 확인하지 못했습니다.");
        if (legacy.getItem(key) !== original)
          throw Error("이전 중 초안이 변경되었습니다.");
        dropDraft(legacy, owner, draft.id);
        if (previous || op || archive) result.alreadyPresent++;
        else result.migrated++;
        result.originalsPreserved++;
      } catch {
        result.failed++;
        result.originalsPreserved++;
      }
    }
  } finally {
    repo.close();
  }
  return result;
}
