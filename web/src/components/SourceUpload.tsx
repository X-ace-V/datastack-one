import { useRef, useState } from "react";

/** Composer-local add menu. Upload/folder controls intentionally live nowhere else. */
export function SourceUpload({
  disabled = false,
  hasFolder = false,
  onFiles,
  onConnectFolder,
}: {
  disabled?: boolean;
  hasFolder?: boolean;
  onFiles: (files: File[]) => void;
  onConnectFolder: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);

  return (
    <div className="relative shrink-0">
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".csv,.tsv,.json,.jsonl,.ndjson,.parquet,.sql,.yml,.yaml,.md,.markdown,.txt"
        aria-label="Choose files to upload"
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          if (files.length > 0) onFiles(files);
          event.target.value = "";
          setOpen(false);
        }}
      />
      <button
        type="button"
        aria-label="Add files or folder"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        className="flex h-9 items-center justify-center gap-2 rounded-lg px-2.5 text-xs font-semibold text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 disabled:opacity-40"
      >
        <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" stroke="currentColor" strokeWidth="1.9" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        Add
      </button>
      {open && (
        <div className="absolute bottom-12 left-0 z-20 w-64 overflow-hidden rounded-2xl border border-slate-200 bg-white p-1.5 shadow-[0_18px_55px_-18px_rgba(15,23,42,0.35)]">
          <button type="button" aria-label="Upload files" onClick={() => inputRef.current?.click()} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-slate-700 transition hover:bg-slate-50">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-50 text-violet-600" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" stroke="currentColor" strokeWidth="1.8"><path d="M12 16V4m0 0L7 9m5-5 5 5M5 14v5h14v-5" /></svg></span>
            <span><span className="block font-medium">Upload files</span><span className="block text-xs text-slate-400">CSV, JSON, SQL, Parquet, and more</span></span>
          </button>
          <button
            type="button"
            aria-label={hasFolder ? "Start session in another folder" : "Start session from folder"}
            onClick={() => {
              setOpen(false);
              onConnectFolder();
            }}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-slate-700 transition hover:bg-slate-50"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-50 text-amber-600" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" stroke="currentColor" strokeWidth="1.8"><path d="M3 6h7l2 2h9v11H3V6Z" /></svg></span>
            <span><span className="block font-medium">{hasFolder ? "Switch working folder" : "Connect a folder"}</span><span className="block text-xs text-slate-400">Start a session in an existing project</span></span>
          </button>
        </div>
      )}
    </div>
  );
}
