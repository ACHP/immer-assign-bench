# With auto-freeze off, 11.x walks every freshly assigned value when the recipe has more than one draft

With `setAutoFreeze(false)`, assigning a large fresh list below the root became size-dependent in 11.0.0. On 10.1.1 and 10.2.0, the same assignment takes a few microseconds at every size tested. On 11.2.6 it takes about 5 ms for 3,000 nested items and about 18 ms for 10,000.

I understand this is probably a side effect of a correctness fix, not a plain bug. The 10.x shortcut that made this fast also skips drafts embedded in the new value (see below). My question is whether 11.x could skip the walk when the assigned value cannot contain drafts.

This only affects users who turn auto-freeze off. With auto-freeze on, 10.x also walks the value in order to freeze it. For nested items, 11.x is then as fast as 10.2.0 or faster. For flat items, the nested recipe is about 1.5x slower on 11.x (2.6 ms against 1.7 ms at 3,000 items).

## Reproduction

In an empty directory:

```sh
npm init -y
npm install immer-10.1.1@npm:immer@10.1.1 immer-10.2.0@npm:immer@10.2.0 immer-11.0.0@npm:immer@11.0.0 immer-latest@npm:immer@11.2.6
node --expose-gc repro.mjs
```

Save this as `repro.mjs`. Only `produce` is timed. List construction, assertions and explicit garbage collection happen outside the timer. Each timed call receives a fresh list, and the first batch is warm-up.

