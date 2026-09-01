import {
  cardToFallbackText,
  extractCard,
  extractFiles,
  extractPostableAttachments,
  ValidationError,
} from "@chat-adapter/shared";
import {
  markdownToPlainText,
  toPlainText,
  type AdapterPostableMessage,
  type Attachment,
  type FileUpload,
} from "chat";
import type { RelayClient } from "./client.js";
import type { RelayOutgoingPart } from "./types.js";

export const RELAY_MAX_TEXT_PART_LENGTH = 10_000;
export const RELAY_MAX_MESSAGE_PARTS = 100;
export const RELAY_MAX_ATTACHMENT_BYTES = 104_857_600;

const SUPPORTED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/tiff",
  "image/bmp",
  "image/webp",
  "image/x-icon",
  "video/mp4",
  "video/quicktime",
  "video/mpeg",
  "video/mpeg2",
  "video/x-m4v",
  "video/x-msvideo",
  "video/3gpp",
  "audio/mpeg",
  "audio/mp3",
  "audio/x-m4a",
  "audio/mp4",
  "audio/x-caf",
  "audio/x-wav",
  "audio/x-aiff",
  "audio/aiff",
  "audio/aac",
  "audio/midi",
  "audio/amr",
  "application/pdf",
  "application/vnd.apple.pkpass",
  "text/plain",
  "text/markdown",
  "text/vcard",
  "text/rtf",
  "text/csv",
  "text/html",
  "text/calendar",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/x-iwork-pages-sffpages",
  "application/x-iwork-numbers-sffnumbers",
  "application/x-iwork-keynote-sffkey",
  "application/epub+zip",
  "text/xml",
  "application/json",
  "application/zip",
  "application/x-gzip",
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  aac: "audio/aac",
  aiff: "audio/aiff",
  avi: "video/x-msvideo",
  bmp: "image/bmp",
  csv: "text/csv",
  doc: "application/msword",
  docx:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  epub: "application/epub+zip",
  gif: "image/gif",
  gz: "application/x-gzip",
  heic: "image/heic",
  heif: "image/heif",
  html: "text/html",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  m4a: "audio/x-m4a",
  md: "text/markdown",
  midi: "audio/midi",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  pdf: "application/pdf",
  png: "image/png",
  ppt: "application/vnd.ms-powerpoint",
  pptx:
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  rtf: "text/rtf",
  tif: "image/tiff",
  tiff: "image/tiff",
  txt: "text/plain",
  vcf: "text/vcard",
  webp: "image/webp",
  xls: "application/vnd.ms-excel",
  xlsx:
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xml: "text/xml",
  zip: "application/zip",
};

export function contentTypeFor(
  filename: string,
  declared?: string,
): string {
  const normalized = declared?.split(";", 1)[0]?.trim().toLowerCase();
  const extension = filename.split(".").at(-1)?.toLowerCase();
  const contentType =
    normalized || (extension ? MIME_BY_EXTENSION[extension] : undefined);
  if (!contentType || !SUPPORTED_CONTENT_TYPES.has(contentType)) {
    throw new ValidationError(
      "relay",
      `Relay does not accept the content type for ${JSON.stringify(
        filename,
      )}; pass one of the content types in the v1 SupportedContentType contract`,
    );
  }
  return contentType;
}

export function postableText(message: AdapterPostableMessage): string {
  if (typeof message === "string") return message;
  const card = extractCard(message);
  if (card) {
    const explicit =
      "fallbackText" in message ? message.fallbackText : undefined;
    const rendered = explicit?.trim()
      ? explicit
      : cardToFallbackText(card, { lineBreak: "\n\n" });
    if (!rendered.trim()) {
      throw new ValidationError(
        "relay",
        "Relay has no interactive card surface; provide fallbackText",
      );
    }
    return markdownToPlainText(rendered);
  }
  if ("raw" in message) return message.raw;
  if ("markdown" in message) {
    return markdownToPlainText(message.markdown);
  }
  if ("ast" in message) return toPlainText(message.ast);
  throw new ValidationError(
    "relay",
    "Unsupported Chat SDK postable message shape",
  );
}

