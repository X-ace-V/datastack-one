import { useState } from "react";

/**
 * The chat input (TASKS V2.4, PRD FR2). A single growable textarea plus a send button; while a
 * turn is in flight the send button becomes a cancel button so the user can abort (`FR2` cancel).
 * Enter sends, Shift+Enter inserts a newline. A whitespace-only message never sends.
 */
export interface ComposerProps {
  /** True while a turn is streaming — swaps Send for Cancel and blocks a new send. */
  isWorking: boolean;
  /** Disable input entirely (e.g. no active session). */
  disabled?: boolean;
  /** Send a (trimmed, non-empty) prompt. */
  onSend: (text: string) => void;
  /** Abort the in-flight turn. */
  onCancel: () => void;
}

export function Composer({ isWorking, disabled = false, onSend, onCancel }: ComposerProps) {
  const [text, setText] = useState("");
  const canSend = text.trim().length > 0 && !disabled && !isWorking;

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled || isWorking) return;
    onSend(trimmed);
    setText("");
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="border-t border-slate-200 bg-white px-4 py-3"
    >
      <div className="mx-auto flex max-w-2xl items-end gap-2">
        <textarea
          aria-label="Message the agent"
          value={text}
          disabled={disabled}
          rows={1}
          placeholder="Ask about your data…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a newline.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          className="max-h-40 min-h-[2.5rem] flex-1 resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:bg-slate-50"
        />
        {isWorking ? (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg bg-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-300"
          >
            Cancel
          </button>
        ) : (
          <button
            type="submit"
            disabled={!canSend}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            Send
          </button>
        )}
      </div>
    </form>
  );
}
