import { z } from "zod";

export const usernameSchema = z
  .string()
  .trim()
  .min(1, "사용자 이름을 입력해주세요.")
  .max(40, "사용자 이름은 40자 이하여야 해요.")
  .regex(
    /^[\p{L}\p{N}](?:[\p{L}\p{N}._-]{0,38}[\p{L}\p{N}])?$/u,
    "사용자 이름은 글자나 숫자로 시작하고 끝나야 하며 . _ - 만 사용할 수 있어요.",
  );

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, "표시 이름을 입력해주세요.")
  .max(40, "표시 이름은 40자 이하여야 해요.")
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), {
    message: "표시 이름에 제어 문자를 사용할 수 없어요.",
  });

export const accountProfileSchema = z
  .object({
    username: usernameSchema,
    displayName: displayNameSchema,
    expectedRevision: z.number().int().min(0),
  })
  .strict();

export const strongNewPasswordSchema = z
  .string()
  .min(12, "새 비밀번호는 12자 이상이어야 해요.")
  .max(128, "새 비밀번호는 128자 이하여야 해요.")
  .refine((value) => /\p{L}/u.test(value), {
    message: "새 비밀번호에 글자를 하나 이상 넣어주세요.",
  })
  .refine((value) => /\p{N}/u.test(value), {
    message: "새 비밀번호에 숫자를 하나 이상 넣어주세요.",
  })
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), {
    message: "새 비밀번호에 제어 문자를 사용할 수 없어요.",
  });

const passwordChangeShape = {
  currentPassword: z.string().min(1).max(128),
  newPassword: strongNewPasswordSchema,
  confirmPassword: z.string().min(1).max(128),
};

function validatePasswordChange(
  value: z.infer<z.ZodObject<typeof passwordChangeShape>>,
  context: z.RefinementCtx,
) {
  if (value.newPassword !== value.confirmPassword) {
    context.addIssue({
      code: "custom",
      path: ["confirmPassword"],
      message: "새 비밀번호가 서로 일치하지 않아요.",
    });
  }
  if (value.currentPassword === value.newPassword) {
    context.addIssue({
      code: "custom",
      path: ["newPassword"],
      message: "현재 비밀번호와 다른 비밀번호를 사용해주세요.",
    });
  }
}

export const passwordChangeSchema = z
  .object(passwordChangeShape)
  .strict()
  .superRefine(validatePasswordChange);

export const passwordChangeRequestSchema = z
  .object({
    ...passwordChangeShape,
    requestId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine(validatePasswordChange);