export function hasPostableContent(
  message: AdapterPostableMessage,
): boolean {
  return (
    postableText(message).length > 0 ||
    extractPostableAttachments(message).length > 0 ||
    extractFiles(message).length > 0
  );
}

export function textParts(value: string): RelayOutgoingPart[] {
  if (!value) return [];
  const result: RelayOutgoingPart[] = [];
  let offset = 0;
  while (offset < value.length) {
    let end = Math.min(
      offset + RELAY_MAX_TEXT_PART_LENGTH,
      value.length,
    );
    if (
      end < value.length &&
      /[\uD800-\uDBFF]/.test(value.charAt(end - 1))
    ) {
      end -= 1;
    }
    result.push({ type: "text", value: value.slice(offset, end) });
    offset = end;
  }
  return result;
}

async function bytesFrom(
  data: Blob | ArrayBuffer | Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  if (data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data.slice(0));
  }
  return new Uint8Array(
    data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    ) as ArrayBuffer,
  );
}

async function uploadPart(
  client: RelayClient,
  input: {
    data: Blob | ArrayBuffer | Uint8Array;
    filename: string;
    height?: number;
    mimeType?: string;
    width?: number;
  },
): Promise<RelayOutgoingPart> {
  const body = await bytesFrom(input.data);
  if (
    body.byteLength < 1 ||
    body.byteLength > RELAY_MAX_ATTACHMENT_BYTES
  ) {
    throw new ValidationError(
      "relay",
      `Relay attachments must contain 1–${RELAY_MAX_ATTACHMENT_BYTES} bytes`,
    );
  }
  if (!input.filename || input.filename.length > 255) {
    throw new ValidationError(
      "relay",
      "Relay attachment filenames must contain 1–255 characters",
    );
  }
  const allocation = await client.uploadAttachment({
    body,
    contentType: contentTypeFor(input.filename, input.mimeType),
    filename: input.filename,
    ...(input.height !== undefined ? { height: input.height } : {}),
    ...(input.width !== undefined ? { width: input.width } : {}),
  });
  return { attachment_id: allocation.attachment_id, type: "media" };
}

async function attachmentPart(
  client: RelayClient,
  attachment: Attachment,
): Promise<RelayOutgoingPart> {
  if (attachment.url?.startsWith("https://")) {
    return { type: "media", url: attachment.url };
  }
  const data = attachment.data ?? (await attachment.fetchData?.());
  if (!data) {
    throw new ValidationError(
      "relay",
      `Attachment ${JSON.stringify(
        attachment.name ?? "(unnamed)",
      )} needs a public HTTPS URL or bytes`,
    );
  }
  return uploadPart(client, {
    data,
    filename: attachment.name ?? "attachment",
    ...(attachment.height !== undefined
      ? { height: attachment.height }
      : {}),
    ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
    ...(attachment.width !== undefined ? { width: attachment.width } : {}),
  });
}

async function filePart(
  client: RelayClient,
  file: FileUpload,
): Promise<RelayOutgoingPart> {
  return uploadPart(client, {
    data: file.data,
    filename: file.filename,
    ...(file.mimeType ? { mimeType: file.mimeType } : {}),
  });
}

export async function buildRelayParts(
  client: RelayClient,
  message: AdapterPostableMessage,
): Promise<RelayOutgoingPart[]> {
  const parts = textParts(postableText(message));
  for (const attachment of extractPostableAttachments(message)) {
    parts.push(await attachmentPart(client, attachment));
  }
  for (const file of extractFiles(message)) {
    parts.push(await filePart(client, file));
  }
  if (parts.length > RELAY_MAX_MESSAGE_PARTS) {
    throw new ValidationError(
      "relay",
      `A Relay message supports at most ${RELAY_MAX_MESSAGE_PARTS} parts`,
    );
  }
  return parts;
}
