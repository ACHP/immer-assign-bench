// Checks whether a draft embedded in freshly assigned data is finalized.
// This is the case the 11.x walk handles and the 10.x shortcut skips.
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("package.json", import.meta.url)));

console.log(`Node ${process.version} (${process.execPath})`);
for (const [alias, specification] of Object.entries(manifest.dependencies)) {
  const { produce, setAutoFreeze } = await import(alias);
  for (const autoFreeze of [false, true]) {
    setAutoFreeze(autoFreeze);
    const base = { byRoom: { other: { list: [1] } }, meta: { loading: true } };
    const result = produce(base, (draft) => {
      draft.byRoom.other.list.push(2);
      draft.byRoom.room = { list: [{ ref: draft.byRoom.other }] };
    });
    let outcome;
    try {
      const value = JSON.stringify(result.byRoom.room.list[0].ref);
      outcome = value === '{"list":[1,2]}' ? `correct ${value}` : `wrong ${value}`;
    } catch (error) {
      outcome = `broken: ${error.message}`;
    }
    console.log(`${specification.slice("npm:immer@".length)}, autoFreeze ${autoFreeze}: ${outcome}`);
  }
}
