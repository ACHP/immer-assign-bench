# Immer assignment benchmark

How long does `produce` take to assign a large, freshly built list into a draft, across Immer 10.1.1, 10.2.0, 11.0.0 and 11.2.6, with auto-freeze on and off?

## TL;DR

Median milliseconds per `produce` call for a list of **3,000 items**, shown as run 1 / run 2. "< 0.01" means a few microseconds, which is the cost of `produce` itself. "Nested" items contain four objects each; "flat" items contain none.

| Recipe                                       | Items  | Auto-freeze |      10.1.1 |    10.2.0 |    11.0.0 |    11.2.6 |
| -------------------------------------------- | ------ | ----------- | ----------: | --------: | --------: | --------: |
| `draft.byRoom.room = { list }`               | nested | **off**     |      < 0.01 |    < 0.01 | 5.2 / 5.3 | 5.6 / 5.2 |
| `draft.byRoom.room = { list }`               | flat   | **off**     |      < 0.01 |    < 0.01 | 1.9 / 2.5 | 1.9 / 2.1 |
| `draft.byRoom.room = { list }`               | nested | on          | 14.6 / 13.3 | 8.7 / 8.2 | 7.8 / 7.4 | 8.2 / 7.6 |
| `draft.byRoom.room = { list }`               | flat   | on          |   5.7 / 5.5 | 1.8 / 1.7 | 2.6 / 2.6 | 2.7 / 2.5 |
| `draft.list = list`                          | nested | off         |      < 0.01 |    < 0.01 |    < 0.01 |    < 0.01 |
| `draft.list = list`                          | nested | on          | 13.8 / 13.1 | 8.7 / 8.2 | 2.2 / 1.9 | 2.3 / 2.2 |
| `draft.byRoom.room = { list: freeze(list) }` | both   | off or on   |      < 0.01 |    < 0.01 |    < 0.01 |    < 0.01 |

The cost grows linearly with the list. With auto-freeze off on 11.2.6, it is about 0.34 ms at 200 items, 1.7 ms at 1,000 and 18 ms at 10,000, against a few microseconds on 10.x.

## Conclusion

- **Auto-freeze on (the default): mostly no regression.** For nested items, 11.x matches 10.2.0, and a top-level assignment is about 3–4x faster. The exception is the nested recipe with flat items, which is about 1.5x slower on 11.x (2.6 ms against 1.7 ms).
- **Auto-freeze off: 11.x is slower.** If the recipe creates more than one draft (for example, it writes below the root), 11.x walks the entire assigned value. 10.x skipped that walk. As a result, turning auto-freeze off on 11.x saves only about a third of the cost, where on 10.x it saved nearly all of it.
- **The 10.x shortcut was unsound.** When the assigned value contains a draft, 10.x with auto-freeze off returns a revoked proxy (see the embedded-draft check below). The 11.x walk fixes that. So the slowdown is the price of a correctness fix, not a plain bug. The useful upstream question is whether the walk can be skipped when the assigned value cannot contain drafts.
- **Workaround:** `freeze(list)` before assigning brings every version back to a few microseconds, in both modes. Note that `freeze` is shallow, so the items themselves stay unfrozen and mutable.

These are Node/V8 numbers on an Apple M1 machine. They are not Hermes measurements. The upstream report is in [ISSUE.md](ISSUE.md).

## Run it

```sh
npm install
npm run bench                 # auto-freeze off  -> results.json
npm run bench:auto-freeze     # auto-freeze on   -> results-auto-freeze.json
npm run embedded-draft        # correctness check, takes a second
```

Use `npm run bench -- --output <file>` to keep an additional run. Each run takes about two minutes.

---

<details>
<summary><strong>Embedded-draft check</strong>: why 11.x walks the new value</summary>

[`embedded-draft.mjs`](embedded-draft.mjs) assigns fresh data that contains a modified draft:

```js
draft.byRoom.other.list.push(2);
draft.byRoom.room = { list: [{ ref: draft.byRoom.other }] };
```

Output on Node v26.9.0:

