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
        aria-label="Upload files"
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
        className="flex h-9 w-9 items-center justify-center rounded-lg text-xl text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-40"
      >
        +
      </button>
      {open && (
        <div className="absolute bottom-11 left-0 z-20 w-48 overflow-hidden rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
          <button type="button" onClick={() => inputRef.current?.click()} className="w-full rounded-md px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100">
            Upload files
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onConnectFolder();
            }}
            className="w-full rounded-md px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100"
          >
            {hasFolder ? "Start session in another folder" : "Start session from folder"}
          </button>
        </div>
      )}
    </div>
  );
}
