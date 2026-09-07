'use strict';

/*
 * Encryption at rest for the Copado AI credentials.
 *
 * What this is worth, plainly: the extension has to decrypt unattended to make
 * a call, so the key lives in the same storage as the ciphertext. Anyone who can
 * read that storage can read the extension's source too, and therefore the key.
 * This stops a casual look through the browser profile — a grep for something
 * that looks like an API key — and it stops nothing determined.
 *
 * It is here because the alternative was plaintext, not because it is a vault.
 * Real protection needs a secret the extension cannot reach on its own, which
 * means asking the user for one on every browser session; that was built and
 * removed as more friction than it was worth for this tool.
 *
 * AES-GCM with a 96-bit random IV per value. WebCrypto throughout, nothing
 * hand-rolled, no dependencies.
 */

const SecretStore = (() => {

  const IV_BYTES = 12;
  const INSTALL_KEY = 'secretInstallKey';

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const toB64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
  const fromB64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

  // Generated once per install and kept beside what it protects, which is
  // exactly why the comment above does not call this secure.
  let cached = null;

  async function installKey() {
    if (cached) return cached;

    const stored = await chrome.storage.local.get(INSTALL_KEY);
    let raw = stored[INSTALL_KEY];

    if (!raw) {
      raw = toB64(randomBytes(32));
      await chrome.storage.local.set({ [INSTALL_KEY]: raw });
    }

    cached = await crypto.subtle.importKey(
      'raw', fromB64(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']
    );
    return cached;
  }

  /*
   * One envelope per value, carrying the IV it was encrypted under. A fresh IV
   * every time, so storing the same key twice does not produce the same bytes.
   */
  async function seal(plaintext) {
    const key = await installKey();
    const iv = randomBytes(IV_BYTES);

    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, key, enc.encode(plaintext)
    );

    return { v: 1, iv: toB64(iv), data: toB64(ciphertext) };
  }

  /*
   * Returns null rather than throwing when a value cannot be opened. AES-GCM
   * authenticates as it decrypts, so tampered or truncated storage fails
   * outright instead of yielding plausible rubbish.
   */
  async function open(envelope) {
    if (!envelope?.data) return null;

    try {
      const key = await installKey();
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromB64(envelope.iv) }, key, fromB64(envelope.data)
      );
      return dec.decode(plaintext);
    } catch {
      return null;
    }
  }

  // A value written by a build from before any of this existed.
  const isPlaintext = (value) => typeof value === 'string';

  /* ------------------------------------------------- the reveal password */

  /*
   * A password that guards showing the credentials on screen — and nothing more.
   *
   * The password itself is never stored. What is stored is a verifier: a random
   * salt and the PBKDF2 output of the password stretched with it. That is enough
   * to answer "is this the right password" and not enough to produce the
   * password, so there is nothing here to steal and nothing to recover if it is
   * forgotten. Removing the guard is the only way back, which is why removing it
   * is offered without knowing the old one.
   *
   * What this is: a guard against a shoulder, a screen share, a screenshot.
   *
   * What this is not: a security boundary. The extension has to hold these
   * credentials in the clear to make a call, so anyone at this machine's devtools
   * can read them whatever this says. Gating the pixels is worth doing; pretending
   * it gates the data would not be.
   */
  const VERIFY_ITERATIONS = 600000;

  async function derive(password, salt) {
    const material = await crypto.subtle.importKey(
      'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
    );

    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: VERIFY_ITERATIONS, hash: 'SHA-256' },
      material,
      256
    );
    return new Uint8Array(bits);
  }

  async function makeVerifier(password) {
    const salt = randomBytes(16);
    return {
      v: 1,
      salt: toB64(salt),
      hash: toB64(await derive(password, salt)),
    };
  }

  async function checkVerifier(password, verifier) {
    if (!verifier?.salt || !verifier?.hash) return false;

    const got = await derive(password, fromB64(verifier.salt));
    const want = fromB64(verifier.hash);
    if (got.length !== want.length) return false;

    // Compared in full rather than short-circuiting. The timing of a local
    // prompt gives nothing away, but a comparison that leaks its progress is
    // not worth writing even where it does not matter.
    let diff = 0;
    for (let i = 0; i < got.length; i += 1) diff |= got[i] ^ want[i];
    return diff === 0;
  }

  return { seal, open, isPlaintext, makeVerifier, checkVerifier };
})();