```
10.1.1, autoFreeze false: broken: Cannot perform 'get' on a proxy that has been revoked
10.1.1, autoFreeze true: correct {"list":[1,2]}
10.2.0, autoFreeze false: broken: Cannot perform 'get' on a proxy that has been revoked
10.2.0, autoFreeze true: correct {"list":[1,2]}
11.0.0, autoFreeze false: correct {"list":[1,2]}
11.0.0, autoFreeze true: correct {"list":[1,2]}
11.2.6, autoFreeze false: correct {"list":[1,2]}
11.2.6, autoFreeze true: correct {"list":[1,2]}
```

With auto-freeze off, 10.x never looks inside the new value, so it leaves a revoked proxy in the result. With auto-freeze on, 10.x walks the value anyway to freeze it, and it finds the draft. 11.x always walks the value when more than one draft exists.

</details>

<details>
<summary><strong>Scenarios</strong>: the five recipes</summary>

```js
// nested
draft.byRoom.room = { list };

// nested-frozen
draft.byRoom.room = { list: freeze(list) };

// top-level
draft.list = list;

// top-level-plus-nested-write
draft.list = list;
draft.meta.loading = false;

// replace-nested-object
draft.byRoom = { ...draft.byRoom, room: { list } };
```

The base state is `{ byRoom: { other: { list: [] } }, meta: { loading: true }, search: "" }`.

- `top-level` creates only the root draft, so 11.x stays fast with auto-freeze off.
- `top-level-plus-nested-write` adds a second draft (`meta`), and that alone makes 11.x walk the list. The trigger is the number of drafts, not how deep the list is assigned.
- `replace-nested-object` spreads a draft into a fresh object, so every version has to walk it. It is size-dependent in 10.x as well and is not evidence of the regression.

Two item shapes are tested:

- **Nested:** ID, a `Date`, `preview: { url, size: { width, height } }`, and `geolocation: { coords: { latitude, longitude } }`. That is four draftable objects per item.
- **Flat:** ID, a numeric timestamp, URL, width and height. That is one draftable object per item.

The nested shape costs about 2.4x to 2.9x more than the flat shape on 11.x with auto-freeze off. This is consistent with the walk visiting more objects. However, the shapes also differ in their properties, so this comparison does not isolate the object count alone.

</details>

<details>
<summary><strong>Method</strong></summary>

- Matrix: 2 shapes × 4 sizes (200, 1,000, 3,000, 10,000) × 5 recipes × 4 versions = 160 measurements per run. Each measurement has 20 warm-up calls and 200 timed calls.
- Every call receives a freshly built list. Lists are built in batches of 20, before timing. Explicit garbage collection runs after each batch is built and between measurements. Collection caused by Immer's own allocations can still land inside a call.
- The timer covers only `produce`, including the recipe. In `nested-frozen`, the cost of `freeze(list)` is included.
- Every call starts from the same small base state, never from the previous result.
- After every call, outside the timer, the script asserts the list identity, the complete expected result, that the base is unchanged, and the expected freeze state.
- The median is the mean of the two central samples. The p90 is the nearest-rank 90th percentile. Version order rotates between scenarios.
- Imports use each package's default ESM entry. No plugins, Redux, or strict-iteration changes are involved.
- Results below about 0.01 ms are close to timer overhead, so ratios against them are not meaningful. Compare the added milliseconds instead.

</details>

<details>
<summary><strong>Environment and raw data</strong></summary>

Recorded on 2026-10-21 on an Apple M1 (arm64, 8 logical CPUs, 16 GiB RAM) running macOS (Darwin 25.6.0). The Node binary was `/opt/homebrew/bin/node` v26.9.0 (V8 14.6.202.34-node.32). Reports now record `nodeBinary`. `npm run` uses whichever `node` comes first on `PATH`, so check the printed environment.

| File                                                               | Auto-freeze | Node    |
| ------------------------------------------------------------------ | ----------- | ------- |
| [results.json](results.json)                                       | off         | 26.9.0  |
| [results-run-2.json](results-run-2.json)                           | off         | 26.9.0  |
| [results-auto-freeze.json](results-auto-freeze.json)               | on          | 26.9.0  |
| [results-auto-freeze-run-2.json](results-auto-freeze-run-2.json)   | on          | 26.9.0  |
| [results-auto-freeze-node24.json](results-auto-freeze-node24.json) | on          | 24.21.0 |

