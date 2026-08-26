import { z } from "zod";

import {
  accountProfileSchema,
  displayNameSchema,
  passwordChangeSchema,
  passwordChangeRequestSchema,
  strongNewPasswordSchema,
  usernameSchema,
} from "@/lib/account-validation";
import {
  DEFAULT_ACCOUNT_DISPLAY_NAME,
  DEFAULT_ACCOUNT_USERNAME,
} from "@/lib/account-defaults";
import { cleanTagName, MAX_TAG_NAME_LENGTH } from "@/lib/tags";
import { ALBUM_COVER_PATHS } from "@/lib/album-covers";
import {
  cleanMarkerLabel,
  MARKER_COLORS,
  MAX_MARKER_LABEL_LENGTH,
  MAX_MARKER_POSITION_MS,
} from "@/lib/markers";
import {
  MAX_YOUTUBE_BACKING_NAME_LENGTH,
  MAX_YOUTUBE_BACKING_START_MS,
  parseYouTubeVideoId,
} from "@/lib/youtube-backing";

export {
  accountProfileSchema,
  displayNameSchema,
  passwordChangeSchema,
  passwordChangeRequestSchema,
  strongNewPasswordSchema,
  usernameSchema,
};

export const uuidSchema = z.string().uuid();

export const clientRecordingIdSchema = uuidSchema;

export const passwordSchema = z
  .string()
  .min(8, "비밀번호는 8자 이상이어야 해요.")
  .max(128, "비밀번호는 128자 이하여야 해요.");

export const setupSchema = z.object({
  username: usernameSchema.optional().default(DEFAULT_ACCOUNT_USERNAME),
  displayName: displayNameSchema.optional().default(DEFAULT_ACCOUNT_DISPLAY_NAME),
  password: passwordSchema,
  remember: z.boolean().optional().default(true),
});

export const loginSchema = z.object({
  password: z.string().min(1).max(128),
  remember: z.boolean().optional().default(true),
});

export const albumCoverAssetSchema = z.enum(ALBUM_COVER_PATHS).nullable();

export const albumCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional().default(""),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional()
    .default("#D9D2C3"),
  coverAsset: albumCoverAssetSchema.optional().default(null),
  requestId: uuidSchema.optional(),
}).strict();

const albumUpdateShape = {
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  coverAsset: albumCoverAssetSchema.optional(),
};

function hasAlbumUpdate(value: {
  name?: string;
  description?: string;
  color?: string;
  coverAsset?: (typeof ALBUM_COVER_PATHS)[number] | null;
}): boolean {
  return [value.name, value.description, value.color, value.coverAsset].some(
    (item) => item !== undefined,
  );
}

export const albumUpdateSchema = z
  .object(albumUpdateShape)
  .strict()
  .refine(hasAlbumUpdate, {
    message: "변경할 내용을 입력해주세요.",
  });

export const revisionedAlbumUpdateSchema = z
  .object({
    ...albumUpdateShape,
    expectedRevision: z.number().int().min(0),
  })
  .strict()
  .refine(hasAlbumUpdate, {
    message: "변경할 내용을 입력해주세요.",
  });

export const tagNameSchema = z
  .string()
  .transform(cleanTagName)
  .pipe(
    z
      .string()
      .min(1, "태그 이름을 입력해주세요.")
      .max(MAX_TAG_NAME_LENGTH, `태그는 ${MAX_TAG_NAME_LENGTH}자 이하여야 해요.`)
      .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
        message: "태그에 제어 문자를 사용할 수 없어요.",
      }),
  );

export const tagCreateSchema = z.object({
  name: tagNameSchema,
});

export const librarySearchSchema = z.string().trim().max(120);

export const riffCreateSchema = z.object({
  albumId: uuidSchema.nullable().optional().default(null),
  title: z.string().trim().min(1).max(120),
  bpm: z.coerce.number().int().min(30).max(300).optional().default(120),
  musicalKey: z.string().trim().max(20).optional().default("E minor"),
  tuning: z.string().trim().max(40).optional().default("E A D G B E"),
  timeSignature: z.string().trim().max(12).optional().default("4/4"),
  notes: z.string().max(20_000).optional().default(""),
  tab: z.string().max(100_000).optional().default(""),
  requestId: uuidSchema.optional(),
}).strict();