```js
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

for (const alias of ["immer-10.1.1", "immer-10.2.0", "immer-11.0.0", "immer-latest"]) {
  const { produce, setAutoFreeze } = await import(alias);
  setAutoFreeze(false);
  const base = { byRoom: { other: { list: [] } }, meta: { loading: true }, search: "" };
  const unchangedBase = structuredClone(base);
  const times = [];
  for (let batch = 0; batch < 11; batch++) {
    const lists = Array.from({ length: 20 }, () =>
      Array.from({ length: 3000 }, (_, id) => ({
        id,
        createdAt: new Date(1700000000000 + id * 1000),
        preview: {
          url: `https://example.invalid/media/${id}`,
          size: { width: 640, height: 480 },
        },
        geolocation: { coords: { latitude: 45 + id / 1000000, longitude: -73 } },
      })),
    );
    global.gc();
    for (const list of lists) {
      const start = performance.now();
      const result = produce(base, (draft) => {
        draft.byRoom.room = { list };
      });
      const elapsed = performance.now() - start;
      if (batch > 0) times.push(elapsed);
      assert.strictEqual(result.byRoom.room.list, list);
      assert.deepStrictEqual(base, unchangedBase);
    }
  }
  times.sort((left, right) => left - right);
  console.log(alias, {
    medianMs: (times[99] + times[100]) / 2,
    p90Ms: times[179],
  });
}
```

Replacing `{ list }` with `{ list: freeze(list) }`, with `freeze` imported from the same alias, brings every version back to a few microseconds.

## Results

These were measured on Node v26.9.0 (V8 14.6.202.34-node.32), macOS, Apple M1 (arm64, 16 GiB RAM). The default ESM entry was used with no other settings changed. Each cell is the median in milliseconds for 3,000 items, from two full runs (run 1 / run 2), with 20 warm-up calls and 200 measured calls per cell.

| Recipe                                       | Items  | Auto-freeze |      10.1.1 |    10.2.0 |    11.0.0 |    11.2.6 |
| -------------------------------------------- | ------ | ----------- | ----------: | --------: | --------: | --------: |
| `draft.byRoom.room = { list }`               | nested | **off**     |      < 0.01 |    < 0.01 | 5.2 / 5.3 | 5.6 / 5.2 |
| `draft.byRoom.room = { list }`               | flat   | **off**     |      < 0.01 |    < 0.01 | 1.9 / 2.5 | 1.9 / 2.1 |
| `draft.list = list`                          | nested | off         |      < 0.01 |    < 0.01 |    < 0.01 |    < 0.01 |
| `draft.list = list; draft.meta.loading = false` | nested | off      |      < 0.01 |    < 0.01 | 5.4 / 5.7 | 5.2 / 5.2 |
| `draft.byRoom.room = { list: freeze(list) }` | nested | off or on   |      < 0.01 |    < 0.01 |    < 0.01 |    < 0.01 |
| `draft.byRoom.room = { list }`               | nested | on          | 14.6 / 13.3 | 8.7 / 8.2 | 7.8 / 7.4 | 8.2 / 7.6 |
| `draft.byRoom.room = { list }`               | flat   | on          |   5.7 / 5.5 | 1.8 / 1.7 | 2.6 / 2.6 | 2.7 / 2.5 |

On 11.2.6 with auto-freeze off, the cost grows linearly with the list: about 0.34 ms at 200 nested items, 1.7 ms at 1,000, 5.6 ms at 3,000 and 18 ms at 10,000. Nested items contain four draftable objects each, flat items none, and the nested shape costs about 2.4x to 2.9x more.

The trigger is the number of drafts, not how deep the value is assigned. A top-level assignment alone stays fast. Adding one unrelated nested write (`draft.meta.loading = false`) makes the same assignment size-dependent.

Every run checked list identity, the complete expected output, an unchanged base, and the expected freeze state on all 35,200 calls. The full benchmark, raw JSON and all sizes are in <!-- TODO: link to the published benchmark repository -->.

## Why 10.x was fast: drafts inside the new value

The 10.x shortcut never looks inside the assigned value. When that value contains a draft, 10.x with auto-freeze off leaves a revoked proxy in the result:

```js
setAutoFreeze(false);
const result = produce({ byRoom: { other: { list: [1] } } }, (draft) => {
  draft.byRoom.other.list.push(2);
  draft.byRoom.room = { list: [{ ref: draft.byRoom.other }] };
});
JSON.stringify(result.byRoom.room.list[0].ref);
```

| Version | Auto-freeze off                                                | Auto-freeze on   |
| ------- | -------------------------------------------------------------- | ---------------- |
| 10.1.1  | `TypeError: Cannot perform 'get' on a proxy that has been revoked` | `{"list":[1,2]}` |
| 10.2.0  | `TypeError: Cannot perform 'get' on a proxy that has been revoked` | `{"list":[1,2]}` |
| 11.0.0  | `{"list":[1,2]}`                                               | `{"list":[1,2]}` |
| 11.2.6  | `{"list":[1,2]}`                                               | `{"list":[1,2]}` |

So 11.x is correct here, and the walk is what makes it correct.

## Where the time goes

This is my reading of the sources, not a trace:

- [11.2.6 runs callbacks before finalizing the parent](https://github.com/immerjs/immer/blob/v11.2.6/src/core/finalize.ts#L85-L99). For an assigned draftable value, [the callback calls `handleValue`](https://github.com/immerjs/immer/blob/v11.2.6/src/core/finalize.ts#L238-L269) whenever the scope has more than one draft.
- At that point the unfinalized-draft counter is still positive, so [the early return in `handleValue`](https://github.com/immerjs/immer/blob/v11.2.6/src/core/finalize.ts#L272-L318) does not apply. The function then recurses through every unfrozen draftable object in the new value and adds each one to `handledSet`.
- [10.1.1 finalizes the draft before visiting its children](https://github.com/immerjs/immer/blob/v10.1.1/src/core/finalize.ts#L70-L94), so by the time it reaches the new value, the [equivalent early return](https://github.com/immerjs/immer/blob/v10.1.1/src/core/finalize.ts#L137-L148) applies.

This appears to come from the finalization rewrite in [#1183](https://github.com/immerjs/immer/pull/1183). Earlier performance discussions include [#1152](https://github.com/immerjs/immer/issues/1152) and [#599](https://github.com/immerjs/immer/issues/599).

## Question

Could 11.x avoid walking fresh data when auto-freeze is off, while still finalizing drafts embedded in it? One possible direction is to track whether any draft was ever assigned into a non-draft object, or to count drafts that are not yet attached to a finalized parent. Until then, is `freeze(value)` before assigning the recommended workaround?
