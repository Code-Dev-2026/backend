import {
  base32Decode,
  base32Encode,
  generateTotp,
  hotp,
  verifyTotp,
} from "./totp";

describe("TOTP (RFC 6238)", () => {
  // Secreto de prueba del RFC 6238 (SHA-1): "12345678901234567890"
  const rfcSecret = Buffer.from("12345678901234567890", "ascii");

  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ])(
    "debe coincidir con el vector oficial del RFC en t=%i",
    (seconds, code) => {
      expect(generateTotp(rfcSecret, seconds * 1000)).toBe(code);
    },
  );

  it("debe coincidir con los vectores HOTP del RFC 4226", () => {
    expect(hotp(rfcSecret, 0)).toBe("755224");
    expect(hotp(rfcSecret, 1)).toBe("287082");
    expect(hotp(rfcSecret, 9)).toBe("520489");
  });

  it("debe aceptar el código del paso actual y de los pasos adyacentes", () => {
    const now = 1_700_000_000_000;
    const code = generateTotp(rfcSecret, now);

    expect(verifyTotp(rfcSecret, code, now)).not.toBeNull();
    expect(verifyTotp(rfcSecret, code, now + 30_000)).not.toBeNull();
    expect(verifyTotp(rfcSecret, code, now - 30_000)).not.toBeNull();
  });

  it("debe rechazar códigos fuera de la ventana de ±1 paso", () => {
    const now = 1_700_000_000_000;
    const code = generateTotp(rfcSecret, now);

    expect(verifyTotp(rfcSecret, code, now + 90_000)).toBeNull();
    expect(verifyTotp(rfcSecret, code, now - 90_000)).toBeNull();
  });

  it("debe rechazar formatos que no sean 6 dígitos", () => {
    expect(verifyTotp(rfcSecret, "12345")).toBeNull();
    expect(verifyTotp(rfcSecret, "1234567")).toBeNull();
    expect(verifyTotp(rfcSecret, "abcdef")).toBeNull();
  });

  it("debe codificar y decodificar Base32 sin pérdida", () => {
    const encoded = base32Encode(rfcSecret);

    expect(encoded).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode(encoded).equals(rfcSecret)).toBe(true);
  });

  it("debe rechazar caracteres inválidos en Base32", () => {
    expect(() => base32Decode("!!!")).toThrow();
  });
});
