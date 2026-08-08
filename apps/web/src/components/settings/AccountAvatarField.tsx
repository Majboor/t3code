import {
  AUTH_AVATAR_IMAGE_MIME_TYPES,
  AUTH_AVATAR_MAX_DECODED_BYTES,
  AUTH_AVATAR_MAX_DIMENSION,
} from "@t3tools/contracts";
import { LoaderIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";

// The original is decoded in this tab before it can be downscaled, so an
// unbounded source file would cost memory the upload cap never sees.
const MAX_SOURCE_FILE_BYTES = 8 * 1024 * 1024;
const JPEG_QUALITY = 0.85;

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener(
      "error",
      () => reject(reader.error ?? new Error("Failed to read the image file.")),
      { once: true },
    );
    reader.addEventListener("load", () => resolve(String(reader.result)), { once: true });
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener("error", () => reject(new Error("Failed to decode the image file.")), {
      once: true,
    });
    image.src = dataUrl;
  });
}

function decodedBase64ByteLength(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

async function downscaleToAvatarDataUrl(file: File): Promise<string> {
  if (!AUTH_AVATAR_IMAGE_MIME_TYPES.some((allowed) => allowed === file.type)) {
    throw new Error(`Avatar image must be one of ${AUTH_AVATAR_IMAGE_MIME_TYPES.join(", ")}.`);
  }
  if (file.size > MAX_SOURCE_FILE_BYTES) {
    throw new Error(
      `Pick an image under ${Math.floor(MAX_SOURCE_FILE_BYTES / (1024 * 1024))}MB before scaling.`,
    );
  }
  const image = await loadImage(await readFileAsDataUrl(file));
  const cropSide = Math.min(image.naturalWidth, image.naturalHeight);
  if (cropSide < 1) {
    throw new Error("Failed to decode the image file.");
  }
  const side = Math.min(AUTH_AVATAR_MAX_DIMENSION, cropSide);
  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("This browser cannot resize images.");
  }
  context.drawImage(
    image,
    (image.naturalWidth - cropSide) / 2,
    (image.naturalHeight - cropSide) / 2,
    cropSide,
    cropSide,
    0,
    0,
    side,
    side,
  );
  // PNG sources keep their transparency; anything else re-encodes smaller as JPEG.
  const encoded =
    file.type === "image/png"
      ? canvas.toDataURL("image/png")
      : canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  if (decodedBase64ByteLength(encoded) > AUTH_AVATAR_MAX_DECODED_BYTES) {
    throw new Error(
      `Avatar image must be at most ${Math.floor(AUTH_AVATAR_MAX_DECODED_BYTES / 1024)}KB.`,
    );
  }
  return encoded;
}

export function AccountAvatarField({
  initials,
  value,
  disabled,
  onChange,
  onError,
}: {
  initials: string;
  value: string | undefined;
  disabled?: boolean;
  onChange: (next: string | undefined) => void;
  onError: (message: string | null) => void;
}) {
  const [isProcessing, setIsProcessing] = useState(false);

  const handleFile = useCallback(
    async (file: File | undefined) => {
      if (!file) {
        return;
      }
      setIsProcessing(true);
      onError(null);
      try {
        onChange(await downscaleToAvatarDataUrl(file));
      } catch (error) {
        onError(error instanceof Error ? error.message : "Failed to read the image file.");
      } finally {
        setIsProcessing(false);
      }
    },
    [onChange, onError],
  );

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted text-sm font-semibold text-foreground">
        {value ? (
          <img src={value} alt="Profile picture preview" className="size-full object-cover" />
        ) : (
          initials
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="file"
            accept={AUTH_AVATAR_IMAGE_MIME_TYPES.join(",")}
            className="max-w-56"
            aria-label="Profile picture"
            disabled={disabled || isProcessing}
            onChange={(event) => {
              void handleFile(event.currentTarget.files?.[0]);
              event.currentTarget.value = "";
            }}
          />
          {value ? (
            <Button
              size="xs"
              variant="outline"
              disabled={disabled || isProcessing}
              onClick={() => {
                onChange(undefined);
                onError(null);
              }}
            >
              Remove image
            </Button>
          ) : null}
          {isProcessing ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
        </div>
        <p className="text-xs text-muted-foreground">
          PNG, JPEG or WebP. Cropped to {AUTH_AVATAR_MAX_DIMENSION}px and capped at{" "}
          {Math.floor(AUTH_AVATAR_MAX_DECODED_BYTES / 1024)}KB. Without an image the initials are
          used.
        </p>
      </div>
    </div>
  );
}
