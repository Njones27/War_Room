// Models Claude Code accepts for --model. Claude Code has no command that lists
// them, so this mirrors https://code.claude.com/docs/en/model-config.
// Aliases always resolve to the newest model in the family.

export interface ModelOption {
  value: string;
  label: string;
  group: "default" | "alias" | "pinned";
}

export const MODEL_OPTIONS: ModelOption[] = [
  { value: "", label: "Your default (Claude Code setting)", group: "default" },
  { value: "best", label: "best · most capable available", group: "alias" },
  { value: "fable", label: "fable · Fable 5.1", group: "alias" },
  { value: "opus", label: "opus · Opus 5.5", group: "alias" },
  { value: "sonnet", label: "sonnet · Sonnet 5.5", group: "alias" },
  { value: "haiku", label: "haiku · Haiku 5.5", group: "alias" },
  { value: "opusplan", label: "opusplan · Opus plans, Sonnet builds", group: "alias" },
  { value: "sonnet[1m]", label: "sonnet[1m] · Sonnet, 1M context", group: "alias" },
  { value: "claude-fable-5-1", label: "Claude Fable 5.1", group: "pinned" },
  { value: "claude-fable-5", label: "Claude Fable 5", group: "pinned" },
  { value: "claude-opus-5-5", label: "Claude Opus 5.5", group: "pinned" },
  { value: "claude-opus-5", label: "Claude Opus 5", group: "pinned" },
  { value: "claude-opus-4-8", label: "Claude Opus 4.8", group: "pinned" },
  { value: "claude-opus-4-7", label: "Claude Opus 4.7", group: "pinned" },
  { value: "claude-opus-4-6", label: "Claude Opus 4.6", group: "pinned" },
  { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", group: "pinned" },
  { value: "claude-sonnet-5", label: "Claude Sonnet 5", group: "pinned" },
  { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", group: "pinned" },
  { value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", group: "pinned" },
  { value: "claude-haiku-5-5", label: "Claude Haiku 5.5", group: "pinned" },
  { value: "claude-haiku-4-5", label: "Claude Haiku 4.5", group: "pinned" },
];

export const EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max"] as const;

export function isKnownModel(value: string | null | undefined): boolean {
  return MODEL_OPTIONS.some((m) => m.value === (value ?? ""));
}
