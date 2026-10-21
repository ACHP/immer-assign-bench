import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "auto-freeze": { type: "boolean", default: false },
    output: { type: "string", default: "results.json" },
  },
});
assert.equal(typeof global.gc, "function", "Run with node --expose-gc bench.mjs");

const iterations = 200;
const warmup = 20;
const batchSize = 20;
const sizes = [200, 1000, 3000, 10000];
const manifest = JSON.parse(await readFile(new URL("package.json", import.meta.url)));
const versions = await Promise.all(
  Object.entries(manifest.dependencies).map(async ([alias, specification]) => {
    const immer = await import(alias);
    immer.setAutoFreeze(values["auto-freeze"]);
    return { alias, version: specification.slice("npm:immer@".length), immer };
  }),
);

function buildList(shape, size) {
  return Array.from({ length: size }, (_, id) => {
    const createdAt = 1700000000000 + id * 1000;
    const url = `https://example.invalid/media/${id}`;
    if (shape === "flat") {
      return { id, createdAt, url, width: 640, height: 480 };
    }
    return {
      id,
      createdAt: new Date(createdAt),
      preview: { url, size: { width: 640, height: 480 } },
      geolocation: { coords: { latitude: 45 + id / 1000000, longitude: -73 } },
    };
  });
}

function expectedNested(base, list) {
  return { ...base, byRoom: { ...base.byRoom, room: { list } } };
}

const scenarios = [
  {
    name: "nested",
    recipe(draft, list) {
      draft.byRoom.room = { list };
    },
    expected: expectedNested,
  },
  {
    name: "nested-frozen",
    recipe(draft, list, immer) {
      draft.byRoom.room = { list: immer.freeze(list) };
    },
    expected: expectedNested,
  },
  {
    name: "top-level",
    recipe(draft, list) {
      draft.list = list;
    },
    expected: (base, list) => ({ ...base, list }),
  },
  {
    name: "top-level-plus-nested-write",
    recipe(draft, list) {
      draft.list = list;
      draft.meta.loading = false;
    },
    expected: (base, list) => ({ ...base, list, meta: { loading: false } }),
  },
  {
    name: "replace-nested-object",
    recipe(draft, list) {
      draft.byRoom = { ...draft.byRoom, room: { list } };
    },
    expected: expectedNested,
  },
];

function measureBatch(immer, scenario, shape, size, base, unchangedBase) {
  const lists = Array.from({ length: batchSize }, () => buildList(shape, size));
  global.gc();
  const samples = [];
  for (const list of lists) {
    const start = performance.now();
    const result = immer.produce(base, (draft) => scenario.recipe(draft, list, immer));
    const elapsed = performance.now() - start;
    samples.push(elapsed);

    assert.strictEqual(result.list ?? result.byRoom.room.list, list);
    assert.deepStrictEqual(result, scenario.expected(base, list));
    assert.deepStrictEqual(base, unchangedBase);
    if (scenario.name === "nested-frozen") {
      assert(Object.isFrozen(list));
      assert(!Object.isFrozen(list[0]), "freeze(list) must remain shallow");
    } else if (!values["auto-freeze"]) {
      assert(!Object.isFrozen(list), "The assigned list must remain unfrozen");
    }
  }
  return samples;
}

function measure(immer, scenario, shape, size) {
  const base = { byRoom: { other: { list: [] } }, meta: { loading: true }, search: "" };
  const unchangedBase = structuredClone(base);
  global.gc();
  for (let count = 0; count < warmup; count += batchSize) {
    measureBatch(immer, scenario, shape, size, base, unchangedBase);
  }
  const samples = [];
  for (let count = 0; count < iterations; count += batchSize) {
    samples.push(...measureBatch(immer, scenario, shape, size, base, unchangedBase));
  }
  samples.sort((left, right) => left - right);
  return {
    medianMs: (samples[iterations / 2 - 1] + samples[iterations / 2]) / 2,
    p90Ms: samples[Math.ceil(iterations * 0.9) - 1],
  };
}

const report = {
  startedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    nodeBinary: process.execPath,
    v8: process.versions.v8,
    platform: platform(),
    release: release(),
    architecture: process.arch,
    cpu: cpus()[0].model,
    logicalCpus: cpus().length,
    memoryBytes: totalmem(),
  },
  configuration: {
    autoFreeze: values["auto-freeze"],
    iterations,
    warmup,
    batchSize,
    sizes,
    versions: versions.map(({ alias, version }) => ({ alias, version })),
  },
  results: [],
};

console.log(
  JSON.stringify({ environment: report.environment, configuration: report.configuration }, null, 2),
);
console.log("All times are milliseconds per produce call, median / p90.");
for (const shape of ["nested", "flat"]) {
  for (const size of sizes) {
    const rows = [];
    for (const [scenarioIndex, scenario] of scenarios.entries()) {
      const row = { scenario: scenario.name };
      const offset = scenarioIndex % versions.length;
      const orderedVersions = [...versions.slice(offset), ...versions.slice(0, offset)];
      for (const { alias, version, immer } of orderedVersions) {
        const timing = measure(immer, scenario, shape, size);
        report.results.push({ shape, size, scenario: scenario.name, alias, version, ...timing });
        row[version] = `${timing.medianMs.toFixed(4)} / ${timing.p90Ms.toFixed(4)}`;
      }
      rows.push(row);
    }
    console.log(`\n${shape} items, size ${size}, autoFreeze ${values["auto-freeze"]}`);
    console.table(rows, ["scenario", ...versions.map(({ version }) => version)]);
  }
}
report.finishedAt = new Date().toISOString();
await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nAll output assertions passed. Wrote ${values.output}`);
