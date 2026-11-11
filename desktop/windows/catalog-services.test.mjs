import { test } from "node:test";
import assert from "node:assert/strict";
import { startCatalogServices } from "./catalog-detached.mjs";
function service() {
  let finish;
  const state = { stops: 0, finished: false };
  state.done = new Promise((r) => {
    finish = r;
  });
  state.stop = () => {
    if (!state.finished) {
      state.stops++;
      state.finished = true;
      finish(0);
    }
    return state.done;
  };
  state.finish = (code) => {
    state.finished = true;
    finish(code);
  };
  return state;
}
test("Logos service starts only with explicit approval and shutdown includes both services", async () => {
  for (const approved of [false, true]) {
    const cat = service(),
      logos = service();
    let calls = 0;
    const c = startCatalogServices(
      { logosCompletionApproved: approved },
      "unused",
      {
        startCatalog: () => cat,
        startLogos: () => {
          calls++;
          return logos;
        },
      },
    );
    assert.equal(calls, approved ? 1 : 0);
    await c.stop();
    assert.equal(cat.stops, 1);
    assert.equal(logos.stops, approved ? 1 : 0);
  }
});
test("failure of one controller closes its sibling instead of leaving an invisible watcher", async () => {
  const cat = service(),
    logos = service();
  const c = startCatalogServices({ logosCompletionApproved: true }, "unused", {
    startCatalog: () => cat,
    startLogos: () => logos,
  });
  cat.finish(1);
  assert.equal(await c.done, 1);
  assert.equal(logos.stops, 1);
});
test("unavailable optional Logos keeps catalog alive and exposes no underlying secrets", async () => {
  const cat = service(),
    warnings = [];
  const c = startCatalogServices({ logosCompletionApproved: true }, "unused", {
    startCatalog: () => cat,
    startLogos: () => {
      throw Error("private-connection-secret");
    },
    onWarning: (m) => warnings.push(m),
  });
  assert.equal(cat.finished, false);
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes("private-connection-secret"));
  await c.stop();
});
test("configuration errors are sanitized", () => {
  assert.throws(
    () =>
      startCatalogServices({}, "unused", {
        startCatalog: () => {
          throw Error("private-connection-secret");
        },
      }),
    (e) => !e.message.includes("private-connection-secret"),
  );
});