Every run passed all assertions on all 35,200 calls, including warm-up. The Node 24 run shows the same pattern. The machine was otherwise idle, but other background work could still affect the timings.

</details>

<details>
<summary><strong>Repeatability at 3,000 nested items</strong></summary>

Cells are run 1 median / run 2 median, in milliseconds.

**Auto-freeze off**

| Scenario                      |            10.1.1 |          10.2.0 |          11.0.0 |          11.2.6 |
| ----------------------------- | ----------------: | --------------: | --------------: | --------------: |
| `nested`                      |   0.0026 / 0.0024 | 0.0021 / 0.0023 | 5.2350 / 5.2655 | 5.5762 / 5.1609 |
| `nested-frozen`               |   0.0028 / 0.0028 | 0.0024 / 0.0025 | 0.0025 / 0.0024 | 0.0025 / 0.0025 |
| `top-level`                   |   0.0018 / 0.0017 | 0.0014 / 0.0014 | 0.0013 / 0.0012 | 0.0012 / 0.0012 |
| `top-level-plus-nested-write` |   0.0038 / 0.0037 | 0.0031 / 0.0033 | 5.4065 / 5.7056 | 5.2363 / 5.2254 |
| `replace-nested-object`       | 11.7118 / 12.6559 | 7.0807 / 7.3796 | 5.2403 / 5.5109 | 5.6397 / 5.7683 |

**Auto-freeze on**

| Scenario                      |            10.1.1 |          10.2.0 |          11.0.0 |          11.2.6 |
| ----------------------------- | ----------------: | --------------: | --------------: | --------------: |
| `nested`                      | 14.6126 / 13.2977 | 8.7047 / 8.2065 | 7.8220 / 7.4097 | 8.1587 / 7.6241 |
| `nested-frozen`               |   0.0036 / 0.0034 | 0.0025 / 0.0025 | 0.0033 / 0.0029 | 0.0034 / 0.0030 |
| `top-level`                   | 13.7997 / 13.1011 | 8.7261 / 8.2433 | 2.1757 / 1.8976 | 2.2550 / 2.1726 |
| `top-level-plus-nested-write` | 13.5490 / 13.0237 | 8.6662 / 8.3140 | 7.7322 / 7.1674 | 8.2382 / 8.0716 |
| `replace-nested-object`       | 13.6315 / 12.9976 | 9.2956 / 8.3169 | 7.7207 / 7.3060 | 7.9622 / 7.4165 |

</details>

<details>
<summary><strong>Full results, auto-freeze off</strong> (run 1, median / p90 ms)</summary>

**Nested items, 200**

| Scenario | 10.1.1 | 10.2.0 | 11.0.0 | 11.2.6 |
| --- | ---: | ---: | ---: | ---: |
| `nested` | 0.0042 / 0.0063 | 0.0045 / 0.0161 | 0.3545 / 0.4707 | 0.3415 / 0.4708 |
| `nested-frozen` | 0.0038 / 0.0068 | 0.0036 / 0.0105 | 0.0027 / 0.0105 | 0.0028 / 0.0045 |
| `top-level` | 0.0021 / 0.0035 | 0.0017 / 0.0026 | 0.0013 / 0.0030 | 0.0014 / 0.0035 |
| `top-level-plus-nested-write` | 0.0048 / 0.0064 | 0.0045 / 0.0061 | 0.3391 / 0.3898 | 0.3311 / 0.4040 |
| `replace-nested-object` | 0.8318 / 1.2075 | 0.4642 / 0.6963 | 0.3871 / 0.6537 | 0.3722 / 0.5064 |

**Nested items, 1,000**

| Scenario | 10.1.1 | 10.2.0 | 11.0.0 | 11.2.6 |
| --- | ---: | ---: | ---: | ---: |
| `nested` | 0.0026 / 0.0085 | 0.0023 / 0.0083 | 1.8215 / 2.3256 | 1.7404 / 2.2159 |
| `nested-frozen` | 0.0029 / 0.0159 | 0.0024 / 0.0033 | 0.0025 / 0.0048 | 0.0026 / 0.0135 |
| `top-level` | 0.0018 / 0.0062 | 0.0014 / 0.0047 | 0.0013 / 0.0047 | 0.0012 / 0.0041 |
| `top-level-plus-nested-write` | 0.0041 / 0.0420 | 0.0035 / 0.0050 | 2.1030 / 3.7399 | 1.8074 / 2.3050 |
| `replace-nested-object` | 3.9521 / 5.0417 | 2.3966 / 3.7858 | 1.7875 / 2.2494 | 1.7505 / 2.1242 |

