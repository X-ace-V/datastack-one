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
    <form onSubmit={(event) => { event.preventDefault(); submit(); }} className="border-t border-slate-200 bg-white px-4 py-3">
      <div className="mx-auto max-w-2xl rounded-xl border border-slate-300 bg-white shadow-sm focus-within:border-indigo-500 focus-within:ring-1 focus-within:ring-indigo-500">
        {(folder || attachments.length > 0) && (
          <div className="flex flex-wrap gap-2 border-b border-slate-100 px-3 py-2">
            {folder && (
              <span
                className={`inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ${folder.workspaceRoot ? "bg-indigo-50 text-indigo-800" : "bg-amber-50 text-amber-800"}`}
                title={folder.workspaceRoot ? `Working directory: ${folder.path}` : "Legacy folder attachment — start a new session here to make it the working directory"}
              >
                <span aria-hidden="true">▣</span>
                <span className="max-w-52 truncate">{folder.name}</span>
                {!folder.workspaceRoot && <span>reopen as workspace</span>}
                {onRefreshFolder && <button type="button" onClick={onRefreshFolder} aria-label={`Refresh ${folder.name}`} className="text-indigo-500 hover:text-indigo-900">↻</button>}
              </span>
            )}
            {attachments.map((attachment) => (
              <span key={attachment.id} className={`inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ${attachment.status === "error" ? "bg-red-50 text-red-700" : attachment.status === "ready" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`} title={attachment.error}>
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
          rows={2}
          placeholder="Ask the data engineering agent…"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          className="max-h-40 min-h-[3.5rem] w-full resize-none border-0 bg-transparent px-3 pt-3 text-sm outline-none disabled:bg-slate-50"
        />
        <div className="flex items-center justify-between px-2 pb-2">
          <SourceUpload disabled={disabled} hasFolder={folder !== null} onFiles={onFiles} onConnectFolder={onOpenFolder} />
          {isWorking ? (
            <button type="button" onClick={onCancel} className="rounded-lg bg-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-300">Cancel</button>
          ) : (
            <button type="submit" disabled={!canSend} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">Send</button>
          )}
        </div>
      </div>
    </form>
  );
}
