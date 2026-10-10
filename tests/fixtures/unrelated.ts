import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** An unrelated extension: it only uses Pi's own command surface. */
export default function (pi: ExtensionAPI) {
  pi.registerCommand("notes-length", {
    description: "Count characters",
    handler: async (args, ctx) => {
      ctx.ui.notify(`length:${args.length}`);
    },
  });
}
