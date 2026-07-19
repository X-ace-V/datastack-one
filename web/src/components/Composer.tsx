import { useState } from "react";
import type { AttachmentRef, SessionFolder } from "../lib/api";
import type { ComposerAttachment } from "../store/sessionStore";
import { SourceUpload } from "./SourceUpload";

export interface ComposerProps {
  isWorking: boolean;
  disabled?: boolean;
  value?: string;
  attachments?: ComposerAttachment[];
  folder?: SessionFolder | null;
  onChange?: (text: string) => void;
  onFiles?: (files: File[]) => void;
  onOpenFolder?: () => void;
  onRefreshFolder?: () => void;
  onRemoveAttachment?: (id: string) => void;
  onRetryAttachment?: (id: string) => void;
  onSend: (text: string, attachments?: AttachmentRef[]) => void;
  onCancel: () => void;
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function Composer({
  isWorking,
  disabled = false,
  value,
  attachments = [],
  folder = null,
  onChange,
  onFiles = () => {},
  onOpenFolder = () => {},
  onRefreshFolder,
  onRemoveAttachment,
  onRetryAttachment,
  onSend,
  onCancel,
}: ComposerProps) {
  const [internalText, setInternalText] = useState("");
  const text = value ?? internalText;
  const setText = (next: string) => {
    if (value === undefined) setInternalText(next);
    onChange?.(next);
  };
  const uploading = attachments.some((attachment) => attachment.status === "uploading");
  const ready = attachments.filter(
    (attachment): attachment is ComposerAttachment & { source: NonNullable<ComposerAttachment["source"]> } =>
      attachment.status === "ready" && attachment.source !== undefined,
  );
  const canSend =
    (text.trim().length > 0 || ready.length > 0) && !disabled && !isWorking && !uploading;

  const submit = () => {
    if (!canSend) return;
    const refs = ready.map((attachment) => ({
      name: attachment.source.name,
      kind: attachment.source.kind,
    }));
    if (refs.length > 0) onSend(text.trim(), refs);
    else onSend(text.trim());
    setText("");
  };

  return (
    <form onSubmit={(event) => { event.preventDefault(); submit(); }} className="bg-gradient-to-t from-slate-50 via-slate-50 to-transparent px-4 pb-5 pt-3 sm:px-7">
      <div className="mx-auto max-w-3xl rounded-2xl border border-slate-200/90 bg-white shadow-[0_16px_50px_-24px_rgba(15,23,42,0.35)] transition focus-within:border-violet-400 focus-within:shadow-[0_18px_55px_-24px_rgba(109,40,217,0.32)] focus-within:ring-4 focus-within:ring-violet-100/70">
        {(folder || attachments.length > 0) && (
          <div className="flex flex-wrap gap-2 border-b border-slate-100 px-3.5 py-2.5">
            {folder && (
              <span
                className={`inline-flex max-w-full items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium ${folder.workspaceRoot ? "border-violet-100 bg-violet-50 text-violet-800" : "border-amber-100 bg-amber-50 text-amber-800"}`}
                title={folder.workspaceRoot ? `Working directory: ${folder.path}` : "Legacy folder attachment — start a new session here to make it the working directory"}
              >
                <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M3 6h7l2 2h9v11H3V6Z" /></svg>
                <span className="max-w-52 truncate">{folder.name}</span>
                {!folder.workspaceRoot && <span>reopen as workspace</span>}
                {onRefreshFolder && <button type="button" onClick={onRefreshFolder} aria-label={`Refresh ${folder.name}`} className="text-indigo-500 hover:text-indigo-900">↻</button>}
              </span>
            )}
            {attachments.map((attachment) => (
              <span key={attachment.id} className={`inline-flex max-w-full items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs ${attachment.status === "error" ? "border-red-100 bg-red-50 text-red-700" : attachment.status === "ready" ? "border-emerald-100 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-50 text-slate-600"}`} title={attachment.error}>
                <span className="max-w-44 truncate">{attachment.name}</span>
                <span className="opacity-70">{attachment.status === "uploading" ? "Uploading…" : attachment.status === "ready" ? fileSize(attachment.size) : "Failed"}</span>
                {attachment.status === "error" && onRetryAttachment && <button type="button" onClick={() => onRetryAttachment(attachment.id)} className="font-medium">Retry</button>}
                {onRemoveAttachment && <button type="button" onClick={() => onRemoveAttachment(attachment.id)} aria-label={`Remove ${attachment.name}`} className="opacity-70 hover:opacity-100">×</button>}
              </span>
            ))}
          </div>
        )}

        <textarea
          aria-label="Message the agent"
          value={text}
          disabled={disabled}
          rows={3}
          placeholder="Ask the data engineering agent…"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          className="max-h-48 min-h-[5.25rem] w-full resize-none border-0 bg-transparent px-4 pt-4 text-[15px] leading-6 text-slate-800 outline-none placeholder:text-slate-400 disabled:bg-slate-50"
        />
        <div className="flex items-center justify-between px-3 pb-3">
          <div className="flex items-center gap-3">
            <SourceUpload disabled={disabled} hasFolder={folder !== null} onFiles={onFiles} onConnectFolder={onOpenFolder} />
            <span className="hidden text-[11px] text-slate-400 sm:inline">Enter to send · Shift + Enter for a new line</span>
          </div>
          {isWorking ? (
            <button type="button" onClick={onCancel} className="flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700"><span className="h-2.5 w-2.5 rounded-sm bg-white" />Cancel</button>
          ) : (
            <button type="submit" disabled={!canSend} className="flex items-center gap-2 rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-violet-700 disabled:translate-y-0 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none">Send<svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m5 12 14-7-4 14-3-6-7-1Z" /></svg></button>
          )}
        </div>
      </div>
    </form>
  );
}
