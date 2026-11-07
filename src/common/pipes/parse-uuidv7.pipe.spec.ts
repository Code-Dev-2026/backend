import { BadRequestException } from "@nestjs/common";
import { ParseUUIDv7Pipe } from "./parse-uuidv7.pipe";

describe("ParseUUIDv7Pipe", () => {
  let pipe: ParseUUIDv7Pipe;

  beforeEach(() => {
    pipe = new ParseUUIDv7Pipe();
  });

  it("debe aceptar un UUID válido", () => {
    const validUuid = "018e38d9-3f00-7200-a000-000000000001";
    expect(pipe.transform(validUuid)).toBe(validUuid);
  });

  it("debe arrojar BadRequestException con UUID inválido", () => {
    expect(() => pipe.transform("invalid-uuid")).toThrow(BadRequestException);
    expect(() => pipe.transform("")).toThrow(BadRequestException);
  });
});
