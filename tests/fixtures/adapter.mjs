export function createAdapter() {
  return {
    async call(operation, args, signal) {
      if (operation === "fail") throw new Error("fixture failure");
      if (operation === "businessFail")
        return {
          isError: true,
          content: [{ type: "text", text: "Backend rejected operation" }],
        };
      if (operation === "wait")
        return new Promise((_, reject) =>
          signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        );
      return { operation, ...args };
    },
  };
}
