const crypto = require("crypto");

function encryptionKey() {
  const secret = process.env.CREDENTIALS_ENCRYPTION_KEY || process.env.SESSION_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") throw new Error("CREDENTIALS_ENCRYPTION_KEY is required in production.");
    return crypto.createHash("sha256").update("tmcast-local-development-only").digest();
  }
  return crypto.createHash("sha256").update(secret).digest();
}

function encrypt(value) {
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
}

function decrypt(payload) {
  if (!payload) return "";
  const [iv, tag, encrypted] = payload.split(".").map(value => Buffer.from(value, "base64"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

module.exports = { encrypt, decrypt };
