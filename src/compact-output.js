const FLATTEN_DEPTH = 12;
const FLATTEN_NODES = 2000;
const FLATTEN_ARRAY_ITEMS = 256;
const FLATTEN_TEXT_CHARS = 64 * 1024;

export function compactOutputText(result) {
  if (typeof result === "string") return result;
  if (result && typeof result.text === "string") return result.text;
  return flattenObject(result);
}

export function flattenObject(value) {
  const lines = [];
  let blockId = 1;
  let nodes = 0;
  let textChars = 0;
  let truncated = false;
  const seen = new WeakSet();
  const pending = [{ path: "", value, depth: 0 }];

  const pushLine = (line) => {
    const remaining = FLATTEN_TEXT_CHARS - textChars;
    if (remaining <= 0) {
      truncated = true;
      return;
    }
    const text = String(line);
    const bounded = text.slice(0, remaining);
    lines.push(bounded);
    textChars += bounded.length + 1;
    if (bounded.length !== text.length) truncated = true;
  };

  while (pending.length && nodes < FLATTEN_NODES && !truncated) {
    const item = pending.pop();
    nodes += 1;
    if (item.depth > FLATTEN_DEPTH) {
      pushLine(`${item.path}=<max-depth>`);
      continue;
    }
    if (item.value === null) {
      pushLine(`${item.path}=null`);
      continue;
    }
    if (typeof item.value === "string") {
      if (item.value.includes("\n")) {
        const tag = `plaintext+${blockId++}`;
        pushLine(`${item.path}=<<<${tag}>>>`);
        pushLine(item.value);
        pushLine(`<<<${tag}>>>`);
      } else {
        pushLine(`${item.path}=${item.value}`);
      }
      continue;
    }
    if (["number", "boolean", "bigint", "undefined"].includes(typeof item.value)) {
      pushLine(`${item.path}=${String(item.value)}`);
      continue;
    }
    if (!item.value || typeof item.value !== "object") continue;
    if (seen.has(item.value)) {
      pushLine(`${item.path}=<circular>`);
      continue;
    }
    seen.add(item.value);
    const entries = Array.isArray(item.value)
      ? item.value.slice(0, FLATTEN_ARRAY_ITEMS).map((entry, index) => [String(index), entry])
      : Object.entries(item.value);
    if (Array.isArray(item.value) && item.value.length > entries.length) {
      pushLine(`${item.path ? `${item.path}.` : ""}truncated=true`);
      pushLine(`${item.path ? `${item.path}.` : ""}originalItems=${item.value.length}`);
    }
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, entry] = entries[index];
      pending.push({
        path: item.path ? `${item.path}.${key}` : key,
        value: entry,
        depth: item.depth + 1
      });
    }
  }
  if (pending.length || nodes >= FLATTEN_NODES || truncated) {
    if (!lines.includes("truncated=true")) lines.push("truncated=true");
  }
  return lines.join("\n");
}
