import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const LOGIN_JS = new URL("../public/login.js", import.meta.url);
const REQUEST_ID = "7f0c1c62-3f7a-4d3c-9d55-0f3b8f0d6a11";

interface FakeElement {
  hidden: boolean;
  textContent: string;
  value: string;
  src: string;
  href: string;
  open: boolean;
  isError: boolean;
  classList: { toggle: (name: string, on: boolean) => void };
  addEventListener: (type: string, listener: (event: { preventDefault: () => void }) => void) => void;
  querySelector: (selector: string) => FakeElement;
  select: () => void;
  focus: () => void;
}

const fakeElement = (): FakeElement => {
  const details = { open: false } as FakeElement;
  const el: FakeElement = {
    hidden: true,
    textContent: "",
    value: "",
    src: "",
    href: "",
    open: false,
    isError: false,
    classList: {
      toggle: (name, on) => {
        if (name === "error") el.isError = on;
      },
    },
    addEventListener: () => {},
    querySelector: () => details,
    select: () => {},
    focus: () => {},
  };
  return el;
};

// Runs the real sign-in page script against a fake DOM, a fake server and a fake World App whose
// scan ends with `worldError`.
const runSignInPage = async (worldError: string) => {
  const elements = new Map<string, FakeElement>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, fakeElement());
    return elements.get(id)!;
  };
  const json = (body: unknown) => ({ ok: true, json: async () => body });
  const fetch = vi.fn(async (url: string) => {
    if (url.startsWith("/login/context")) {
      return json({ client_name: "Claude Code", redirect_host: "localhost:1", app_id: "app_x", environment: "sandbox", credentials: ["selfie"], invite_code: false, returning: false });
    }
    if (url === "/login/rp-context") return json({ rp_context: {}, action: "truth-skills-account-v1" });
    throw new Error(`unexpected fetch ${url}`);
  });
  const request = {
    connectorURI: "https://world.example/connect",
    pollUntilCompletion: async () => ({ success: false, error: worldError }),
  };
  const IDKit = {
    request: () => ({ constraints: async () => request }),
    any: () => ({}),
    CredentialRequest: () => ({}),
  };
  const qrcode = () => ({ addData: () => {}, make: () => {}, createDataURL: () => "data:," });
  const context = createContext({
    document: { getElementById: element },
    location: { search: `?req=${REQUEST_ID}`, assign: vi.fn() },
    URLSearchParams,
    DOMException,
    AbortController,
    fetch,
    IDKit,
    window: { IDKit, qrcode },
    navigator: {},
    console,
  });
  runInContext(await readFile(LOGIN_JS, "utf8"), context);
  await vi.waitFor(() => expect(element("status").isError).toBe(true)); // the scan has failed and the page has reacted
  return element;
};

describe("sign-in page", () => {
  it("sends a human who already has an account to the recovery link", async () => {
    const element = await runSignInPage("nullifier_replayed");

    expect(element("status").textContent).toMatch(/already have a Truth-Skills account/);
    expect(element("recovery-form").hidden).toBe(false);
    expect(element("recovery-form").querySelector("details").open).toBe(true);
    expect(element("retry").hidden).toBe(true); // scanning again would fail the same way
  });

  it("offers to try again after any other World App error", async () => {
    const element = await runSignInPage("user_rejected");

    expect(element("status").textContent).toBe("World App did not complete the request (user_rejected).");
    expect(element("retry").hidden).toBe(false);
  });
});
