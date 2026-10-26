export const VARIABLE_TYPES = ["string", "number", "boolean", "url"] as const;

export type VariableType = (typeof VARIABLE_TYPES)[number];

/** Plain: readable by authorized users. Sensitive: revealed only explicitly. Secret: write-only. */
export const VISIBILITIES = ["plain", "sensitive", "secret"] as const;

export type Visibility = (typeof VISIBILITIES)[number];

export function isVisibility(value: string): value is Visibility {
  return (VISIBILITIES as readonly string[]).includes(value);
}

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Portable environment-variable names: letters, digits and underscores, not starting with a digit. */
export function isValidVariableName(name: string): boolean {
  return VARIABLE_NAME.test(name);
}

export function isVariableType(value: string): value is VariableType {
  return (VARIABLE_TYPES as readonly string[]).includes(value);
}
