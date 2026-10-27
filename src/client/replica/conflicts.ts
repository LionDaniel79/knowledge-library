import type { OutboxEntry } from "../../lib/replica/contracts";
import type { ReplicaStorage, ReplicaConflict } from "./storage";
import type { QueuedChange, OptimisticEffect } from "./optimistic";
import { readReplicaValue } from "./values";
import { contentHash } from "../../lib/thought-map/records";
import { createReplicaRepository } from "./repository";
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
  const first = entry.command as QueuedChange,
    chain = entries.filter(
      (e) => e.entityId === entry.entityId && e.order >= entry.order,
    ),
    last = chain.at(-1) ?? entry,
    change = last.command as QueuedChange;
  const primary =
    [...chain]
      .reverse()
      .flatMap((e) => (e.command as QueuedChange).effects)
      .find(
        (e) =>
          e.after?.id === entry.entityId && e.entity !== "library_revisions",
      ) ?? first.effects.find((e) => e.entity !== "library_revisions");
  const cp = (await storage.checkpoint())!;
  const latest = primary
    ? await baseRow(storage, primary.entity, primary.key)
    : null;
  const trash =
      primary?.entity === "library_notes"
        ? await baseRow(storage, "library_note_trash", primary.key)
        : null,
    excluded =
      primary?.entity === "library_books"
        ? await baseRow(storage, "library_book_exclusions", primary.key)
        : null;
  const unavailable =
    trash?.restored_at === null
      ? "다른 기기에서 휴지통으로 이동했습니다."
      : excluded?.state === "excluded"
        ? "다른 기기에서 제외한 자료입니다."
        : primary?.entity === "library_research_items" && !latest
          ? "연구에 담을 원문이나 서지 정보가 변경되었습니다. 기존 선택은 보관되며 원문을 다시 확인해야 합니다."
          : !latest && entry.baseVersion !== null
            ? "서버에서 자료를 찾을 수 없습니다."
            : null;
  const local = primary?.after ?? change.body.payload ?? change.body;
  const token = contentHash(
    JSON.stringify([
      cp.generation,
      cp.cursor,
      cp.localRevision ?? 0,
      latest,
      unavailable,
      chain.map((e) => [e.requestId, e.command, e.state]),
    ]),
  );
  return {
    entry: last,
    firstEntry: entry,
    chain,
    base: first.base ?? null,
    latest,
    local,
    primary,
    unavailable,
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
                data: current.local.data,
                expectedVersion: current.latest?.version ?? 0,
                includeVisibility: true,
              },
            },
            effects: [{ ...current.primary, after: current.local }],
          },
        }
      : current.entry;
  const next =
    resolution.choice === "server"
      ? null
      : resolveReplicaConflict({
          entry: selectedEntry,
          base: current.base,
          latest: current.latest,
          ...resolution,
        });
  if (next) {
    next.order = all.reduce(
      (max, e) => Math.max(max, e.order + 1),
      Date.now() * 1000,
    );
    next.dependsOn = current.entry.dependsOn.filter((id) => !removed.has(id));
  }
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
      nextRequestId: next?.requestId ?? null,
    },
  };
  const localEntityRevisions = { ...cp.localEntityRevisions };
  for (const e of current.chain)
    for (const effect of (e.command as QueuedChange).effects)
      localEntityRevisions[effect.entity] =
        (localEntityRevisions[effect.entity] ?? 0) + 1;
  await storage.transaction((tx) => {
    tx.expectCheckpoint(cp.generation, cp);
    for (const e of current.chain) {
      tx.removeOutbox(e.requestId);
      tx.removeConflict(e.requestId);
    }
    tx.putConflict(archived);
    if (next) tx.putOutbox(next);
    for (const e of all)
      if (
        !removed.has(e.requestId) &&
        e.dependsOn.some((id) => removed.has(id))
      )
        tx.putOutbox({
          ...e,
          dependsOn: [
            ...new Set([
              ...e.dependsOn.filter((id) => !removed.has(id)),
              ...(next ? [next.requestId] : []),
            ]),
          ],
        });
    tx.setCheckpoint(cp.generation, {
      localRevision: (cp.localRevision ?? 0) + 1,
      localEntityRevisions,
    });
  });
  return next;
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
