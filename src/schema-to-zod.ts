// TypeBox / JSON Schema → Zod shape for Droid SDK `tool()`.
// Ported from pi-claude-bridge (same Pi tool parameter encoding).

import { z } from "zod";

export function jsonSchemaPropertyToZod(prop: Record<string, unknown>): z.ZodTypeAny {
  let base: z.ZodTypeAny;
  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    base = z.enum(prop.enum as [string, ...string[]]);
  } else {
    switch (prop.type) {
      case "string":
        base = z.string();
        break;
      case "number":
      case "integer":
        base = z.number();
        break;
      case "boolean":
        base = z.boolean();
        break;
      case "array":
        base = prop.items
          ? z.array(jsonSchemaPropertyToZod(prop.items as Record<string, unknown>))
          : z.array(z.unknown());
        break;
      case "object":
        base = z.record(z.string(), z.unknown());
        break;
      default:
        base = z.unknown();
    }
  }
  if (typeof prop.description === "string") base = base.describe(prop.description);
  return base;
}

export function jsonSchemaToZodShape(schema: unknown): Record<string, z.ZodTypeAny> {
  const s = schema as Record<string, unknown> | null | undefined;
  if (!s || s.type !== "object" || !s.properties || typeof s.properties !== "object") return {};
  const props = s.properties as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(props)) {
    const zodProp = jsonSchemaPropertyToZod(prop ?? {});
    shape[key] = required.has(key) ? zodProp : zodProp.optional();
  }
  return shape;
}