**Nested items, 3,000**

| Scenario | 10.1.1 | 10.2.0 | 11.0.0 | 11.2.6 |
| --- | ---: | ---: | ---: | ---: |
| `nested` | 0.0026 / 0.0097 | 0.0021 / 0.0026 | 5.2350 / 5.9696 | 5.5762 / 7.1078 |
| `nested-frozen` | 0.0028 / 0.0048 | 0.0024 / 0.0042 | 0.0025 / 0.0049 | 0.0025 / 0.0043 |
| `top-level` | 0.0018 / 0.0056 | 0.0014 / 0.0018 | 0.0013 / 0.0043 | 0.0012 / 0.0018 |
| `top-level-plus-nested-write` | 0.0038 / 0.0065 | 0.0031 / 0.0044 | 5.4065 / 6.9643 | 5.2363 / 5.9148 |
| `replace-nested-object` | 11.7118 / 12.8859 | 7.0807 / 7.8957 | 5.2403 / 6.0501 | 5.6397 / 8.0352 |

**Nested items, 10,000**

| Scenario | 10.1.1 | 10.2.0 | 11.0.0 | 11.2.6 |
| --- | ---: | ---: | ---: | ---: |
| `nested` | 0.0025 / 0.0082 | 0.0022 / 0.0082 | 18.0510 / 19.7608 | 18.2832 / 20.8513 |
| `nested-frozen` | 0.0028 / 0.0091 | 0.0023 / 0.0047 | 0.0025 / 0.0049 | 0.0025 / 0.0035 |
| `top-level` | 0.0017 / 0.0023 | 0.0013 / 0.0018 | 0.0012 / 0.0032 | 0.0012 / 0.0039 |
| `top-level-plus-nested-write` | 0.0037 / 0.0058 | 0.0030 / 0.0385 | 17.9525 / 20.1951 | 18.0919 / 20.8237 |
| `replace-nested-object` | 39.4462 / 43.5189 | 24.4625 / 29.4347 | 17.8117 / 19.5502 | 18.1526 / 20.3507 |

**Flat items, 200**

| Scenario | 10.1.1 | 10.2.0 | 11.0.0 | 11.2.6 |
| --- | ---: | ---: | ---: | ---: |
| `nested` | 0.0025 / 0.0031 | 0.0021 / 0.0026 | 0.1415 / 0.1673 | 0.1412 / 0.1816 |
| `nested-frozen` | 0.0027 / 0.0038 | 0.0023 / 0.0031 | 0.0024 / 0.0038 | 0.0025 / 0.0038 |
| `top-level` | 0.0017 / 0.0021 | 0.0013 / 0.0020 | 0.0011 / 0.0015 | 0.0011 / 0.0015 |
| `top-level-plus-nested-write` | 0.0037 / 0.0065 | 0.0030 / 0.0098 | 0.1409 / 0.1685 | 0.1398 / 0.1792 |
| `replace-nested-object` | 0.3607 / 0.4753 | 0.1107 / 0.1461 | 0.1472 / 0.1905 | 0.1455 / 0.1907 |

**Flat items, 1,000**

| Scenario | 10.1.1 | 10.2.0 | 11.0.0 | 11.2.6 |
| --- | ---: | ---: | ---: | ---: |
| `nested` | 0.0025 / 0.0037 | 0.0021 / 0.0026 | 0.6650 / 0.9062 | 0.6605 / 0.7943 |
| `nested-frozen` | 0.0028 / 0.0093 | 0.0023 / 0.0035 | 0.0024 / 0.0034 | 0.0025 / 0.0059 |
| `top-level` | 0.0017 / 0.0023 | 0.0013 / 0.0018 | 0.0011 / 0.0025 | 0.0012 / 0.0092 |
| `top-level-plus-nested-write` | 0.0037 / 0.0044 | 0.0030 / 0.0038 | 0.6907 / 0.9295 | 0.6572 / 0.8040 |
| `replace-nested-object` | 1.7075 / 2.0411 | 0.5144 / 0.6757 | 0.6674 / 0.8085 | 0.6598 / 0.8120 |

