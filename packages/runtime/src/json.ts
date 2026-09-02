import type { JsonObject, JsonValue } from "@dsh-tempera/domain";

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const isArrayIndex = (key: string): boolean => /^(0|[1-9]\d*)$/.test(key);

const hasSymbolKeys = (value: object): boolean => Object.getOwnPropertySymbols(value).length > 0;

const hasAccessor = (value: object): boolean => {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) {
    if ("get" in descriptor || "set" in descriptor) {
      return true;
    }
  }
  return false;
};

const isJsonArray = (value: unknown[], seen: Set<object>): boolean => {
  if (seen.has(value)) {
    return false;
  }

  for (let index = 0; index < value.length; index += 1) {
    if (!hasOwn(value, index)) {
      return false;
    }
  }

  const ownNames = Object.getOwnPropertyNames(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const name of ownNames) {
    if (name === "length") {
      continue;
    }
    const descriptor = descriptors[name];
    if (
      !isArrayIndex(name) ||
      Number(name) >= value.length ||
      descriptor === undefined ||
      !descriptor.enumerable ||
      "get" in descriptor ||
      "set" in descriptor
    ) {
      return false;
    }
  }

  if (ownNames.length - 1 !== value.length || hasSymbolKeys(value) || hasAccessor(value)) {
    return false;
  }

  seen.add(value);
  for (let index = 0; index < value.length; index += 1) {
    if (!isJsonValue(value[index], seen)) {
      seen.delete(value);
      return false;
    }
  }
  seen.delete(value);
  return true;
};

const isJsonObjectValue = (value: object, seen: Set<object>): boolean => {
  if (seen.has(value) || !isPlainObject(value)) {
    return false;
  }

  if (hasSymbolKeys(value) || hasAccessor(value)) {
    return false;
  }

  const ownNames = Object.getOwnPropertyNames(value);
  const keys = Object.keys(value);
  if (ownNames.length !== keys.length) {
    return false;
  }

  seen.add(value);
  for (const key of keys) {
    if (!isJsonValue((value as Record<string, unknown>)[key], seen)) {
      seen.delete(value);
      return false;
    }
  }
  seen.delete(value);
  return true;
};

export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  isJsonObjectValue(value, new Set());

export const isJsonValue = (value: unknown, seen: Set<object> = new Set()): value is JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return isJsonArray(value, seen);
  }
  if (typeof value === "object" && value !== null) {
    return isJsonObjectValue(value, seen);
  }
  return false;
};

export const assertJsonValue = (value: unknown, message = "Expected a JSON value"): JsonValue => {
  if (!isJsonValue(value)) {
    throw new TypeError(message);
  }
  return value;
};

export const assertJsonObject = (
  value: unknown,
  message = "Expected a JSON object",
): JsonObject => {
  if (!isJsonObject(value)) {
    throw new TypeError(message);
  }
  return value;
};

export const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
};
