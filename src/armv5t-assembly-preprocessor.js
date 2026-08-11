// ARMv5T assembly preprocessor translated from the legacy assembly.php used by
// armv5tAssemblyPlayground. It resolves #! origins, labels, .addr/.addr4, and
// FUN_xxxxxxxx BL targets while preserving the original address-counting rules.

function parseHexAddress(text, label = "address", { requirePrefix = false } = {}) {
  const valueText = String(text).trim();
  if (requirePrefix && !/^0x/i.test(valueText)) throw new Error(`${label} must start with 0x`);
  const normalized = valueText.replace(/^0x/i, "");
  if (!/^[0-9a-f]+$/i.test(normalized)) throw new Error(`${label} must be hexadecimal`);
  const value = Number.parseInt(normalized, 16);
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new Error(`${label} is outside uint32 range`);
  return value >>> 0;
}

function offsetExpression(targetAddress, currentAddress) {
  const offset = targetAddress - currentAddress;
  return offset >= 0
    ? `m+0x${offset.toString(16).toUpperCase()}`
    : `m-0x${Math.abs(offset).toString(16).toUpperCase()}`;
}

export function preprocessAssemblySource(source, initialBaseAddress) {
  if (typeof source !== "string") throw new Error("source must be a string");
  if (!Number.isSafeInteger(initialBaseAddress) || initialBaseAddress < 0 || initialBaseAddress > 0xffffffff) {
    throw new Error("initialBaseAddress must be a uint32 integer");
  }
  const lines = source.split(/\r\n|\n|\r/).filter((line) => line !== "");
  let baseAddress = initialBaseAddress >>> 0;
  let currentAddress = baseAddress;
  let origin = baseAddress;
  let resetAddressAtNextLabel = false;
  const linker = new Map();
  const outputLines = [];
  const debuggerLines = [];
  for (let line of lines) {
    if (line.startsWith("#!")) {
      if (line.includes("auto")) continue;
      resetAddressAtNextLabel = true;
      baseAddress = parseHexAddress(line.slice(2), "#! address");
      origin = baseAddress;
      continue;
    }
    if (line.endsWith(":")) {
      if (resetAddressAtNextLabel) {
        currentAddress = origin;
        resetAddressAtNextLabel = false;
      }
      linker.set(line.slice(0, -1), currentAddress);
      outputLines.push(line);
      debuggerLines.push(`${line} => 0x${currentAddress.toString(16).toUpperCase()}`);
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed.startsWith("//") || trimmed.startsWith("@")) continue;
    if (line.includes(".word ")) {
      outputLines.push(line);
      debuggerLines.push(`${line} => 0x${currentAddress.toString(16).toUpperCase()}`);
      currentAddress += 4;
      continue;
    }
    if (trimmed === "") continue;
    if (trimmed.startsWith(".addr ")) {
      const name = trimmed.slice(6);
      const link = linker.get(name);
      if (link !== undefined) {
        outputLines.push(`\t.word 0x${link.toString(16)}`);
        debuggerLines.push(`${trimmed} => 0x${link.toString(16).toUpperCase()}`);
      }
      currentAddress += 4;
      continue;
    }
    if (trimmed.startsWith(".addr4 ")) {
      const name = trimmed.slice(7);
      const link = linker.get(name);
      if (link !== undefined) {
        outputLines.push(`\t.word 0x${((link - 4) >>> 0).toString(16)}`);
        debuggerLines.push(`${line} => 0x${currentAddress.toString(16).toUpperCase()}`);
      }
      currentAddress += 4;
      continue;
    }
    const lowerBl = /bl\s+FUN_([0-9a-fA-F]+)/.exec(line);
    if (lowerBl) {
      const target = Number.parseInt(lowerBl[1], 16);
      line = line.replace(/FUN_([0-9a-fA-F]+)/g, offsetExpression(target, currentAddress));
    }
    const upperBl = /BL\s+FUN_([0-9a-fA-F]+)/.exec(line);
    if (upperBl) {
      const target = Number.parseInt(upperBl[1], 16);
      line = line.replace(/FUN_([0-9a-fA-F]+)/g, offsetExpression(target, currentAddress));
    }
    if (line.trim().startsWith(".ltorg")) {
      outputLines.push(line);
      debuggerLines.push(`${line} => 0x${currentAddress.toString(16).toUpperCase()}`);
      continue;
    }
    outputLines.push(line);
    debuggerLines.push(`${line} => 0x${currentAddress.toString(16).toUpperCase()}`);
    currentAddress += 4;
  }
  return {
    generatedSource: outputLines.join("\n"),
    debuggerText: debuggerLines.join("\n")
  };
}

export const armv5tAssemblyPreprocessorInternals = { parseHexAddress, offsetExpression };
