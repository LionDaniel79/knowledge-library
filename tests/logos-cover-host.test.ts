import { expect, it } from "vitest";
import { downloadCover } from "../src/server/cover-download";

it("accepts the Logos cover CDN on HTTPS, but never on HTTP", async () => {
  const expected = Buffer.from("test-image");
  const actual = await downloadCover(
    "https://covers.logoscdn.com/lls_example/cover.jpg",
    async (url) => {
      expect(new URL(String(url)).hostname).toBe("covers.logoscdn.com");
      return new Response(new Uint8Array(expected), {
        headers: { "Content-Type": "image/jpeg" },
      });
    },
  );
  expect(actual).toEqual(expected);
  await expect(
    downloadCover("http://covers.logoscdn.com/lls_example/cover.jpg", async () => {
      throw new Error("unsafe fetch");
    }),
  ).rejects.toMatchObject({ status: 400 });
});
