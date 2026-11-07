import { ExecutionContext } from "@nestjs/common";
import { ROLES_KEY, Roles } from "./roles.decorator";
import { IS_PUBLIC_KEY, Public } from "./public.decorator";

describe("Decoradores transversales", () => {
  it("Roles decorator debe asociar metadata ROLES_KEY", () => {
    class TestClass {
      @Roles("admin", "conductor")
      testMethod() {}
    }

    const metadata = Reflect.getMetadata(
      ROLES_KEY,
      TestClass.prototype.testMethod,
    );
    expect(metadata).toEqual(["admin", "conductor"]);
  });

  it("Public decorator debe asociar metadata IS_PUBLIC_KEY", () => {
    class TestClass {
      @Public()
      testMethod() {}
    }

    const metadata = Reflect.getMetadata(
      IS_PUBLIC_KEY,
      TestClass.prototype.testMethod,
    );
    expect(metadata).toBe(true);
  });
});
