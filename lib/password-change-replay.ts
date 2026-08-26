import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

type EncryptedSessionToken = {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
};

function replayKey(previousSessionToken: string, requestId: string): Buffer {
  return createHash("sha256")
    .update("riff-sketchbook:password-change-replay:v1\0")
    .update(previousSessionToken)
    .update("\0")
    .update(requestId)
    .digest();
}

function replayAad(requestId: string): Buffer {
  return Buffer.from(`password-change:${requestId}`, "utf8");
}

export function encryptPasswordChangeSessionToken(
  sessionToken: string,
  previousSessionToken: string,
  requestId: string,
): EncryptedSessionToken {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    replayKey(previousSessionToken, requestId),
    iv,
  );
  cipher.setAAD(replayAad(requestId));
  const ciphertext = Buffer.concat([
    cipher.update(sessionToken, "utf8"),
    cipher.final(),
  ]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

export function decryptPasswordChangeSessionToken(
  encrypted: EncryptedSessionToken,
  previousSessionToken: string,
  requestId: string,
): string {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    replayKey(previousSessionToken, requestId),
    encrypted.iv,
  );
  decipher.setAAD(replayAad(requestId));
  decipher.setAuthTag(encrypted.tag);
  return Buffer.concat([
    decipher.update(encrypted.ciphertext),
    decipher.final(),
  ]).toString("utf8");
}