export const riffUpdateSchema = z.object({
  albumId: uuidSchema.nullable().optional(),
  title: z.string().trim().min(1).max(120).optional(),
  bpm: z.coerce.number().int().min(30).max(300).optional(),
  musicalKey: z.string().trim().max(20).optional(),
  tuning: z.string().trim().max(40).optional(),
  timeSignature: z.string().trim().max(12).optional(),
  notes: z.string().max(20_000).optional(),
  tab: z.string().max(100_000).optional(),
  isFavorite: z.boolean().optional(),
  trashed: z.boolean().optional(),
});

export const riffDuplicateSchema = z
  .object({
    requestId: uuidSchema.optional(),
  })
  .strict();

export const takeDuplicateSchema = z
  .object({
    requestId: uuidSchema,
  })
  .strict();

export const takeUpdateSchema = z
  .object({
    isPrimary: z.literal(true).optional(),
    name: z.string().trim().min(1).max(120).optional(),
    trimStartMs: z.number().int().min(0).max(86_400_000).optional(),
    trimEndMs: z
      .number()
      .int()
      .positive()
      .max(86_400_000)
      .nullable()
      .optional(),
    offsetMs: z.number().int().min(0).max(86_400_000).optional(),
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: "변경할 내용을 입력해주세요.",
  });

export const trackUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    offsetMs: z.number().int().min(0).max(86_400_000).optional(),
    volume: z.number().min(0).max(2).optional(),
    pan: z.number().min(-1).max(1).optional(),
    muted: z.boolean().optional(),
    solo: z.boolean().optional(),
    fadeInMs: z.number().int().min(0).max(3_600_000).optional(),
    fadeOutMs: z.number().int().min(0).max(3_600_000).optional(),
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: "변경할 내용을 입력해주세요.",
  });

export const youtubeBackingPutSchema = z
  .object({
    url: z
      .string()
      .trim()
      .min(1, "YouTube 링크를 입력해주세요.")
      .max(2_048)
      .refine((value) => parseYouTubeVideoId(value) !== null, {
        message: "올바른 YouTube 영상 링크를 입력해주세요.",
      }),
    name: z
      .string()
      .trim()
      .min(1)
      .max(MAX_YOUTUBE_BACKING_NAME_LENGTH)
      .optional()
      .default("YouTube 참고 트랙"),
    sourceStartMs: z
      .number()
      .int()
      .min(0)
      .max(MAX_YOUTUBE_BACKING_START_MS)
      .optional()
      .default(0),
    volume: z.number().min(0).max(1).optional().default(1),
    syncEnabled: z.boolean().optional().default(false),
    expectedRevision: z.number().int().min(0).nullable(),
  })
  .strict();

export const youtubeBackingDeleteSchema = z
  .object({ expectedRevision: z.number().int().min(0) })
  .strict();

export const compPutSchema = z.object({
  expectedRevision: z.number().int().min(0),
  segments: z
    .array(
      z
        .object({
          takeId: uuidSchema,
          startMs: z.number().int().min(0).max(86_400_000),
          endMs: z.number().int().positive().max(86_400_000),
        })
        .refine((value) => value.endMs > value.startMs, {
          message: "구간의 끝은 시작보다 뒤여야 해요.",
        }),
    )
    .max(500),
});

export const markerLabelSchema = z
  .string()
  .transform(cleanMarkerLabel)
  .pipe(
    z
      .string()
      .min(1, "마커 이름을 입력해주세요.")
      .max(
        MAX_MARKER_LABEL_LENGTH,
        `마커 이름은 ${MAX_MARKER_LABEL_LENGTH}자 이하여야 해요.`,
      )
      .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
        message: "마커 이름에 제어 문자를 사용할 수 없어요.",
      }),
  );

export const markerCreateSchema = z
  .object({
    requestId: uuidSchema,
    positionMs: z.number().int().min(0).max(MAX_MARKER_POSITION_MS),
    label: markerLabelSchema,
    color: z.enum(MARKER_COLORS).optional().default("rose"),
  })
  .strict();

export const markerUpdateSchema = z
  .object({
    revision: z.number().int().min(0),
    positionMs: z.number().int().min(0).max(MAX_MARKER_POSITION_MS).optional(),
    label: markerLabelSchema.optional(),
    color: z.enum(MARKER_COLORS).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.positionMs !== undefined ||
      value.label !== undefined ||
      value.color !== undefined,
    { message: "변경할 마커 내용을 입력해주세요." },
  );

export const markerDeleteSchema = z
  .object({
    revision: z.number().int().min(0),
  })
  .strict();
