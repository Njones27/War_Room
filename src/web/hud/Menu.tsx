import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./icons";

export interface MenuItem {
  label: string;
  icon?: IconName;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
}

/** A ⋯ button that opens a short list of actions. `down` opens it below the button. */
export function MoreMenu({ items, label = "More actions", down = false, className = "tbtn" }: { items: (MenuItem | "sep")[]; label?: string; down?: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc, true);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc, true);
    };
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      <button className={className} aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="more" />
      </button>
      {open && (
        <div className={`menu${down ? " down" : ""}`} role="menu">
          {items.map((it, i) =>
            it === "sep" ? (
              <hr key={i} />
            ) : (
              <button
                key={it.label}
                role="menuitem"
                className={it.danger ? "danger" : undefined}
                disabled={it.disabled}
                title={it.title}
                onClick={() => {
                  setOpen(false);
                  it.onClick();
                }}
              >
                {it.icon && <Icon name={it.icon} />}
                {it.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
