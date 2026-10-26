import type { VariableType } from "@envsync-internal/schema";

/**
 * Checks on values read from runtime env files. Pure functions; nothing here prints or stores a value.
 */

/**
 * Whether `value` is valid for the declared type. `undefined` when it cannot be known statically:
 * values containing `$` may be expanded by Next.js (dotenv-expand) before the application sees them.
 */
export function matchesType(value: string, type: VariableType, quote?: string): boolean | undefined {
  if (quote !== "'" && value.includes("$")) return undefined;
  const trimmed = value.trim();
  switch (type) {
    case "string":
      return true;
    case "number":
      return trimmed !== "" && Number.isFinite(Number(trimmed));
    case "boolean":
      return BOOLEAN_VALUES.has(trimmed.toLowerCase());
    case "url":
      return URL.canParse(trimmed) && /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  }
}

const BOOLEAN_VALUES = new Set(["true", "false", "1", "0"]);

/**
 * Known credential formats. Each is specific enough that a match in a client-visible variable is
 * almost certainly a leaked secret, not a publishable key (Stripe `pk_` keys, for example, do not match).
 */
const SECRET_FORMATS: readonly { label: string; pattern: RegExp }[] = [
  { label: "a Stripe secret or restricted key", pattern: /^(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{10,}/ },
  { label: "a GitHub token", pattern: /^(?:gh[pousr]_[0-9A-Za-z]{30,}|github_pat_[0-9A-Za-z_]{30,})/ },
  { label: "an AWS access key ID", pattern: /^(?:AKIA|ASIA)[0-9A-Z]{16}$/ },
  { label: "a Slack token", pattern: /^xox[abposr]-[0-9A-Za-z-]{10,}/ },
  { label: "an OpenAI or Anthropic API key", pattern: /^sk-(?:proj-|ant-)?[0-9A-Za-z_-]{20,}/ },
  { label: "a private key", pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
];

/** A description of the credential format `value` matches, or `undefined`. */
export function secretValueFormat(value: string): string | undefined {
  const trimmed = value.trim();
  const label = SECRET_FORMATS.find(({ pattern }) => pattern.test(trimmed))?.label;
  if (label !== undefined) return label;
  return hasPasswordInUserinfo(trimmed) ? "a connection string with a password" : undefined;
}

/**
 * `[scheme://]user:password@host`, where the password may contain `/` or `:` (unencoded passwords are a
 * common reason a connection URL fails to parse). Linear scan, no regular expression backtracking.
 */
function hasPasswordInUserinfo(value: string): boolean {
  // `mailto:name@host` has the same shape without a scheme separator, but holds no password.
  if (value.toLowerCase().startsWith("mailto:")) return false;
  const at = value.lastIndexOf("@");
  if (at <= 0 || /\s/.test(value.slice(0, at))) return false;
  const scheme = value.indexOf("://");
  const userinfo = value.slice(scheme >= 0 && scheme < at ? scheme + 3 : 0, at);
  const colon = userinfo.indexOf(":");
  return colon > 0 && colon < userinfo.length - 1;
}
