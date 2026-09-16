import type { JsonSchema } from '../tool-registry.js';

export const stringSchema: JsonSchema = { type: 'string' };
export const projectIdSchema: JsonSchema = { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{1,63}$' };

export function objectSchema(properties: Readonly<Record<string, JsonSchema>>, required: readonly string[] = []): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}
