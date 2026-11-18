import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectionSettings,
  collectionAllowance,
  collectionClock,
  dueCollections,
  nextCollectionBatch,
  settleCollectionReservation,
} from "./collection-settings.mjs";
test("completed empty and partial batches refund unused capacity; invalid audits cannot refund", () => {
  assert.equal(settleCollectionReservation(137, 100, 0), 37);
  assert.equal(settleCollectionReservation(137, 100, 25), 62);
  assert.throws(() => settleCollectionReservation(137, 100, 101));
  assert.throws(() => settleCollectionReservation(50, 100, 0));
});
test("per-run and daily changes apply between safe internal 100-book batches", () => {
  const initial = {
    pdf: { mode: "continuous", dailyLimit: 1000, runLimit: 500 },
  };
  assert.equal(nextCollectionBatch("pdf", initial, initial, 0, 0, 500), 100);
  assert.equal(
    nextCollectionBatch(
      "pdf",
      initial,
      { pdf: { mode: "continuous", dailyLimit: 1000, runLimit: 137 } },
      100,
      100,
      400,
    ),
    37,
  );
  assert.equal(
    nextCollectionBatch(
      "pdf",
      initial,
      { pdf: { mode: "continuous", dailyLimit: 120, runLimit: 500 } },
      100,
      100,
      400,
    ),
    20,
  );
  assert.equal(
    nextCollectionBatch(
      "pdf",
      initial,
      { pdf: { mode: "manual" } },
      100,
      100,
      400,
    ),
    0,
  );
  assert.equal(
    nextCollectionBatch(
      "pdf",
      initial,
      { pdf: { mode: "continuous", paused: true } },
      100,
      100,
      400,
    ),
    0,
  );
});
test("editable daily limits preserve partial batches, lower limits and crash reservations", () => {
  const settings = collectionSettings({
    logos: { dailyLimit: 217 },
    pdf: { dailyLimit: 35 },
  });
  assert.equal(collectionAllowance(settings, "logos", 200), 17);
  assert.equal(collectionAllowance(settings, "pdf", 30), 5);
  assert.equal(collectionAllowance(settings, "pdf", 100), 0);
  assert.equal(
    collectionAllowance(
      { ...settings, pdf: { dailyLimit: 35, paused: true } },
      "pdf",
      0,
    ),
    0,
  );
  assert.equal(collectionAllowance({ pdf: { dailyLimit: 0 } }, "pdf", 0), 0);
  for (const value of [-1, 10001, NaN, 1.5, "100"])
    assert.throws(() => collectionSettings({ pdf: { dailyLimit: value } }));
});
test("Korean scheduling does not replay prior days or completed slots", () => {
  const now = new Date("2026-11-14T12:00:00Z");
  assert.deepEqual(collectionClock(now), {
    day: "2026-11-14",
    hour: 21,
    minute: 0,
  });
  const ledger = {
    sequences: [{ session: "logos:morning" }],
    logos: { reserved: 100 },
    pdf: { reserved: 0 },
  };
  assert.deepEqual(dueCollections(ledger, {}, now), [
    ["logos", "evening"],
    ["pdf", "daily"],
  ]);
  ledger.sequences.push({ session: "logos:evening" }, { session: "pdf:daily" });
  assert.deepEqual(dueCollections(ledger, {}, now), []);
});

test("continuous collection alternates, stops at quota and backs off on empty work", () => {
  const settings = {
    logos: { mode: "continuous", dailyLimit: 1000, runLimit: 250 },
    pdf: { mode: "continuous", dailyLimit: 1000 },
  };
  const now = new Date("2026-11-15T01:30:00Z");
  const ledger = {
    sequences: [],
    logos: { reserved: 0, ids: [] },
    pdf: { reserved: 0, ids: [] },
  };
  assert.equal(dueCollections(ledger, settings, now)[0][0], "logos");
  ledger.sequences.push({
    kind: "logos",
    session: "logos:continuous-0",
    notBefore: "2026-11-15T02:00:00Z",
  });
  assert.deepEqual(
    dueCollections(ledger, settings, now).map((x) => x[0]),
    ["pdf"],
  );
  ledger.sequences[0].notBefore = "2026-11-15T01:00:00Z";
  assert.equal(dueCollections(ledger, settings, now)[0][0], "pdf");
  ledger.pdf.reserved = 1000;
  assert.deepEqual(
    dueCollections(ledger, settings, now).map((x) => x[0]),
    ["logos"],
  );
  assert.equal(collectionSettings(settings).logos.runLimit, 250);
});
test("custom minute schedules, manual mode and expanded validation", () => {
  const s = {
    logos: {
      mode: "scheduled",
      times: ["08:15", "20:40"],
      dailyLimit: 10000,
      runLimit: 10000,
    },
    pdf: { mode: "manual" },
  };
  assert.deepEqual(
    dueCollections(
      { sequences: [], logos: { reserved: 0 }, pdf: { reserved: 0 } },
      s,
      new Date("2026-11-15T11:39:00Z"),
    ),
    [["logos", "scheduled-0815"]],
  );
  assert.deepEqual(
    dueCollections(
      { sequences: [], logos: { reserved: 0 }, pdf: { reserved: 0 } },
      s,
      new Date("2026-11-15T11:40:00Z"),
    ),
    [["logos", "scheduled-2040"]],
  );
  for (const config of [
    { dailyLimit: 10001 },
    { runLimit: 0 },
    { runLimit: 10001 },
    { mode: "other" },
    { times: ["25:00"] },
    { times: ["09:00", "09:00"] },
  ])
    assert.throws(() => collectionSettings({ pdf: config }));
});

test("a due scheduled collector runs before continuous work", () => {
  const settings = {
    logos: { mode: "continuous" },
    pdf: { mode: "scheduled", times: ["08:00"] },
  };
  assert.equal(
    dueCollections(
      { sequences: [], logos: { reserved: 0 }, pdf: { reserved: 0 } },
      settings,
      new Date("2026-11-15T00:00:00Z"),
    )[0][0],
    "pdf",
  );
});