**Flat items, 3,000**

| Scenario | 10.1.1 | 10.2.0 | 11.0.0 | 11.2.6 |
| --- | ---: | ---: | ---: | ---: |
| `nested` | 0.0025 / 0.0080 | 0.0022 / 0.0033 | 1.8865 / 2.2330 | 1.9273 / 2.3287 |
| `nested-frozen` | 0.0029 / 0.0125 | 0.0023 / 0.0032 | 0.0024 / 0.0033 | 0.0025 / 0.0047 |
| `top-level` | 0.0018 / 0.0057 | 0.0013 / 0.0020 | 0.0012 / 0.0017 | 0.0011 / 0.0038 |
| `top-level-plus-nested-write` | 0.0038 / 0.0051 | 0.0030 / 0.0067 | 1.9029 / 2.3905 | 1.9420 / 2.4238 |
| `replace-nested-object` | 5.6245 / 7.1915 | 1.4945 / 1.9715 | 1.9747 / 2.8317 | 1.9430 / 2.4560 |

**Flat items, 10,000**

| Scenario | 10.1.1 | 10.2.0 | 11.0.0 | 11.2.6 |
| --- | ---: | ---: | ---: | ---: |
| `nested` | 0.0025 / 0.0038 | 0.0021 / 0.0068 | 6.5416 / 7.4072 | 6.5946 / 7.3770 |
| `nested-frozen` | 0.0027 / 0.0052 | 0.0023 / 0.0075 | 0.0024 / 0.0082 | 0.0025 / 0.0083 |
| `top-level` | 0.0017 / 0.0056 | 0.0014 / 0.0046 | 0.0011 / 0.0017 | 0.0011 / 0.0019 |
| `top-level-plus-nested-write` | 0.0037 / 0.0116 | 0.0030 / 0.0108 | 6.8615 / 8.4693 | 6.6978 / 8.5157 |
| `replace-nested-object` | 17.5689 / 18.5566 | 5.1780 / 5.9463 | 6.5380 / 7.6426 | 6.7779 / 8.5548 |


</details>

<details>
<summary><strong>Full results, auto-freeze on</strong> (run 1, median / p90 ms)</summary>

**Nested items, 200**

| Scenario | 10.1.1 | 10.2.0 | 11.0.0 | 11.2.6 |
| --- | ---: | ---: | ---: | ---: |
| `nested` | 0.9012 / 1.2023 | 0.5610 / 0.8905 | 0.5704 / 0.7842 | 0.5516 / 0.6712 |
| `nested-frozen` | 0.0043 / 0.0156 | 0.0031 / 0.0053 | 0.0037 / 0.0107 | 0.0037 / 0.0059 |
| `top-level` | 0.8774 / 1.0472 | 0.5846 / 1.1465 | 0.1415 / 0.1767 | 0.1538 / 0.1820 |
| `top-level-plus-nested-write` | 0.8758 / 1.0081 | 0.5486 / 0.6525 | 0.5523 / 0.6503 | 0.5662 / 0.9831 |
| `replace-nested-object` | 0.9053 / 1.1945 | 0.5814 / 1.0900 | 0.5891 / 1.0425 | 0.5637 / 0.7001 |

**Nested items, 1,000**

| Scenario | 10.1.1 | 10.2.0 | 11.0.0 | 11.2.6 |
| --- | ---: | ---: | ---: | ---: |
| `nested` | 4.5795 / 5.7803 | 2.7979 / 3.2790 | 2.6272 / 3.5252 | 2.6725 / 3.4893 |
| `nested-frozen` | 0.0037 / 0.0053 | 0.0025 / 0.0035 | 0.0033 / 0.0052 | 0.0035 / 0.0110 |
| `top-level` | 4.6425 / 7.1433 | 2.8428 / 3.4688 | 0.7108 / 0.8885 | 0.7849 / 1.6747 |
| `top-level-plus-nested-write` | 4.5235 / 5.1939 | 2.8177 / 3.2397 | 2.5585 / 3.1770 | 2.7388 / 3.5786 |
| `replace-nested-object` | 4.4604 / 5.1209 | 2.9067 / 4.0201 | 2.5798 / 3.3180 | 2.6723 / 3.5180 |

