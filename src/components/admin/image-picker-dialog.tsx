"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Folder, Loader2, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Standalone image picker dialog. Lets an admin choose an image from the same
 * three sources used by the rich-text editor — uploaded library images
 * (/api/admin/image-library), images shipped with the site (public/branding,
 * via /api/admin/site-images), and the filesystem Image Manager
 * (/api/admin/image-manager) — and returns the selected URL via `onSelect`.
 *
 * Unlike the rich-text "insert image" flow, this does not deal with sizing or
 * caret insertion: it just resolves a single URL string, which callers store
 * (for example, as a page's hero background in structuredContent).
 */

type MediaImageSummary = {
  id: string;
  filename: string;
  url: string;
  contentType: string;
  byteSize: number;
  altText: string | null;
  width: number | null;
  height: number | null;
  createdAt: string;
};

type FilesystemImageEntry = {
  filename: string;
  url: string;
};

type PickerImage = {
  url: string;
  label: string;
  source: "uploaded" | "branding" | "filesystem";
  id?: string;
};

const UPLOADABLE_IMAGE_TYPES =
  "image/png,image/jpeg,image/gif,image/webp,image/avif,image/svg+xml";

export function ImagePickerDialog({
  open,
  onOpenChange,
  onSelect,
  title = "Choose an image",
  description = "Pick an uploaded image, an image deployed with the site (public/branding), or upload a new image (PNG, JPEG, GIF, WebP, AVIF, or SVG, up to 2MB).",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (url: string) => void;
  title?: string;
  description?: string;
}) {
  const [loadingSiteImages, setLoadingSiteImages] = useState(false);
  const [siteImages, setSiteImages] = useState<string[]>([]);
  const [loadingUploadedImages, setLoadingUploadedImages] = useState(false);
  const [uploadedImages, setUploadedImages] = useState<MediaImageSummary[]>([]);
  const [uploading, setUploading] = useState(false);
  const [imageFilter, setImageFilter] = useState("");
  const [selectedImagePath, setSelectedImagePath] = useState("");
  const [pickerDir, setPickerDir] = useState("__root__");
  const [pickerDirs, setPickerDirs] = useState<string[]>(["__root__"]);
  const [loadingPickerDirs, setLoadingPickerDirs] = useState(false);
  const [filesystemImages, setFilesystemImages] = useState<
    FilesystemImageEntry[]
  >([]);
  const [loadingFilesystemImages, setLoadingFilesystemImages] = useState(false);
  const imageFileInputRef = useRef<HTMLInputElement | null>(null);

  const pickerImages = useMemo<PickerImage[]>(() => {
    const filesystem: PickerImage[] = filesystemImages.map((img) => ({
      url: img.url,
      label: img.filename,
      source: "filesystem",
    }));
    // Only show uploaded + branding sources when viewing the root directory.
    if (pickerDir !== "__root__") {
      return filesystem;
    }
    const uploaded: PickerImage[] = uploadedImages.map((image) => ({
      url: image.url,
      label: image.filename,
      source: "uploaded",
      id: image.id,
    }));
    const branding: PickerImage[] = siteImages.map((path) => ({
      url: path,
      label: path,
      source: "branding",
    }));
    return [...uploaded, ...branding, ...filesystem];
  }, [siteImages, uploadedImages, filesystemImages, pickerDir]);

  const filteredPickerImages = useMemo(() => {
    const needle = imageFilter.trim().toLowerCase();
    if (!needle) {
      return pickerImages;
    }
    return pickerImages.filter((img) =>
      img.label.toLowerCase().includes(needle),
    );
  }, [imageFilter, pickerImages]);

  // Reset transient state each time the dialog opens.
  useEffect(() => {
    if (open) {
      setImageFilter("");
      setPickerDir("__root__");
      setSelectedImagePath("");
    }
  }, [open]);

  // Load uploaded library + branding images.
  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setLoadingSiteImages(true);
    setLoadingUploadedImages(true);

    fetch("/api/admin/site-images", { credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (cancelled) return;
        setSiteImages(Array.isArray(body?.images) ? (body.images as string[]) : []);
      })
      .catch(() => {
        if (!cancelled) setSiteImages([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingSiteImages(false);
      });

    fetch("/api/admin/image-library?pageSize=100", { credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (cancelled) return;
        setUploadedImages(
          Array.isArray(body?.images) ? (body.images as MediaImageSummary[]) : [],
        );
      })
      .catch(() => {
        if (!cancelled) setUploadedImages([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingUploadedImages(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  // Load filesystem directories (Image Manager).
  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setLoadingPickerDirs(true);
    fetch("/api/admin/image-manager/directories", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled) return;
        const dirs = Array.isArray(body?.directories)
          ? (body.directories as string[])
          : [""];
        setPickerDirs(dirs.map((d) => (d === "" ? "__root__" : d)));
      })
      .catch(() => {
        if (!cancelled) setPickerDirs(["__root__"]);
      })
      .finally(() => {
        if (!cancelled) setLoadingPickerDirs(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  // Load filesystem images for the selected directory.
  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setFilesystemImages([]);
    setLoadingFilesystemImages(true);
    const apiDir = pickerDir === "__root__" ? "" : pickerDir;
    fetch(`/api/admin/image-manager/images?dir=${encodeURIComponent(apiDir)}`, {
      credentials: "same-origin",
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled) return;
        setFilesystemImages(
          Array.isArray(body?.images) ? (body.images as FilesystemImageEntry[]) : [],
        );
      })
      .catch(() => {
        if (!cancelled) setFilesystemImages([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingFilesystemImages(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, pickerDir]);

  // Default the selection to the first image once everything has loaded.
  useEffect(() => {
    if (
      !open ||
      loadingSiteImages ||
      loadingUploadedImages ||
      loadingFilesystemImages
    ) {
      return;
    }
    setSelectedImagePath((current) => current || pickerImages[0]?.url || "");
  }, [
    open,
    loadingSiteImages,
    loadingUploadedImages,
    loadingFilesystemImages,
    pickerImages,
  ]);

  async function uploadImageFile(file: File) {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch("/api/admin/image-library", {
        method: "POST",
        credentials: "same-origin",
        body: formData,
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error ?? "Failed to upload image");
      }
      const uploaded = body.image as MediaImageSummary;
      setUploadedImages((current) => [uploaded, ...current]);
      setSelectedImagePath(uploaded.url);
      toast.success(`Uploaded ${uploaded.filename}`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to upload image",
      );
    } finally {
      setUploading(false);
    }
  }

  async function deleteUploadedImage(
    image: MediaImageSummary,
    event: React.MouseEvent,
  ) {
    event.stopPropagation();
    if (!window.confirm(`Delete ${image.filename}? This cannot be undone.`)) {
      return;
    }
    try {
      const response = await fetch(`/api/admin/image-library/${image.id}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error ?? "Failed to delete image");
      }
      setUploadedImages((current) =>
        current.filter((item) => item.id !== image.id),
      );
      if (selectedImagePath === image.url) {
        setSelectedImagePath("");
      }
      const referencedBySlugs = Array.isArray(body?.referencedBySlugs)
        ? (body.referencedBySlugs as string[])
        : [];
      if (referencedBySlugs.length > 0) {
        toast.warning(
          `Deleted ${image.filename}, but it is still referenced on: ${referencedBySlugs.join(", ")}. Those images will now be broken.`,
        );
      } else {
        toast.success(`Deleted ${image.filename}`);
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to delete image",
      );
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-3xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
          {/* Directory selector */}
          <div className="flex shrink-0 items-center gap-2">
            <Folder className="h-4 w-4 shrink-0 text-slate-400" />
            <Select
              value={pickerDir}
              onValueChange={(val) => {
                setPickerDir(val);
                setSelectedImagePath("");
              }}
              disabled={loadingPickerDirs}
            >
              <SelectTrigger className="flex-1 text-xs">
                <SelectValue placeholder="Select folder…" />
              </SelectTrigger>
              <SelectContent>
                {pickerDirs.map((dir) => (
                  <SelectItem key={dir} value={dir} className="text-xs">
                    {dir === "__root__"
                      ? "images/ (root)"
                      : dir.replace(/\//g, " / ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Filter + upload row */}
          <div className="flex shrink-0 items-center gap-2">
            <Input
              value={imageFilter}
              onChange={(event) => setImageFilter(event.target.value)}
              placeholder="Filter images by name"
              className="flex-1"
            />
            <input
              ref={imageFileInputRef}
              type="file"
              accept={UPLOADABLE_IMAGE_TYPES}
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  void uploadImageFile(file);
                }
                event.target.value = "";
              }}
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => imageFileInputRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              Upload
            </Button>
          </div>

          {/* Thumbnail grid */}
          <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-slate-200 bg-slate-50 p-2">
            {loadingSiteImages ||
            loadingUploadedImages ||
            loadingFilesystemImages ? (
              <p className="p-3 text-sm text-slate-500">Loading images…</p>
            ) : filteredPickerImages.length === 0 ? (
              <p className="p-3 text-sm text-slate-500">
                No images found. Upload one to get started.
              </p>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2">
                {filteredPickerImages.map((image) => {
                  const isSelected = selectedImagePath === image.url;
                  const shortLabel = image.label.includes("/")
                    ? (image.label.split("/").pop() ?? image.label)
                    : image.label;
                  return (
                    <div
                      key={`${image.source}:${image.url}`}
                      className={`group relative cursor-pointer overflow-hidden rounded-lg border-2 bg-white shadow-sm transition-all ${
                        isSelected
                          ? "border-blue-500 ring-2 ring-blue-200"
                          : "border-slate-200 hover:border-slate-400 hover:shadow-md"
                      }`}
                      onClick={() => setSelectedImagePath(image.url)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelectedImagePath(image.url);
                        }
                      }}
                      role="button"
                      tabIndex={0}
                      aria-pressed={isSelected}
                      aria-label={shortLabel}
                    >
                      <div className="relative aspect-square overflow-hidden bg-slate-100">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={image.url}
                          alt={shortLabel}
                          className="h-full w-full object-cover"
                          loading="lazy"
                        />
                        {image.source === "uploaded" ? (
                          <button
                            type="button"
                            aria-label={`Delete ${shortLabel}`}
                            title={`Delete ${shortLabel}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              const uploaded = uploadedImages.find(
                                (item) => item.id === image.id,
                              );
                              if (uploaded) {
                                void deleteUploadedImage(uploaded, event);
                              }
                            }}
                            className="absolute right-1 top-1 rounded-full bg-white/80 p-1 opacity-0 shadow-sm transition-opacity hover:bg-red-50 group-hover:opacity-100"
                          >
                            <Trash2 className="h-3 w-3 text-red-500" />
                          </button>
                        ) : null}
                      </div>
                      <div className="p-1.5">
                        <p
                          className="truncate text-xs font-medium text-slate-800"
                          title={image.label}
                        >
                          {shortLabel}
                        </p>
                        <Badge
                          variant={
                            image.source === "uploaded"
                              ? "default"
                              : image.source === "filesystem"
                                ? "outline"
                                : "secondary"
                          }
                          className="mt-0.5 text-[9px] uppercase"
                        >
                          {image.source === "uploaded"
                            ? "Uploaded"
                            : image.source === "filesystem"
                              ? "Images"
                              : "Branding"}
                        </Badge>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Selected path strip */}
          {selectedImagePath ? (
            <div className="flex shrink-0 items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={selectedImagePath}
                alt="Selected"
                className="h-10 w-10 shrink-0 rounded border border-slate-200 object-cover"
              />
              <p className="min-w-0 flex-1 truncate text-xs text-slate-600">
                {selectedImagePath}
              </p>
            </div>
          ) : null}

          {/* Footer */}
          <div className="flex shrink-0 justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (!selectedImagePath) return;
                onSelect(selectedImagePath);
                onOpenChange(false);
              }}
              disabled={!selectedImagePath}
            >
              Use this image
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
