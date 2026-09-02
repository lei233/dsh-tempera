import { createHash } from "node:crypto";
import type { JsonObject, JsonValue } from "@dsh-tempera/domain";
import { assertJsonValue } from "./json";

const serialize = (value: JsonValue): string => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serialize(item)).join(",")}]`;
  }
  const object = value as JsonObject;
  const keys = Object.keys(object).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(object[key])}`).join(",")}}`;
};

export const canonicalJson = (value: unknown): string => {
  const jsonValue = assertJsonValue(value, "Expected a plain JSON value");
  return serialize(jsonValue);
};

export const sha256Fingerprint = (value: unknown): string => {
  const canonical = canonicalJson(value);
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `sha256:${digest}`;
};

export const identityFromCanonical = (value: unknown): string => {
  const canonical = canonicalJson(value);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
};
