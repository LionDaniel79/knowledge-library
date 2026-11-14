import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectionSettings,
  collectionAllowance,
  collectionClock,
  dueCollections,
} from "./collection-settings.mjs";
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
  for (const value of [-1, 501, NaN, 1.5, "100"])
    assert.throws(() => collectionSettings({ pdf: { dailyLimit: value } }));
});
test("Korean scheduling does not replay prior days or completed slots", () => {
  const now = new Date("2026-11-14T12:00:00Z");
  assert.deepEqual(collectionClock(now), { day: "2026-11-14", hour: 21 });
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