**Nested items, 3,000**

| Scenario | 10.1.1 | 10.2.0 | 11.0.0 | 11.2.6 |
| --- | ---: | ---: | ---: | ---: |
| `nested` | 14.6126 / 31.8338 | 8.7047 / 10.4639 | 7.8220 / 10.4856 | 8.1587 / 10.0832 |
| `nested-frozen` | 0.0036 / 0.0111 | 0.0025 / 0.0095 | 0.0033 / 0.0042 | 0.0034 / 0.0044 |
| `top-level` | 13.7997 / 16.0194 | 8.7261 / 12.5247 | 2.1757 / 3.2766 | 2.2550 / 2.7100 |
| `top-level-plus-nested-write` | 13.5490 / 18.1651 | 8.6662 / 10.7902 | 7.7322 / 9.5595 | 8.2382 / 10.9743 |
| `replace-nested-object` | 13.6315 / 15.8127 | 9.2956 / 12.4366 | 7.7207 / 9.4247 | 7.9622 / 9.7592 |

**Nested items, 10,000**

| Scenario | 10.1.1 | 10.2.0 | 11.0.0 | 11.2.6 |
| --- | ---: | ---: | ---: | ---: |
| `nested` | 45.6985 / 52.2158 | 28.8183 / 32.9725 | 26.3909 / 29.2446 | 27.5790 / 32.2678 |
| `nested-frozen` | 0.0036 / 0.0196 | 0.0025 / 0.0092 | 0.0034 / 0.0114 | 0.0036 / 0.0123 |
| `top-level` | 45.7559 / 51.4392 | 29.3436 / 32.5820 | 7.2245 / 9.0354 | 8.0070 / 10.7774 |
| `top-level-plus-nested-write` | 45.9636 / 51.2429 | 28.6947 / 30.7715 | 26.0041 / 29.7347 | 27.7906 / 31.7410 |
| `replace-nested-object` | 45.8628 / 50.2355 | 28.7550 / 31.3075 | 25.9232 / 29.4567 | 27.0501 / 32.7248 |

**Flat items, 200**

| Scenario | 10.1.1 | 10.2.0 | 11.0.0 | 11.2.6 |
| --- | ---: | ---: | ---: | ---: |
| `nested` | 0.3762 / 0.4270 | 0.1285 / 0.1770 | 0.1866 / 0.2380 | 0.1923 / 0.2460 |
| `nested-frozen` | 0.0035 / 0.0050 | 0.0024 / 0.0042 | 0.0032 / 0.0046 | 0.0033 / 0.0047 |
| `top-level` | 0.4118 / 1.4300 | 0.1294 / 0.1726 | 0.0456 / 0.0645 | 0.0487 / 0.0681 |
| `top-level-plus-nested-write` | 0.3750 / 0.4525 | 0.1279 / 0.1499 | 0.1952 / 0.2670 | 0.2335 / 0.7754 |
| `replace-nested-object` | 0.3726 / 0.4243 | 0.1358 / 0.1629 | 0.2053 / 0.2820 | 0.1969 / 0.2693 |

**Flat items, 1,000**

| Scenario | 10.1.1 | 10.2.0 | 11.0.0 | 11.2.6 |
| --- | ---: | ---: | ---: | ---: |
| `nested` | 1.8285 / 2.1159 | 0.5895 / 0.8972 | 0.8807 / 1.2074 | 0.9548 / 1.4436 |
| `nested-frozen` | 0.0035 / 0.0044 | 0.0024 / 0.0083 | 0.0032 / 0.0045 | 0.0033 / 0.0040 |
| `top-level` | 1.8580 / 2.1055 | 0.5936 / 0.7576 | 0.2204 / 0.3250 | 0.2258 / 0.2973 |
| `top-level-plus-nested-write` | 1.9144 / 2.9002 | 0.6181 / 0.8338 | 0.8960 / 1.1084 | 0.9185 / 1.1563 |
| `replace-nested-object` | 1.9042 / 2.1504 | 0.5937 / 0.7850 | 0.9203 / 1.4182 | 0.8956 / 1.1640 |

