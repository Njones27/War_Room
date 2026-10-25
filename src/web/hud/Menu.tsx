import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./icons";

export interface MenuItem {
  label: string;
  icon?: IconName;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
}

/** Room a menu needs before it opens the other way. */
const ROOM = 180;

/**
 * A ⋯ button that opens a short list of actions. The list renders at the top of
 * the page, so a dialog's scrolling body can't clip it. It opens below the button
 * when `down` (above otherwise), and flips if that side lacks room.
 */
export function MoreMenu({ items, label = "More actions", down = false, className = "tbtn" }: { items: (MenuItem | "sep")[]; label?: string; down?: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({});
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const below = down ? window.innerHeight - r.bottom >= ROOM || r.top < ROOM : r.top < ROOM;
    setStyle({ right: window.innerWidth - r.right, ...(below ? { top: r.bottom + 6 } : { bottom: window.innerHeight - r.top + 6 }) });
  }, [open, down]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!button.current?.contains(t) && !menu.current?.contains(t)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    // The menu is placed once; anything that moves the button closes it.
    const close = () => setOpen(false);
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return (
    <>
      <button ref={button} className={className} aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="more" />
      </button>
      {open &&
        createPortal(
          <div ref={menu} className="menu" role="menu" style={style}>
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
          </div>,
          document.body,
        )}
    </>
  );
}
