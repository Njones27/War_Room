import { Fragment } from "react";

/** Text with `backtick` spans shown as code. */
export function Rich({ text }: { text: string }) {
  const parts = text.split(/(`[^`\n]+`)/);
  return (
    <>
      {parts.map((p, i) => (p.length > 2 && p.startsWith("`") && p.endsWith("`") ? <code key={i}>{p.slice(1, -1)}</code> : <Fragment key={i}>{p}</Fragment>))}
    </>
  );
}