**Flat items, 3,000**

| Scenario | 10.1.1 | 10.2.0 | 11.0.0 | 11.2.6 |
| --- | ---: | ---: | ---: | ---: |
| `nested` | 5.7234 / 6.9626 | 1.7609 / 2.0650 | 2.5959 / 3.3153 | 2.6792 / 3.4164 |
| `nested-frozen` | 0.0035 / 0.0058 | 0.0024 / 0.0031 | 0.0032 / 0.0040 | 0.0033 / 0.0056 |
| `top-level` | 5.6709 / 6.1786 | 1.8188 / 2.1224 | 0.5897 / 0.7806 | 0.6837 / 1.0833 |
| `top-level-plus-nested-write` | 5.7244 / 6.6261 | 1.9185 / 2.8368 | 2.8348 / 4.0035 | 2.7459 / 3.3780 |
| `replace-nested-object` | 6.3572 / 8.9507 | 3.2624 / 6.3813 | 3.9200 / 7.0255 | 2.9407 / 4.9161 |

**Flat items, 10,000**

| Scenario | 10.1.1 | 10.2.0 | 11.0.0 | 11.2.6 |
| --- | ---: | ---: | ---: | ---: |
| `nested` | 20.0204 / 23.7725 | 6.0611 / 6.7834 | 8.9353 / 10.3162 | 9.5156 / 12.0600 |
| `nested-frozen` | 0.0035 / 0.0054 | 0.0024 / 0.0031 | 0.0033 / 0.0048 | 0.0034 / 0.0045 |
| `top-level` | 19.4391 / 23.1899 | 6.1400 / 6.8885 | 1.8391 / 2.3420 | 2.0602 / 2.6725 |
| `top-level-plus-nested-write` | 19.4132 / 21.6759 | 6.3346 / 7.6840 | 8.7975 / 9.8822 | 8.9925 / 10.8172 |
| `replace-nested-object` | 19.2527 / 21.3300 | 6.1037 / 6.7360 | 9.3129 / 11.9022 | 9.1640 / 10.6893 |


</details>

<details>
<summary><strong>Source reading</strong></summary>

This is an inference from the release sources, not a trace of the timed calls.

- **10.x:** a modified draft [is finalized before its children are visited](https://github.com/immerjs/immer/blob/v10.1.1/src/core/finalize.ts#L70-L94). The [early return in `finalizeProperty`](https://github.com/immerjs/immer/blob/v10.1.1/src/core/finalize.ts#L137-L148) then skips new non-draft values once no drafts remain unfinalized and auto-freeze is off. [10.2.0 keeps the same shortcut](https://github.com/immerjs/immer/blob/v10.2.0/src/core/finalize.ts#L166-L177). The shortcut is also why the embedded-draft check fails on 10.x.
- **11.x:** [callbacks run before the parent is finalized](https://github.com/immerjs/immer/blob/v11.2.6/src/core/finalize.ts#L85-L99). For an assigned draftable value, [the callback calls `handleValue`](https://github.com/immerjs/immer/blob/v11.2.6/src/core/finalize.ts#L238-L269) when the scope has more than one draft. At that point the unfinalized-draft counter is still positive, so [the early return does not apply](https://github.com/immerjs/immer/blob/v11.2.6/src/core/finalize.ts#L272-L318). The function then recurses through every unfrozen draftable object and adds each one to `handledSet`. A frozen value stops the walk. [11.0.0 has the same mechanism](https://github.com/immerjs/immer/blob/v11.0.0/src/core/finalize.ts#L213-L308).

The version boundary matches the finalization rewrite in [#1183](https://github.com/immerjs/immer/pull/1183).

</details>

<details>
<summary><strong>Upstream issue search</strong></summary>

On 2026-10-21, I checked the open issue titles and searched `immerjs/immer` issues, including closed ones, for `performance 11`, `handledSet`, `regression autofreeze`, and `nested slow`. I found no exact duplicate. Related reports are [#1152](https://github.com/immerjs/immer/issues/1152), [#1154](https://github.com/immerjs/immer/issues/1154) and [#599](https://github.com/immerjs/immer/issues/599). All three are closed and predate 11.0.0.

</details>
