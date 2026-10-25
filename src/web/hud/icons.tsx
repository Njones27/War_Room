import type { ObjectiveStatus } from "../../shared/protocol";

const PATHS = {
  expand: <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />,
  shrink: <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />,
  x: <path d="M18 6L6 18M6 6l12 12" />,
  play: <path d="M7 5l12 7-12 7z" fill="currentColor" stroke="none" />,
  pause: <path d="M8 5v14M16 5v14" strokeWidth="3" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" />,
  terminal: <path d="M5 7l5 5-5 5M12 18h7" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.7" fill="currentColor" stroke="none" />
    </>
  ),
  send: <path d="M12 19V5M5 12l7-7 7 7" />,
  chevDown: <path d="M6 9l6 6 6-6" />,
  chevUp: <path d="M6 15l6-6 6 6" />,
  chevRight: <path d="M9 6l6 6-6 6" />,
  info: <path d="M12 3a9 9 0 110 18 9 9 0 010-18zM12 11v5M12 8h.01" />,
  plus: <path d="M12 5v14M5 12h14" />,
  user: <path d="M12 4a4 4 0 110 8 4 4 0 010-8zM4 21c1-4 4.5-6 8-6s7 2 8 6" />,
  edit: <path d="M4 20h4L19 9l-4-4L4 16z" />,
  branch: <path d="M6 3a2 2 0 110 4 2 2 0 010-4zM6 17a2 2 0 110 4 2 2 0 010-4zM18 5a2 2 0 110 4 2 2 0 010-4zM6 7v10M18 9c0 5-6 4-11 8" />,
  check: <path d="M5 12l5 5 9-10" />,
  folder: <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />,
  resume: <path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4" />,
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size }: { name: IconName; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {PATHS[name]}
    </svg>
  );
}

/** Objective status as a small circle: empty, half, quarter or filled. */
export function StatusIcon({ status }: { status: ObjectiveStatus }) {
  return (
    <svg viewBox="0 0 24 24" className={`st-${status}`} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      {status === "done" ? (
        <>
          <circle cx="12" cy="12" r="8" fill="currentColor" stroke="none" />
          <path d="M8 12l3 3 5-6" stroke="#0b0f12" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : status === "cancelled" ? (
        <>
          <circle cx="12" cy="12" r="7" strokeDasharray="3 3" />
          <path d="M9 9l6 6" />
        </>
      ) : (
        <>
          <circle cx="12" cy="12" r="7" />
          {status === "in_progress" && <path d="M12 5a7 7 0 010 14z" fill="currentColor" />}
          {status === "in_review" && <path d="M12 5a7 7 0 017 7h-7z" fill="currentColor" />}
          {status === "blocked" && <path d="M8 16L16 8" />}
        </>
      )}
    </svg>
  );
}

export const STATUS_LABEL: Record<ObjectiveStatus, string> = {
  todo: "Todo",
  in_progress: "In progress",
  blocked: "Blocked",
  in_review: "In review",
  done: "Done",
  cancelled: "Cancelled",
};

export const STATUS_PILL: Record<ObjectiveStatus, string> = {
  todo: "",
  in_progress: "warn",
  blocked: "bad",
  in_review: "live",
  done: "ok",
  cancelled: "",
};
