"use client";

import { useRef, useState } from "react";
import Image from "next/image";
import { Camera, UploadCloud, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface PhotoUploaderProps {
  previewUrl: string | null;
  onSelect: (file: File) => void;
  onRemove: () => void;
}

export function PhotoUploader({ previewUrl, onSelect, onRemove }: PhotoUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);

  function handleFiles(files: FileList | null) {
    const file = files?.[0];
    if (file && file.type.startsWith("image/")) {
      onSelect(file);
    }
  }

  if (previewUrl) {
    return (
      <div className="relative overflow-hidden rounded-2xl border border-border">
        <div className="relative aspect-[16/9] w-full">
          <Image src={previewUrl} alt="Uploaded photo preview" fill sizes="640px" className="object-cover" />
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-border bg-white px-4 py-3">
          <span className="text-xs font-medium text-foreground-muted">Photo attached</span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="rounded-full border border-border px-3 py-1.5 text-xs font-medium text-foreground transition hover:border-civic-300 hover:bg-civic-50"
            >
              Change
            </button>
            <button
              type="button"
              onClick={onRemove}
              className="flex items-center gap-1 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-foreground-muted transition hover:border-priority-critical/40 hover:text-priority-critical"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              Remove
            </button>
          </div>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>
    );
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragActive(true);
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragActive(false);
        handleFiles(e.dataTransfer.files);
      }}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
      }}
      className={cn(
        "flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 py-14 text-center transition-colors",
        dragActive ? "border-civic-400 bg-civic-50" : "border-border bg-surface-muted/60 hover:border-civic-300",
      )}
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white text-civic-700 shadow-sm">
        <Camera className="h-5 w-5" aria-hidden="true" />
      </span>
      <div>
        <p className="text-sm font-semibold text-foreground">Upload a photo</p>
        <p className="mt-1 flex items-center justify-center gap-1.5 text-xs text-foreground-muted">
          <UploadCloud className="h-3.5 w-3.5" aria-hidden="true" />
          Drag &amp; drop, or click to browse
        </p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
    </div>
  );
}
