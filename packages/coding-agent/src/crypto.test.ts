// @jawere/coding-agent — Tests for crypto.ts (encrypt/decrypt)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encrypt, decrypt } from "./crypto.ts";

describe("crypto", () => {
  describe("encrypt + decrypt roundtrip", () => {
    it("roundtrips a simple string", async () => {
      const original = "hello world";
      const encrypted = await encrypt(original);
      const decrypted = await decrypt(encrypted);

      assert.equal(decrypted, original);
      // Encrypted should be different from original
      assert.notEqual(encrypted, original);
    });

    it("roundtrips an API key", async () => {
      const key = "sk-ant-api03-xxxxxxxxxxxx-xxxxxxxxxxxx-xxxxxxxxxxxx";
      const encrypted = await encrypt(key);
      const decrypted = await decrypt(encrypted);

      assert.equal(decrypted, key);
    });

    it("roundtrips empty string", async () => {
      const encrypted = await encrypt("");
      const decrypted = await decrypt(encrypted);
      assert.equal(decrypted, "");
    });

    it("roundtrips unicode text", async () => {
      const original = "🔑 secret-key-日本語-árvíztűrő";
      const encrypted = await encrypt(original);
      const decrypted = await decrypt(encrypted);

      assert.equal(decrypted, original);
    });

    it("roundtrips multi-line text", async () => {
      const original = "line1\nline2\nline3\n";
      const encrypted = await encrypt(original);
      const decrypted = await decrypt(encrypted);

      assert.equal(decrypted, original);
    });

    it("produces different ciphertexts for same plaintext", async () => {
      const plaintext = "same text";
      const c1 = await encrypt(plaintext);
      const c2 = await encrypt(plaintext);

      // Different IV each time → different ciphertext
      assert.notEqual(c1, c2);

      // But both decrypt to same value
      assert.equal(await decrypt(c1), plaintext);
      assert.equal(await decrypt(c2), plaintext);
    });
  });

  describe("decrypt", () => {
    it("returns null for invalid base64", async () => {
      const result = await decrypt("not-valid-base64!!!");
      assert.equal(result, null);
    });

    it("returns null for corrupted ciphertext", async () => {
      const encrypted = await encrypt("secret");
      // Corrupt the middle of the ciphertext
      const buf = Buffer.from(encrypted, "base64");
      if (buf.length > 20) buf[20] ^= 0xff;
      const corrupted = buf.toString("base64");

      const result = await decrypt(corrupted);
      assert.equal(result, null);
    });

    it("returns null for tampered ciphertext", async () => {
      const encrypted = await encrypt("secret");
      // Flip first byte (in IV)
      const buf = Buffer.from(encrypted, "base64");
      buf[0] ^= 0xff;
      const tampered = buf.toString("base64");

      const result = await decrypt(tampered);
      assert.equal(result, null);
    });

    it("returns null for empty string", async () => {
      const result = await decrypt("");
      assert.equal(result, null);
    });
  });
});
