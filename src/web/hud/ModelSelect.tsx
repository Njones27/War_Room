import { useEffect, useState } from "react";
import { isKnownModel, MODEL_OPTIONS } from "../../shared/models";

const CUSTOM = "__custom__";

/**
 * Model picker: your default, family aliases, pinned versions, or a custom name.
 * With `commitOnBlur`, a custom name is only reported when the field loses focus.
 * `defaultLabel` names the empty choice (e.g. "General picks").
 */
export function ModelSelect({
  value,
  onChange,
  compact,
  commitOnBlur,
  defaultLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  compact?: boolean;
  commitOnBlur?: boolean;
  defaultLabel?: string;
}) {
  const [custom, setCustom] = useState(!isKnownModel(value));
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setCustom((c) => c || !isKnownModel(value));
    setDraft(value);
  }, [value]);
  const groups = [
    { label: "Aliases (newest in family)", items: MODEL_OPTIONS.filter((m) => m.group === "alias") },
    { label: "Pinned versions", items: MODEL_OPTIONS.filter((m) => m.group === "pinned") },
  ];
  return (
    <div style={{ display: "grid", gap: "0.3rem" }}>
      <select
        value={custom ? CUSTOM : value}
        onChange={(e) => {
          if (e.target.value === CUSTOM) {
            setCustom(true);
            return;
          }
          setCustom(false);
          onChange(e.target.value);
        }}
      >
        <option value="">{defaultLabel ?? (compact ? "default" : MODEL_OPTIONS[0]!.label)}</option>
        {groups.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.items.map((m) => (
              <option key={m.value} value={m.value}>
                {compact ? m.value : m.label}
              </option>
            ))}
          </optgroup>
        ))}
        <option value={CUSTOM}>Custom…</option>
      </select>
      {custom && (
        <input
          placeholder="Model name, e.g. claude-opus-5-5"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (!commitOnBlur) onChange(e.target.value);
          }}
          onBlur={() => commitOnBlur && draft !== value && onChange(draft)}
          onKeyDown={(e) => e.key === "Enter" && commitOnBlur && draft !== value && onChange(draft)}
        />
      )}
    </div>
  );
}
